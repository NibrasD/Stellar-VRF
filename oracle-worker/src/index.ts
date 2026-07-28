/**
 * index.ts — Oracle Worker entry point
 *
 * Main event loop:
 *   1. Start polling for VRF request events from the contract
 *   2. For each new request:
 *      a. Check if already fulfilled (idempotency)
 *      b. Wait for the required drand round
 *      c. Fetch the drand beacon
 *      d. Read request context from contract storage
 *      e. Generate BLS-VRF proof off-chain
 *      f. Submit fulfill() transaction
 *   3. Loop forever
 */

import { printConfig } from "./config.js";
import { createServer, startListenerLoop, fetchRequestContext, isRequestFulfilled } from "./listener.js";
import { waitAndFetchBeacon } from "./drand.js";
import { generateVrfProof, deriveBlsPublicKey } from "./vrf.js";
import { submitFulfillment } from "./fulfiller.js";
import { log, bytesToHex } from "./utils.js";
import type { VrfRequestEvent } from "./listener.js";

// Track in-flight requests to avoid double-processing
const processingRequests = new Set<string>();

async function handleRequest(event: VrfRequestEvent): Promise<void> {
  const reqKey = event.requestId.toString();

  // Guard against concurrent processing of the same request
  if (processingRequests.has(reqKey)) {
    log.info(`Request ${event.requestId} is already being processed, skipping.`);
    return;
  }

  processingRequests.add(reqKey);

  try {
    const server = createServer();

    // 1. Idempotency check — skip if already fulfilled
    const fulfilled = await isRequestFulfilled(server, event.requestId);
    if (fulfilled) {
      log.info(`Request ${event.requestId} already fulfilled, skipping.`);
      return;
    }

    log.info(`═══ Processing VRF request #${event.requestId} ═══`);
    log.info(`  Requester:      ${event.requester}`);
    log.info(`  Required round: ${event.requiredRound}`);

    // 2. Wait for and fetch the drand beacon
    log.info(`  Waiting for drand round ${event.requiredRound}…`);
    const beacon = await waitAndFetchBeacon(Number(event.requiredRound));

    log.info(`  drand beacon received:`);
    log.info(`    Round:      ${beacon.round}`);
    log.info(`    Signature:  ${beacon.signature.slice(0, 32)}…`);
    log.info(`    Randomness: ${beacon.randomness.slice(0, 32)}…`);

    // 3. Fetch request context from contract storage
    log.info(`  Fetching request context from contract…`);
    const context = await fetchRequestContext(server, event.requestId);
    log.info(`  Context: ${bytesToHex(context).slice(0, 32)}… (${context.length} bytes)`);

    // 4. Generate BLS-VRF proof
    log.info(`  Generating BLS-VRF proof…`);
    const proof = generateVrfProof(event.requestId, context, beacon);

    // 5. Submit fulfill transaction
    const txHash = await submitFulfillment(server, event.requestId, proof);

    log.success(`═══ Request #${event.requestId} fulfilled ═══`);
    log.success(`  TX hash: ${txHash}`);
    log.success(`  Beta:    ${bytesToHex(proof.betaOutput)}`);
  } catch (err) {
    log.error(
      `Failed to process request ${event.requestId}: ${
        err instanceof Error ? err.message : err
      }`
    );
    if (err instanceof Error && err.stack) {
      log.error(`  Stack: ${err.stack}`);
    }
  } finally {
    processingRequests.delete(reqKey);
  }
}

async function main(): Promise<void> {
  console.log("\n");
  console.log("  ╔═══════════════════════════════════════════════════╗");
  console.log("  ║     Soroban VRF Oracle Worker — Starting Up      ║");
  console.log("  ╚═══════════════════════════════════════════════════╝");
  console.log("\n");

  // Print configuration
  printConfig();

  // Verify BLS keypair
  const blsPubKey = deriveBlsPublicKey();
  log.info(`Oracle BLS public key: ${bytesToHex(blsPubKey).slice(0, 40)}…`);
  log.info(
    `Ensure this matches the oracle_pk stored in the contract!`
  );

  // Start the event loop
  const server = createServer();
  log.info("Starting event listener loop…\n");

  await startListenerLoop(server, handleRequest);
}

// ─── Run ────────────────────────────────────────────────────────────────────

main().catch((err) => {
  log.error(`Fatal error: ${err instanceof Error ? err.message : err}`);
  if (err instanceof Error && err.stack) {
    log.error(err.stack);
  }
  process.exit(1);
});
