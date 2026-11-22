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
  WORKER_CONCURRENCY,
} from "./config.js";
import { mapLimit } from "./concurrency.js";
import { log, sleep } from "./utils.js";
import { recordListenerHeartbeat } from "./metrics.js";
import type { OnChainConfig } from "./configCheck.js";

export interface VrfRequestEvent {
  requestId: bigint;
  requester: string;
  epochId?: number;
  requiredRound: bigint;
  ledger: number;
}

export interface PendingRequest {
  requestId: bigint;
  epochId?: number;
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
const RECONCILE_BATCH_IDS = 100; // × 2 keys per id = the RPC's 200-key limit

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
  const activeEpochId = Number(scValToNative(need("ActiveEpochId")));
  const active = await readEpoch(server, activeEpochId, { fresh: true });
  if (!active) throw new Error(`Epoch(${activeEpochId}) not found in contract storage`);
  return {
    drandGenesis: BigInt(scValToNative(need("DrandGenesis")) as bigint | number),
    drandPeriod: BigInt(scValToNative(need("DrandPeriod")) as bigint | number),
    drandPk: new Uint8Array(scValToNative(need("DrandPK")) as Buffer),
    activeEpochId,
    oraclePk: active.oraclePk,
    oracleAddress: active.oracleAddress,
  };
}

/** A key epoch as stored in `DataKey::Epoch(id)`. */
export interface EpochInfo {
  oraclePk: Uint8Array;
  oracleAddress: string;
  status: "Active" | "Superseded" | "Revoked";
}

/** Ledger key for a contract persistent entry `name(u32 id)`, e.g. `Epoch(2)`. */
function u32EntryKey(name: string, id: number): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(CONTRACT_ADDRESS).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name), xdr.ScVal.scvU32(id)]),
      durability: xdr.ContractDataDurability.persistent,
    })
  );
}

/** Decode an `EpochData` ScVal. Exported for tests. */
export function decodeEpoch(val: xdr.ScVal): EpochInfo {
  const n = scValToNative(val) as {
    oracle_bls_pk: Buffer;
    oracle_address: string;
    status: string | string[];
  };
  const status = (Array.isArray(n.status) ? n.status[0] : n.status) as EpochInfo["status"];
  return { oraclePk: new Uint8Array(n.oracle_bls_pk), oracleAddress: String(n.oracle_address), status };
}

// Keys and operator of an epoch never change; only `status` does. Cache the
// record but re-read it after EPOCH_CACHE_MS so a revocation is noticed.
const EPOCH_CACHE_MS = 60_000;
const epochCache = new Map<number, { at: number; info: EpochInfo }>();

/** Read `Epoch(id)` (cached), or null if it does not exist. */
export async function readEpoch(
  server: rpc.Server,
  epochId: number,
  opts: { fresh?: boolean } = {}
): Promise<EpochInfo | null> {
  const hit = epochCache.get(epochId);
  if (!opts.fresh && hit && Date.now() - hit.at < EPOCH_CACHE_MS) return hit.info;
  const res = await server.getLedgerEntries(u32EntryKey("Epoch", epochId));
  const entry = res.entries[0];
  if (!entry) return null;
  const info = decodeEpoch((entry.val as any).contractData.val);
  epochCache.set(epochId, { at: Date.now(), info });
  return info;
}

/** Key epoch a request is bound to (`RequestEpoch(id)`), or null if absent. */
export async function readRequestEpoch(server: rpc.Server, id: bigint): Promise<number | null> {
  const res = await server.getLedgerEntries(requestEntryKey("RequestEpoch", id));
  const entry = res.entries[0];
  if (!entry) return null;
  return Number(scValToNative((entry.val as any).contractData.val));
}

/** True while a callback is registered for the request and not yet delivered. */
export async function hasPendingCallback(server: rpc.Server, id: bigint): Promise<boolean> {
  const res = await server.getLedgerEntries(requestEntryKey("CallbackContract", id));
  return res.entries.length > 0;
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
 * Recover requests that still need fulfilling, from the chain rather than
 * from this process's memory.
 *
 * V2 request ids are derived from the requester and its nonce (so that
 * requests by different accounts never conflict in a ledger); they cannot be
 * enumerated by counting. They do not need to be: `fulfill()` is only accepted
 * for `TIMEOUT_ROUNDS` after the bound round (5 minutes), so every request
 * that can still be fulfilled emitted its `request` event within the last few
 * minutes. Reconciliation therefore:
 *
 *   1. lists the `request` events of the last `RECONCILE_LOOKBACK_LEDGERS`
 *      ledgers (default 600, about 50 minutes: ten times the window), and
 *   2. reads `Fulfilled` / `Refunded` for those ids directly from ledger
 *      storage (batched `getLedgerEntries`), keeping the ones that are still
 *      open. V2 writes these markers only when they become true.
 *
 * This is independent of the live listener's cursor, so it also catches an
 * event the listener skipped. Returned oldest-first: the requests closest to
 * their deadline are served first.
 */
export async function findPendingRequests(
  server: rpc.Server,
  lookbackLedgers = parseInt(process.env.RECONCILE_LOOKBACK_LEDGERS || "600", 10)
): Promise<PendingRequest[]> {
  const health = await server.getHealth();
  const startLedger = clampToRetention(health.latestLedger - Math.max(1, lookbackLedgers), health);
  const filters: rpc.Api.EventFilter[] = [
    {
      type: "contract",
      contractIds: [CONTRACT_ADDRESS],
      topics: [[xdr.ScVal.scvSymbol("request").toXDR("base64")]],
    },
  ];

  const recent = new Map<bigint, VrfRequestEvent>();
  let cursor: string | undefined;
  for (let page = 0; page < RECONCILE_MAX_PAGES; page++) {
    const response: any = await server.getEvents(
      cursor
        ? { filters, limit: RECONCILE_PAGE_SIZE, cursor }
        : { filters, limit: RECONCILE_PAGE_SIZE, startLedger }
    );
    const batch = response.events ?? [];
    for (const event of batch) {
      const parsed = parseRequestEvent(event);
      if (parsed) recent.set(parsed.requestId, parsed);
    }
    if (batch.length < RECONCILE_PAGE_SIZE || !response.cursor) break;
    cursor = response.cursor;
  }

  const candidates = [...recent.values()].sort((a, b) => a.ledger - b.ledger);
  const pending: PendingRequest[] = [];
  for (let i = 0; i < candidates.length; i += RECONCILE_BATCH_IDS) {
    const chunk = candidates.slice(i, i + RECONCILE_BATCH_IDS);
    const res = await server.getLedgerEntries(
      ...chunk.flatMap((c) => [
        requestEntryKey("Fulfilled", c.requestId),
        requestEntryKey("Refunded", c.requestId),
      ])
    );
    const closed = new Set<bigint>();
    for (const entry of res.entries) {
      const data = (entry.val as any).contractData;
      const key = scValToNative(data.key);
      if (Array.isArray(key) && key.length === 2 && scValToNative(data.val) === true) {
        closed.add(BigInt(key[1]));
      }
    }
    for (const c of chunk) {
      if (!closed.has(c.requestId)) {
        pending.push({ requestId: c.requestId, requiredRound: c.requiredRound, epochId: c.epochId });
      }
    }
  }
  recordListenerHeartbeat();

  const scanned = `${recent.size} request event(s) since ledger ${startLedger}`;
  if (pending.length) {
    log.warn(
      `Reconciliation found ${pending.length} open request(s) (${scanned}): ` +
        pending.map((p) => String(p.requestId)).join(", ")
    );
  } else {
    log.info(`Reconciliation: no open requests (${scanned}).`);
  }
  return pending;
}

const RECONCILE_PAGE_SIZE = 200;
const RECONCILE_MAX_PAGES = 50;

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
    if (Array.isArray(native) && native.length >= 4) {
      return {
        requestId: BigInt(native[0]),
        requester: native[1].toString(),
        epochId: Number(native[2]),
        requiredRound: BigInt(native[3]),
        ledger: event.ledger,
      };
    } else if (Array.isArray(native) && native.length >= 3) {
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

    // Handle a poll's events concurrently (bounded). The handler serializes
    // its own on-chain sends; see concurrency.ts for why this is not a queue.
    await mapLimit(events, WORKER_CONCURRENCY, async (event) => {
      if (isActive && !isActive()) return;
      try {
        await handler(event);
      } catch (err) {
        log.error(
          `Failed to handle request ${event.requestId}: ${
            err instanceof Error ? err.message : err
          }`
        );
      }
    });

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
