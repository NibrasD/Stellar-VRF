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

export interface VrfRequestEvent {
  requestId: bigint;
  requester: string;
  requiredRound: bigint;
  ledger: number;
}

// Persistent cursor for event pagination
let lastCursor: string | undefined;
let lastLedger: number | undefined;

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
  // Look back ~100 ledgers (~8 min) for any recently missed events, but never
  // before the RPC's retention window (oldestLedger) or the request is rejected.
  lastLedger = clampToRetention(health.latestLedger - 100, health);
  lastCursor = undefined;
  log.info(`Listener initialized. Starting from ledger ${lastLedger}`);
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
  } catch (err: unknown) {
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

/**
 * Start the event polling loop. Calls the handler for each new request.
 * Exits gracefully when isActive() returns false.
 */
export async function startListenerLoop(
  server: rpc.Server,
  handler: (event: VrfRequestEvent) => Promise<void>,
  isActive?: () => boolean
): Promise<void> {
  await initListener(server);
  log.info(`Polling for VRF request events every ${POLL_INTERVAL_MS}ms…`);

  while (!isActive || isActive()) {
    const events = await pollRequestEvents(server);

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

    await sleep(POLL_INTERVAL_MS);
  }
  log.info("Event listener loop stopped (leadership lost).");
}
