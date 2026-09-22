/**
 * index.ts — Oracle Worker entry point (HA-enabled)
 *
 * Main event loop with leader election:
 *   1. Start health HTTP server (all instances)
 *   2. Run leader election — only leader processes requests
 *   3. Leader: a supervised listener session (restarted on crash; leadership
 *      relinquished if it keeps crashing) that first reconciles against
 *      contract state, then polls for VRF request events, re-reconciling
 *      every RECONCILE_INTERVAL_MS
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
  readFeeAmount,
  readOracleBalance,
  readRequester,
} from "./listener.js";
import { FeeGuard, feeGuardOptionsFromEnv, formatXlm } from "./feeGuard.js";
import { waitAndFetchBeacon } from "./drand.js";
import { generateVrfProof, deriveBlsPublicKey } from "./vrf.js";
import { submitFulfillment } from "./fulfiller.js";
import { log, bytesToHex, sleep } from "./utils.js";
import {
  startLeaderElection,
  isLeader,
  getInstanceId,
  relinquishLeadership,
} from "./leader.js";
import { startHealthServer } from "./health.js";
import {
  recordFulfillment,
  recordFailure,
  recordRequestSeen,
  recordRequestSettled,
  recordListenerStarted,
  recordListenerStopped,
  recordListenerRestart,
  recordFeeDeferred,
  recordUnpaidFulfilled,
  recordOracleBalance,
} from "./metrics.js";
import { withRetry, withFulfillRetry, checkDrandLag } from "./retry.js";
import { DRAND_PERIOD } from "./config.js";
import { ListenerSupervisor } from "./supervisor.js";
import type { rpc } from "@stellar/stellar-sdk";
import type { VrfRequestEvent } from "./listener.js";

// Track in-flight requests to avoid double-processing
const processingRequests = new Set<string>();

/** A real Stellar account (G…) or contract (C…) StrKey. */
const STRKEY_RE = /^[GC][A-Z2-7]{55}$/;

const feeGuardOptions = feeGuardOptionsFromEnv();
const feeGuardServer = createServer();
const feeGuard = new FeeGuard(
  {
    readFeeAmount: () => readFeeAmount(feeGuardServer),
    readBalance: () => readOracleBalance(feeGuardServer),
    readRequester: (id) => readRequester(feeGuardServer, id),
    now: Date.now,
    onBalance: recordOracleBalance,
  },
  feeGuardOptions
);

/**
 * How often the leader re-reconciles against contract state while running.
 * Startup reconciliation alone is not enough: a request whose event is missed
 * mid-session (RPC hiccup, cursor resync that skips ahead) would otherwise
 * wait for the next leadership change to be noticed.
 */
const RECONCILE_INTERVAL_MS = parseInt(process.env.RECONCILE_INTERVAL_MS || "120000", 10);

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
  let unpaid = false;
  let submitAttempted = false;

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

    // 1b. Economic guard — decide BEFORE waiting for drand or doing any work
    // whether this request may cost the oracle money (see feeGuard.ts).
    const decision = await feeGuard.check(
      event.requestId,
      STRKEY_RE.test(event.requester) ? event.requester : null
    );
    if (!decision.allow) {
      recordFeeDeferred();
      log.warn(
        `Deferring request ${event.requestId}: ${decision.reason}. It stays pending on-chain ` +
          `(reconciliation will retry; the requester can timeout_refund()).`
      );
      return;
    }
    unpaid = !decision.paid;
    if (unpaid) log.info(`  Fee guard: ${decision.reason}`);

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
      if (unpaid) feeGuard.refundUnpaidSlot(); // nothing was spent
      return;
    }

    // Leadership is re-checked before EVERY submission attempt: the outer
    // withFulfillRetry attempts and submitFulfillment's own inner retries.
    // A FulfillAbortedError is terminal — withFulfillRetry does not retry it.
    submitAttempted = true; // from here on, fees may have been spent
    const txHash = await withFulfillRetry(
      `fulfill(${event.requestId})`,
      () => submitFulfillment(server, event.requestId, proof, isLeader)
    );

    const durationMs = Date.now() - startMs;
    recordFulfillment(durationMs);
    if (unpaid) recordUnpaidFulfilled();
    feeGuard.invalidateBalance(); // the submission just changed it

    log.success(`═══ Request #${event.requestId} fulfilled (${durationMs}ms) ═══`);
    log.success(`  TX hash: ${txHash}`);
    log.success(`  Beta:    ${bytesToHex(proof.betaOutput)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordFailure(msg);
    // Failed before any transaction was sent (drand / context / proof): the
    // unpaid budget slot was not actually spent.
    if (unpaid && !submitAttempted) feeGuard.refundUnpaidSlot();
    log.error(`Failed to process request ${event.requestId}: ${msg}`);
    if (err instanceof Error && err.stack) {
      log.error(`  Stack: ${err.stack}`);
    }
  } finally {
    processingRequests.delete(reqKey);
    recordRequestSettled();
  }
}

/**
 * Recover work from contract STATE (not events) and process it.
 *
 * Runs at the start of every listener session — i.e. on process start, on
 * failover, and after every listener restart — and then periodically. Safe to
 * run repeatedly: `handleRequest()` skips anything already fulfilled or in
 * flight, and the contract rejects duplicates regardless.
 */
async function reconcile(server: rpc.Server, isCurrent: () => boolean): Promise<void> {
  const pending = await findPendingRequests(server);
  for (const p of pending) {
    if (!isCurrent()) break;
    await handleRequest({
      requestId: p.requestId,
      requester: "(recovered by reconciliation)",
      requiredRound: p.requiredRound,
      ledger: 0,
    });
  }
}

/** One listener session: reconcile, then poll events (with periodic reconcile). */
async function runListenerSession(isCurrent: () => boolean): Promise<void> {
  log.info(`[${getInstanceId()}] Starting listener session.`);
  const server = createServer();

  try {
    await reconcile(server, isCurrent);
  } catch (err) {
    // Not fatal: live events still flow, and the periodic pass below retries.
    log.error(
      `Startup reconciliation failed (will retry every ${RECONCILE_INTERVAL_MS}ms): ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!isCurrent()) return;

  await startListenerLoop(server, handleRequest, isCurrent, {
    periodic: () => reconcile(server, isCurrent),
    periodicEveryMs: RECONCILE_INTERVAL_MS,
  });
}

const supervisor = new ListenerSupervisor({
  runSession: runListenerSession,
  isLeader,
  relinquish: relinquishLeadership,
  sleep,
  now: Date.now,
  log,
  onSessionStart: recordListenerStarted,
  onSessionEnd: recordListenerStopped,
  onRestart: recordListenerRestart,
});

function onBecomeLeader(): void {
  log.info(`[${getInstanceId()}] Became LEADER — starting supervised event listener.`);
  supervisor.start().catch((err) => {
    // The supervisor itself handles session crashes; reaching here means a
    // bug in the supervisor. Do not keep a lease we cannot serve.
    log.error(`Supervisor failed unexpectedly: ${err}`);
    void relinquishLeadership(`supervisor failure: ${err}`);
  });
}

function onLoseLeadership(): void {
  supervisor.stop();
  log.warn(`[${getInstanceId()}] Not leader — listener stopped, no new fulfillments.`);
  // In-flight requests re-check isLeader() before submitting and abort.
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

  // Report the economic posture up front so operators see it in the first log lines.
  const { fulfillCostStroops, minBalanceStroops, maxUnpaidPerHour, allowlist } = feeGuardOptions;
  try {
    const fee = await readFeeAmount(feeGuardServer);
    if (fee < fulfillCostStroops) {
      log.warn(
        `Contract FeeAmount (${fee} stroops) is below the fulfill cost (${fulfillCostStroops} stroops): ` +
          `requests do not pay for themselves. Fee guard: at most ${maxUnpaidPerHour} unpaid ` +
          `fulfillment(s)/hour + ${allowlist.size} allowlisted requester(s), ` +
          `balance floor ${formatXlm(minBalanceStroops)}.`
      );
    } else {
      log.info(`Contract FeeAmount ${fee} stroops covers the fulfill cost; balance floor ${formatXlm(minBalanceStroops)}.`);
    }
  } catch (err) {
    log.warn(`Could not read contract FeeAmount at startup (${err instanceof Error ? err.message : err}); treating requests as unpaid.`);
  }

  // Start health server on all instances (primary + standby)
  startHealthServer();

  // Start leader election
  // Only the leader runs the event listener and submits transactions
  startLeaderElection(onBecomeLeader, onLoseLeadership);
}

// ─── Run ────────────────────────────────────────────────────────────────────

main().catch((err) => {
  log.error(`Fatal error: ${err instanceof Error ? err.message : err}`);
  if (err instanceof Error && err.stack) {
    log.error(err.stack);
  }
  process.exit(1);
});
