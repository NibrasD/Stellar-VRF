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
import { createServer, startListenerLoop, fetchRequestContext, isRequestFulfilled } from "./listener.js";
import { waitAndFetchBeacon } from "./drand.js";
import { generateVrfProof, deriveBlsPublicKey } from "./vrf.js";
import { submitFulfillment } from "./fulfiller.js";
import { log, bytesToHex } from "./utils.js";
import { startLeaderElection, isLeader, getInstanceId } from "./leader.js";
import { startHealthServer } from "./health.js";
import { recordFulfillment, recordFailure } from "./metrics.js";
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

    // 5. Submit fulfill transaction (with retry for sequence conflicts)
    const txHash = await withFulfillRetry(
      `fulfill(${event.requestId})`,
      () => submitFulfillment(server, event.requestId, proof)
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
  }
}

async function startListening(): Promise<void> {
  if (listenerActive) return;
  listenerActive = true;
  log.info(`[${getInstanceId()}] Became LEADER — starting event listener.`);
  const server = createServer();
  await startListenerLoop(server, handleRequest);
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
