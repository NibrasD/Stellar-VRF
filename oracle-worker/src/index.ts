/**
 * index.ts — Oracle Worker entry point (HA-enabled)
 *
 * Main event loop with leader election:
 *   1. Start health HTTP server (all instances)
 *   2. Run leader election — only leader processes requests
 *   3. Leader: poll for VRF request events from the contract
 *   4. For each new request:
 *      a. Check if already fulfilled (idempotency)
 *      b. Wait for the required drand round (with lag detection)
 *      c. Fetch the drand beacon (with retry)
 *      d. Read request context from contract storage
 *      e. Generate BLS-VRF proof off-chain
 *      f. Submit fulfill() transaction (with retry)
 *      g. Record metrics
 *   5. Standby: watches for leader failure, takes over automatically
 */

import { printConfig } from "./config.js";
import {
  createServer,
  startListenerLoop,
  fetchRequestContext,
  isRequestFulfilled,
  findPendingRequests,
  fetchRequestRound,
} from "./listener.js";
import { waitAndFetchBeacon } from "./drand.js";
import { generateVrfProof, deriveBlsPublicKey } from "./vrf.js";
import { submitFulfillment } from "./fulfiller.js";
import { log, bytesToHex } from "./utils.js";
import { startLeaderElection, isLeader, getInstanceId } from "./leader.js";
import { startHealthServer } from "./health.js";
import {
  recordFulfillment,
  recordFailure,
  recordRequestSeen,
  recordRequestSettled,
} from "./metrics.js";
import { withRetry, withFulfillRetry, checkDrandLag } from "./retry.js";
import { DRAND_PERIOD } from "./config.js";
import type { VrfRequestEvent } from "./listener.js";

// Track in-flight requests to avoid double-processing
const processingRequests = new Set<string>();

// Is the event listener active? (only when leader)
let listenerActive = false;

async function handleRequest(event: VrfRequestEvent): Promise<void> {
  // Double-check leadership before every request
  if (!isLeader()) {
    log.info(`[${getInstanceId()}] Skipping request ${event.requestId} — not leader.`);
    return;
  }

  const reqKey = event.requestId.toString();

  // Guard against concurrent processing of the same request
  if (processingRequests.has(reqKey)) {
    log.info(`Request ${event.requestId} is already being processed, skipping.`);
    return;
  }

  processingRequests.add(reqKey);
  recordRequestSeen();
  const startMs = Date.now();

  try {
    const server = createServer();

    // 1. Idempotency check — skip if already fulfilled
    const fulfilled = await withRetry(
      `is_fulfilled(${event.requestId})`,
      () => isRequestFulfilled(server, event.requestId)
    );
    if (fulfilled) {
      log.info(`Request ${event.requestId} already fulfilled, skipping.`);
      return;
    }

    log.info(`═══ Processing VRF request #${event.requestId} ═══`);
    log.info(`  Requester:      ${event.requester}`);
    log.info(`  Required round: ${event.requiredRound}`);

    // 2. Wait for and fetch the drand beacon (with lag detection + retry)
    const currentRound = Math.floor(
      (Date.now() / 1000 - 1692803367) / DRAND_PERIOD
    );
    checkDrandLag(Number(event.requiredRound), currentRound, DRAND_PERIOD * 1000);

    log.info(`  Waiting for drand round ${event.requiredRound}…`);
    const beacon = await withRetry(
      `drand_beacon(round=${event.requiredRound})`,
      () => waitAndFetchBeacon(Number(event.requiredRound))
    );

    log.info(`  drand beacon received:`);
    log.info(`    Round:      ${beacon.round}`);
    log.info(`    Signature:  ${beacon.signature.slice(0, 32)}…`);
    log.info(`    Randomness: ${beacon.randomness.slice(0, 32)}…`);

    // 3. Fetch request context from contract storage (with retry)
    log.info(`  Fetching request context from contract…`);
    const context = await withRetry(
      `fetch_context(${event.requestId})`,
      () => fetchRequestContext(server, event.requestId)
    );
    log.info(`  Context: ${bytesToHex(context).slice(0, 32)}… (${context.length} bytes)`);

    // 4. Generate BLS-VRF proof
    log.info(`  Generating BLS-VRF proof…`);
    const proof = generateVrfProof(event.requestId, context, beacon);

    // 5. Re-verify leadership immediately before spending money.
    //
    // Steps 2–4 can block for a long time (waiting for a future drand round can
    // take tens of seconds). In that window this process may have been paused,
    // partitioned or GC-stalled past the lease TTL, in which case the standby
    // has legitimately taken over. Submitting now would make us a zombie
    // leader: the on-chain `Fulfilled` flag still keeps the RESULT correct, but
    // we would burn fees on a transaction that is going to be rejected, and
    // behave like a split brain.
    //
    // The check is repeated inside the retry callback because retries add more
    // delay after this point.
    if (!isLeader()) {
      log.warn(
        `[${getInstanceId()}] Lost leadership while preparing request ${event.requestId} — ` +
          `discarding instead of submitting.`
      );
      return;
    }

    const txHash = await withFulfillRetry(
      `fulfill(${event.requestId})`,
      () => {
        if (!isLeader()) {
          throw new Error(
            `aborting fulfill(${event.requestId}): leadership lost before submit`
          );
        }
        return submitFulfillment(server, event.requestId, proof);
      }
    );

    const durationMs = Date.now() - startMs;
    recordFulfillment(durationMs);

    log.success(`═══ Request #${event.requestId} fulfilled (${durationMs}ms) ═══`);
    log.success(`  TX hash: ${txHash}`);
    log.success(`  Beta:    ${bytesToHex(proof.betaOutput)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordFailure(msg);
    log.error(`Failed to process request ${event.requestId}: ${msg}`);
    if (err instanceof Error && err.stack) {
      log.error(`  Stack: ${err.stack}`);
    }
  } finally {
    processingRequests.delete(reqKey);
    recordRequestSettled();
  }
}

async function startListening(): Promise<void> {
  if (listenerActive) return;
  listenerActive = true;
  log.info(`[${getInstanceId()}] Became LEADER — starting event listener.`);
  try {
    const server = createServer();

    // Reconcile against contract state before relying on events.
    //
    // The event cursor is in-memory only and the RPC event window is finite, so
    // a request whose `request` event has aged out would otherwise never be
    // seen again — it would sit unfulfilled until the requester claimed
    // timeout_refund(). This closes that liveness gap on every leadership
    // acquisition (startup and failover alike).
    try {
      const pending = await findPendingRequests(server);
      for (const requestId of pending) {
        if (!isLeader()) break;
        const requiredRound = await fetchRequestRound(server, requestId);
        if (requiredRound === null) {
          log.warn(`Skipping request ${requestId}: could not read its required round.`);
          continue;
        }
        await handleRequest({
          requestId,
          requester: "(recovered)",
          requiredRound,
          ledger: 0,
        });
      }
    } catch (err) {
      // Reconciliation is best-effort: never block the live listener on it.
      log.error(
        `Startup reconciliation failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    await startListenerLoop(server, handleRequest, () => listenerActive);
  } finally {
    // Reset flag so the listener can restart if it crashes or exits.
    // Without this, a crash leaves listenerActive = true permanently,
    // and the guard above prevents any restart attempt (zombie state).
    listenerActive = false;
  }
}

function onLoseLeadership(): void {
  listenerActive = false;
  log.warn(`[${getInstanceId()}] Lost leadership — pausing fulfillments.`);
  // Note: in-flight requests complete naturally; new ones won't be started
}

async function main(): Promise<void> {
  console.log("\n");
  console.log("  ╔═══════════════════════════════════════════════════╗");
  console.log("  ║  Soroban VRF Oracle Worker — HA Mode Starting    ║");
  console.log("  ╚═══════════════════════════════════════════════════╝");
  console.log("\n");

  printConfig();

  // Verify BLS keypair
  const blsPubKey = deriveBlsPublicKey();
  log.info(`Oracle BLS public key: ${bytesToHex(blsPubKey).slice(0, 40)}…`);
  log.info(`Instance ID: ${getInstanceId()}`);

  // Start health server on all instances (primary + standby)
  startHealthServer();

  // Start leader election
  // Only the leader runs the event listener and submits transactions
  startLeaderElection(
    () => startListening().catch((err) => log.error(`Listener error: ${err}`)),
    onLoseLeadership
  );
}

// ─── Run ────────────────────────────────────────────────────────────────────

main().catch((err) => {
  log.error(`Fatal error: ${err instanceof Error ? err.message : err}`);
  if (err instanceof Error && err.stack) {
    log.error(err.stack);
  }
  process.exit(1);
});
