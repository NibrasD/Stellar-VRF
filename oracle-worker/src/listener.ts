/**
 * listener.ts — Soroban contract event listener
 *
 * Polls the Soroban RPC for "request" events emitted by the VRF contract.
 * Maintains a cursor to only process new events on each poll.
 */

import { rpc, xdr, Address, scValToNative, nativeToScVal, TransactionBuilder, Operation } from "@stellar/stellar-sdk";
import {
  SOROBAN_RPC_URL,
  CONTRACT_ADDRESS,
  POLL_INTERVAL_MS,
  ORACLE_PUBLIC_KEY,
  NETWORK_PASSPHRASE,
} from "./config.js";
import { log, sleep } from "./utils.js";
import { recordListenerHeartbeat } from "./metrics.js";
import type { OnChainConfig } from "./configCheck.js";

export interface VrfRequestEvent {
  requestId: bigint;
  requester: string;
  requiredRound: bigint;
  ledger: number;
}

export interface PendingRequest {
  requestId: bigint;
  requiredRound: bigint;
}

/**
 * The listener loop gives up (throws) after this many consecutive failed polls
 * so the supervisor can restart it with a fresh RPC client and cursor — and,
 * if restarts do not help, hand leadership to the standby. Previously every
 * poll error was swallowed, so a dead RPC produced a leader that looked alive
 * but never saw another event.
 */
const MAX_CONSECUTIVE_POLL_FAILURES = parseInt(
  process.env.LISTENER_MAX_POLL_FAILURES || "20",
  10
);

/** getLedgerEntries accepts at most 200 keys; 3 keys per request ID. */
const RECONCILE_BATCH_IDS = 50;

// Persistent cursor for event pagination
let lastCursor: string | undefined;
let lastLedger: number | undefined;

/** Polls that threw since the last successful one. */
let consecutivePollFailures = 0;

/**
 * Create a Soroban RPC server instance.
 */
export function createServer(): rpc.Server {
  return new rpc.Server(SOROBAN_RPC_URL, { allowHttp: false });
}

/**
 * Initialize the listener by fetching the current ledger as starting point.
 */
export async function initListener(server: rpc.Server): Promise<void> {
  const health = await server.getHealth();
  // Look back as far as the RPC retention window allows, not a fixed ~100
  // ledgers (~8 min). The cursor is in-memory only, so after a restart the
  // event window is the ONLY way to rediscover work; an outage longer than the
  // look-back would otherwise silently drop requests, leaving them unfulfilled
  // until the requester claims timeout_refund(). Reconciliation below covers
  // anything older still.
  const lookback = parseInt(process.env.STARTUP_LOOKBACK_LEDGERS || "17280", 10); // ~24h
  lastLedger = clampToRetention(health.latestLedger - lookback, health);
  lastCursor = undefined;
  log.info(
    `Listener initialized. Starting from ledger ${lastLedger} ` +
      `(head ${health.latestLedger}, lookback ${lookback})`
  );
}

/**
 * Read the contract's request counter (`DataKey::Counter`, instance storage).
 *
 * Request IDs are assigned sequentially as `Counter + 1`, so the counter is
 * the highest ID ever issued. This is what lets reconciliation look at the
 * NEWEST requests instead of guessing where the ID range ends.
 */
export async function readRequestCounter(server: rpc.Server): Promise<bigint> {
  // Counter is initialised by the contract's __constructor at deploy time.
  return (await readInstanceInteger(server, "Counter")) ?? 0n;
}

/**
 * Read the contract's per-request fee (`DataKey::FeeAmount`, instance storage).
 * Immutable after construction; `2,000,000` stroops (0.2 XLM) on the live Mainnet instance.
 */
export async function readFeeAmount(server: rpc.Server): Promise<bigint> {
  return (await readInstanceInteger(server, "FeeAmount")) ?? 0n;
}

/**
 * Read the contract's fee token (`DataKey::FeeToken`, a SAC contract ID).
 * `FeeAmount` is in this token's smallest unit, which is only stroops when the
 * token is the native XLM SAC.
 */
export async function readFeeToken(server: rpc.Server): Promise<string> {
  const v = await readInstanceValue(server, "FeeToken");
  if (!v) throw new Error("FeeToken not found in contract instance storage");
  return Address.fromScVal(v).toString();
}

/** Read an integer-valued unit `DataKey` variant from contract instance storage. */
async function readInstanceInteger(server: rpc.Server, name: string): Promise<bigint | null> {
  const v = await readInstanceValue(server, name);
  return v ? BigInt(scValToNative(v) as bigint | number | string) : null;
}

/** Raw value of a unit `DataKey` variant in contract instance storage. */
async function readInstanceValue(server: rpc.Server, name: string): Promise<xdr.ScVal | null> {
  const entry = await server.getContractData(
    CONTRACT_ADDRESS,
    xdr.ScVal.scvLedgerKeyContractInstance(),
    rpc.Durability.Persistent
  );
  const val = (entry.val as any).contractData.val;
  const storage: Array<{ key: xdr.ScVal; val: xdr.ScVal }> = val.instance.storage ?? [];
  for (const item of storage) {
    const key = scValToNative(item.key);
    if (Array.isArray(key) && key.length === 1 && key[0] === name) {
      return item.val;
    }
  }
  return null;
}

/**
 * Chain-authoritative configuration from contract instance storage, for
 * configCheck.ts. One RPC round-trip.
 */
export async function readChainConfig(server: rpc.Server): Promise<OnChainConfig> {
  const entry = await server.getContractData(
    CONTRACT_ADDRESS,
    xdr.ScVal.scvLedgerKeyContractInstance(),
    rpc.Durability.Persistent
  );
  const val = (entry.val as any).contractData.val;
  const storage: Array<{ key: xdr.ScVal; val: xdr.ScVal }> = val.instance.storage ?? [];
  const byName = new Map<string, xdr.ScVal>();
  for (const item of storage) {
    const key = scValToNative(item.key);
    if (Array.isArray(key) && key.length === 1 && typeof key[0] === "string") byName.set(key[0], item.val);
  }
  const need = (name: string): xdr.ScVal => {
    const v = byName.get(name);
    if (!v) throw new Error(`${name} not found in contract instance storage`);
    return v;
  };
  return {
    drandGenesis: BigInt(scValToNative(need("DrandGenesis")) as bigint | number),
    drandPeriod: BigInt(scValToNative(need("DrandPeriod")) as bigint | number),
    drandPk: new Uint8Array(scValToNative(need("DrandPK")) as Buffer),
    oraclePk: new Uint8Array(scValToNative(need("OraclePK")) as Buffer),
    oracleAddress: Address.fromScVal(need("OracleAddr")).toString(),
  };
}

/** Requester address of a request (`DataKey::Requester(id)`), or null if absent. */
export async function readRequester(server: rpc.Server, id: bigint): Promise<string | null> {
  const res = await server.getLedgerEntries(requestEntryKey("Requester", id));
  const entry = res.entries[0];
  if (!entry) return null;
  return Address.fromScVal((entry.val as any).contractData.val).toString();
}

/** Native XLM balance of the oracle account, in stroops. */
export async function readOracleBalance(server: rpc.Server): Promise<bigint> {
  const account = await server.getAccountEntry(ORACLE_PUBLIC_KEY);
  return BigInt(account.balance); // stellar-sdk v17: `balance` is an int64 bigint (stroops)
}

/** Ledger key for a per-request persistent entry, e.g. `Fulfilled(id)`. */
function requestEntryKey(name: string, id: bigint): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(CONTRACT_ADDRESS).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name), xdr.ScVal.scvU64(id)]),
      durability: xdr.ContractDataDurability.persistent,
    })
  );
}

/**
 * Reconcile against contract STATE rather than events.
 *
 * Events alone cannot guarantee delivery: the cursor is in-memory, and the RPC
 * only retains a finite event window. After an outage longer than that window,
 * a request whose `request` event has aged out would never be seen again.
 *
 * How it works:
 *   1. Read `Counter` — the highest request ID issued.
 *   2. Walk IDs from the newest downwards (bounded by `maxScan`), reading
 *      `Fulfilled`, `Refunded` and `RequestRound` for each directly from ledger
 *      storage via batched `getLedgerEntries` — one RPC call per 50 IDs, no
 *      simulations, no oracle account lookup.
 *   3. A request is pending iff `Fulfilled == false` and `Refunded != true`.
 *
 * Entries that no longer exist (TTL-expired / archived) are skipped: `fulfill()`
 * could not succeed on them anyway.
 *
 * Returned oldest-first so the requests closest to their timeout are served
 * first.
 *
 * The previous implementation scanned IDs 1..200 upwards and stopped at the
 * first gap, which silently stopped finding new requests once the contract had
 * issued more than 200 IDs.
 */
export async function findPendingRequests(
  server: rpc.Server,
  maxScan = parseInt(process.env.RECONCILE_MAX_SCAN || "1000", 10)
): Promise<PendingRequest[]> {
  const counter = await readRequestCounter(server);
  const pending: PendingRequest[] = [];
  if (counter === 0n) {
    recordListenerHeartbeat();
    log.info("Reconciliation: contract has issued no requests yet.");
    return pending;
  }

  const window = BigInt(Math.max(1, maxScan));
  const lowest = counter - window + 1n;
  const floor = lowest > 1n ? lowest : 1n;

  await scanIdRange(server, floor, counter, pending);

  // Older IDs: sweep one more window per pass with a cursor that walks down to
  // 1 and then wraps. The newest window is checked every pass; every older ID
  // is checked at least once every ceil((floor-1)/maxScan) passes, so after a
  // long outage with heavy traffic nothing stays undiscovered forever.
  let sweep: { lo: bigint; hi: bigint } | null = null;
  if (floor > 1n) {
    let hi = olderSweepCursor !== null && olderSweepCursor < floor ? olderSweepCursor : floor - 1n;
    if (hi < 1n) hi = floor - 1n;
    const lo = hi - window + 1n > 1n ? hi - window + 1n : 1n;
    await scanIdRange(server, lo, hi, pending);
    olderSweepCursor = lo > 1n ? lo - 1n : null; // null → wrap to the top next pass
    sweep = { lo, hi };
  } else {
    olderSweepCursor = null;
  }

  pending.sort((a, b) => (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0));
  recordListenerHeartbeat();

  const scanned = `${floor}..${counter}` + (sweep ? ` + older ${sweep.lo}..${sweep.hi}` : "");
  if (pending.length) {
    log.warn(
      `Reconciliation found ${pending.length} unfulfilled request(s) ` +
        `(scanned ${scanned}): ` +
        pending.map((p) => String(p.requestId)).join(", ")
    );
  } else {
    log.info(`Reconciliation: no outstanding requests (scanned ${scanned}).`);
  }
  return pending;
}

/**
 * Position of the rolling sweep over IDs older than the newest window.
 * In-memory: after a restart the sweep restarts from the top, which only
 * re-checks IDs (idempotent), never skips them.
 */
let olderSweepCursor: bigint | null = null;

/** Test hook: reset the older-ID sweep. */
export function resetReconcileSweep(): void {
  olderSweepCursor = null;
}

async function scanIdRange(
  server: rpc.Server,
  floor: bigint,
  top: bigint,
  pending: PendingRequest[]
): Promise<void> {
  for (let hi = top; hi >= floor; hi -= BigInt(RECONCILE_BATCH_IDS)) {
    const ids: bigint[] = [];
    for (let id = hi; id >= floor && id > hi - BigInt(RECONCILE_BATCH_IDS); id--) {
      ids.push(id);
    }

    const keys = ids.flatMap((id) => [
      requestEntryKey("Fulfilled", id),
      requestEntryKey("Refunded", id),
      requestEntryKey("RequestRound", id),
    ]);
    const res = await server.getLedgerEntries(...keys);

    const fulfilled = new Map<bigint, boolean>();
    const refunded = new Map<bigint, boolean>();
    const rounds = new Map<bigint, bigint>();
    for (const entry of res.entries) {
      const data = (entry.val as any).contractData;
      const key = scValToNative(data.key);
      if (!Array.isArray(key) || key.length !== 2) continue;
      const [name, rawId] = key;
      const id = BigInt(rawId);
      const value = scValToNative(data.val);
      if (name === "Fulfilled") fulfilled.set(id, value === true);
      else if (name === "Refunded") refunded.set(id, value === true);
      else if (name === "RequestRound") rounds.set(id, BigInt(value));
    }

    for (const id of ids) {
      const round = rounds.get(id);
      if (fulfilled.get(id) === false && refunded.get(id) !== true && round !== undefined) {
        pending.push({ requestId: id, requiredRound: round });
      }
    }
  }
}

/**
 * Clamp a candidate startLedger so it always sits inside the RPC's retention
 * window [oldestLedger, latestLedger]. Querying an expired ledger makes
 * getEvents fail every poll, which silently blinds the oracle.
 */
function clampToRetention(
  candidate: number,
  health: { latestLedger: number; oldestLedger?: number }
): number {
  const oldest = (health.oldestLedger ?? 1) + 1; // +1 safety margin
  const latest = health.latestLedger;
  let ledger = candidate;
  if (ledger < oldest) ledger = oldest;
  if (ledger > latest) ledger = latest;
  return ledger;
}

/**
 * Poll for new VRF request events.
 * Returns an array of parsed request events since the last poll.
 *
 * Pagination strategy (per Soroban RPC rules — cursor and startLedger are
 * mutually exclusive):
 *   - When we hold a cursor from a previous page, page forward with it.
 *   - Otherwise scan from lastLedger, always clamped inside the retention
 *     window so the query never gets rejected.
 * After every successful poll (even with zero events) lastLedger is advanced
 * toward the chain head so the oracle keeps up and never falls off the
 * retention window.
 */
export async function pollRequestEvents(
  server: rpc.Server
): Promise<VrfRequestEvent[]> {
  const events: VrfRequestEvent[] = [];

  try {
    const health = await server.getHealth();

    const filters: rpc.Api.EventFilter[] = [
      {
        type: "contract",
        contractIds: [CONTRACT_ADDRESS],
        topics: [
          [xdr.ScVal.scvSymbol("request").toXDR("base64")],
        ],
      },
    ];

    // cursor and startLedger are mutually exclusive in the RPC API.
    let request: any;
    if (lastCursor) {
      request = { filters, limit: 50, cursor: lastCursor };
    } else {
      lastLedger = clampToRetention(lastLedger ?? health.latestLedger, health);
      request = { filters, limit: 50, startLedger: lastLedger };
    }

    const response = await server.getEvents(request);

    if (response.events && response.events.length > 0) {
      for (const event of response.events) {
        try {
          const parsed = parseRequestEvent(event);
          if (parsed) {
            events.push(parsed);
            log.info(
              `New VRF request #${parsed.requestId} from ${parsed.requester} ` +
              `(round ${parsed.requiredRound}, ledger ${parsed.ledger})`
            );
          }
        } catch (err) {
          log.warn(
            `Failed to parse event at ledger ${event.ledger}: ${
              err instanceof Error ? err.message : err
            }`
          );
        }

        // Track the highest ledger we have actually seen an event on.
        if (event.ledger > (lastLedger || 0)) {
          lastLedger = event.ledger;
        }
      }
    }

    // Advance the pagination cursor to the end of this page. The RPC returns a
    // `cursor` that points *after* the last event, so the next poll only sees
    // new events. This works even when there were zero events this round.
    const respCursor = (response as any).cursor as string | undefined;
    if (respCursor) {
      lastCursor = respCursor;
    } else if (!lastCursor) {
      // No cursor available yet (older RPCs): keep advancing the ledger head so
      // we never fall behind the retention window on quiet chains.
      lastLedger = clampToRetention(health.latestLedger, health);
    }

    consecutivePollFailures = 0;
    recordListenerHeartbeat();
  } catch (err: unknown) {
    consecutivePollFailures++;
    // Don't crash on transient RPC errors. If the cursor became invalid (e.g.
    // it aged out of the retention window), drop it so the next poll re-syncs
    // from a fresh, in-window startLedger instead of failing forever.
    const msg = err instanceof Error ? err.message : String(err);
    if (/cursor|startLedger|ledger|retention|-32600|out of range/i.test(msg)) {
      log.warn(`Event poll error (resyncing cursor): ${msg}`);
      lastCursor = undefined;
      try {
        const health = await server.getHealth();
        lastLedger = clampToRetention(health.latestLedger - 100, health);
      } catch {
        /* ignore — next poll retries */
      }
    } else {
      log.warn(`Event poll error: ${msg}`);
    }
  }

  return events;
}

/**
 * Parse a raw Soroban event into a VrfRequestEvent.
 * The contract emits: publish((symbol_short!("request"),), (id, requester, required_round))
 */
function parseRequestEvent(
  event: rpc.Api.EventResponse
): VrfRequestEvent | null {
  try {
    const val = event.value;
    const native = scValToNative(val);

    // scValToNative returns the tuple as an array
    if (Array.isArray(native) && native.length >= 3) {
      return {
        requestId: BigInt(native[0]),
        requester: native[1].toString(),
        requiredRound: BigInt(native[2]),
        ledger: event.ledger,
      };
    }

    log.warn(`Unexpected event value structure: ${JSON.stringify(native)}`);
    return null;
  } catch (err) {
    log.warn(`Event parse error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Fetch the request context bytes from contract storage.
 * Uses getLedgerEntries to read the RequestContext(id) persistent entry.
 */
export async function fetchRequestContext(
  server: rpc.Server,
  requestId: bigint
): Promise<Buffer> {
  // Use simulateTransaction to call get_context() — avoids key encoding issues
  const account = await server.getAccount(ORACLE_PUBLIC_KEY);

  const tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: CONTRACT_ADDRESS,
        function: "get_context",
        args: [nativeToScVal(requestId, { type: "u64" })],
      })
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`get_context simulation error: ${sim.error}`);
  }

  const result = (sim as any).result?.retval;
  if (!result) {
    throw new Error(`No result from get_context for request ${requestId}`);
  }

  // The result is scvBytes — extract directly
  try {
    return Buffer.from(result.bytes());
  } catch {
    const native = scValToNative(result);
    return Buffer.from(native);
  }
}

/**
 * Check if a request has already been fulfilled.
 */
export async function isRequestFulfilled(
  server: rpc.Server,
  requestId: bigint
): Promise<boolean> {
  try {
    const account = await server.getAccount(ORACLE_PUBLIC_KEY);

    const tx = new TransactionBuilder(account, {
      fee: "100000",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: CONTRACT_ADDRESS,
          function: "is_fulfilled",
          args: [nativeToScVal(requestId, { type: "u64" })],
        })
      )
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) return false;

    const result = (sim as any).result?.retval;
    if (!result) return false;

    return scValToNative(result) === true;
  } catch {
    return false;
  }
}

export interface ListenerLoopOptions {
  /**
   * Called every `periodicEveryMs` while the loop is active (e.g. state
   * reconciliation). Errors are logged, never fatal.
   */
  periodic?: () => Promise<void>;
  periodicEveryMs?: number;
}

/**
 * Start the event polling loop. Calls the handler for each new request.
 *
 * - Returns normally when `isActive()` turns false (leadership lost).
 * - THROWS after `LISTENER_MAX_POLL_FAILURES` consecutive failed polls, so the
 *   caller's supervisor can restart it or step down. A loop that silently
 *   keeps failing is indistinguishable from a healthy idle one.
 */
export async function startListenerLoop(
  server: rpc.Server,
  handler: (event: VrfRequestEvent) => Promise<void>,
  isActive?: () => boolean,
  options: ListenerLoopOptions = {}
): Promise<void> {
  await initListener(server);
  consecutivePollFailures = 0;
  log.info(`Polling for VRF request events every ${POLL_INTERVAL_MS}ms…`);

  let lastPeriodicAt = Date.now();

  while (!isActive || isActive()) {
    const events = await pollRequestEvents(server);

    if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
      throw new Error(
        `event polling failed ${consecutivePollFailures} times in a row — listener giving up`
      );
    }

    for (const event of events) {
      if (isActive && !isActive()) break;
      try {
        await handler(event);
      } catch (err) {
        log.error(
          `Failed to handle request ${event.requestId}: ${
            err instanceof Error ? err.message : err
          }`
        );
      }
    }

    if (
      options.periodic &&
      options.periodicEveryMs !== undefined &&
      Date.now() - lastPeriodicAt >= options.periodicEveryMs &&
      (!isActive || isActive())
    ) {
      lastPeriodicAt = Date.now();
      try {
        await options.periodic();
      } catch (err) {
        log.error(
          `Periodic listener task failed: ${err instanceof Error ? err.message : err}`
        );
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }
  log.info("Event listener loop stopped (leadership lost).");
}
