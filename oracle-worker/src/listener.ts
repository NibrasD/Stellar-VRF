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
  lastLedger = health.latestLedger - 100; // Look back ~8 min for any missed events
  log.info(`Listener initialized. Starting from ledger ${lastLedger}`);
}

/**
 * Poll for new VRF request events.
 * Returns an array of parsed request events since the last poll.
 */
export async function pollRequestEvents(
  server: rpc.Server
): Promise<VrfRequestEvent[]> {
  const events: VrfRequestEvent[] = [];

  try {
    const filters: rpc.Api.EventFilter[] = [
      {
        type: "contract",
        contractIds: [CONTRACT_ADDRESS],
        topics: [
          [xdr.ScVal.scvSymbol("request").toXDR("base64")],
        ],
      },
    ];

    // Build request based on whether we have a cursor or need startLedger
    const request: any = {
      filters,
      limit: 50,
    };

    if (lastCursor) {
      request.cursor = lastCursor;
    } else if (lastLedger) {
      request.startLedger = lastLedger;
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

        // Update cursor to the latest event — use `id` field
        const eventAny = event as any;
        lastCursor = eventAny.pagingToken || eventAny.id || lastCursor;
      }

      // Update last ledger for next poll
      const maxLedger = Math.max(...response.events.map((e) => e.ledger));
      if (maxLedger > (lastLedger || 0)) {
        lastLedger = maxLedger;
      }
    }
  } catch (err: unknown) {
    // Don't crash on transient RPC errors
    log.warn(
      `Event poll error: ${err instanceof Error ? err.message : err}`
    );
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
        args: [nativeToScVal(Number(requestId), { type: "u64" })],
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
          args: [nativeToScVal(Number(requestId), { type: "u64" })],
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
 */
export async function startListenerLoop(
  server: rpc.Server,
  handler: (event: VrfRequestEvent) => Promise<void>
): Promise<never> {
  await initListener(server);
  log.info(`Polling for VRF request events every ${POLL_INTERVAL_MS}ms…`);

  while (true) {
    const events = await pollRequestEvents(server);

    for (const event of events) {
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
}
