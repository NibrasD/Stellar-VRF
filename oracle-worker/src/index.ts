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

import { printConfig, NETWORK_PASSPHRASE } from "./config.js";
import {
  createServer,
  startListenerLoop,
  fetchRequestContext,
  isRequestFulfilled,
  findPendingRequests,
  readFeeAmount,
  readFeeToken,
  readOracleBalance,
  readRequester,
} from "./listener.js";
import { FeeGuard, feeGuardOptionsFromEnv, formatXlm, type Funding } from "./feeGuard.js";
import { createSpendLedger } from "./spendLedger.js";
import { SendAttemptTracker, sendAttemptOptionsFromEnv } from "./sendAttempts.js";
import { Asset } from "@stellar/stellar-sdk";
import { waitAndFetchBeacon, computeCurrentRound } from "./drand.js";
import { FulfillTerminalError } from "./fulfillErrors.js";
import { verifyChainConfig, chainConfigSkipPolicyError } from "./configCheck.js";
import { readChainConfig } from "./listener.js";
import {
  DRAND_GENESIS_TIME,
  DRAND_PUBLIC_KEY,
  ORACLE_PUBLIC_KEY,
} from "./config.js";
import { Networks } from "@stellar/stellar-sdk";
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
  recordUnpaidSpendWindow,
  recordUnpaidBudget,
  recordTerminalFailure,
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

// FeeAmount only means stroops when FeeToken is the native XLM SAC.
const NATIVE_TOKEN_ID = Asset.native().contractId(NETWORK_PASSPHRASE);
const feeGuardOptions = feeGuardOptionsFromEnv(NATIVE_TOKEN_ID);
const feeGuardServer = createServer();
// Shared with the leader lease backend: Redis in HA, a file otherwise. The
// unpaid budget is therefore per deployment, not per process.
const spendLedger = createSpendLedger();
const feeGuard = new FeeGuard(
  {
    readFeeAmount: () => readFeeAmount(feeGuardServer),
    readFeeToken: () => readFeeToken(feeGuardServer),
    readBalance: () => readOracleBalance(feeGuardServer),
    readRequester: (id) => readRequester(feeGuardServer, id),
    ledger: spendLedger,
    now: Date.now,
    onBalance: recordOracleBalance,
    onUnpaidSpend: recordUnpaidSpendWindow,
  },
  feeGuardOptions
);
recordUnpaidBudget(feeGuardOptions.unpaidBudgetStroops);

// Per-request cap on sendTransaction() calls across ALL retries and
// reconciliation passes, so a request that keeps failing after simulation
// cannot drain network fees without limit (see sendAttempts.ts).
const sendAttempts = new SendAttemptTracker(sendAttemptOptionsFromEnv());

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
  let funding: Funding = "paid";

  try {
    const server = createServer();

    // 1. Idempotency check — skip if already fulfilled
    const fulfilled = await withRetry(
      `is_fulfilled(${event.requestId})`,
      () => isRequestFulfilled(server, event.requestId)
    );
    if (fulfilled) {
      sendAttempts.clear(event.requestId);
      log.info(`Request ${event.requestId} already fulfilled, skipping.`);
      return;
    }

    // 1a. Parked requests: send allowance already used up. Skip BEFORE waiting
    // for drand or generating a proof, so reconciliation passes cost nothing.
    if (sendAttempts.isExhausted(event.requestId)) {
      recordFeeDeferred();
      log.warn(
        `Request ${event.requestId} is parked: ${sendAttempts.count(event.requestId)}/` +
          `${sendAttempts.limit} fulfill sends already spent. Not retrying ` +
          `(the requester can timeout_refund()).`
      );
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
    funding = decision.funding;
    if (funding !== "paid") log.info(`  Fee guard: ${decision.reason}`);

    log.info(`═══ Processing VRF request #${event.requestId} ═══`);
    log.info(`  Requester:      ${event.requester}`);
    log.info(`  Required round: ${event.requiredRound}`);

    // 2. Wait for and fetch the drand beacon (with lag detection + retry)
    // Genesis/period come from config (verified against the contract at
    // startup by configCheck.ts), never a hard-coded quicknet constant.
    const currentRound = computeCurrentRound(Date.now() / 1000);
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

    // Leadership AND the fee guard are re-checked before EVERY
    // sendTransaction(): the outer withFulfillRetry attempts and
    // submitFulfillment's own inner retries. For budget-funded requests each
    // send reserves its maximum fee in the shared ledger first, so retries and
    // ambiguous timeouts count against the budget. A FulfillAbortedError is
    // terminal — withFulfillRetry does not retry it.
    const sendFunding = funding;
    const txHash = await withFulfillRetry(
      `fulfill(${event.requestId})`,
      () =>
        submitFulfillment(server, event.requestId, proof, isLeader, async (maxFee) => {
          // Per-request send cap first: it is free to check and never reserves
          // shared budget for a send that will be refused anyway.
          if (sendAttempts.isExhausted(event.requestId)) {
            return sendAttempts.tryReserve(event.requestId); // yields the refusal reason
          }
          const gate = await feeGuard.authorizeSend(sendFunding, maxFee);
          if (!gate.ok) return gate;
          return sendAttempts.tryReserve(event.requestId);
        })
    );
    sendAttempts.clear(event.requestId);

    const durationMs = Date.now() - startMs;
    recordFulfillment(durationMs);
    if (funding !== "paid") recordUnpaidFulfilled();
    feeGuard.invalidateBalance(); // the submission just changed it

    log.success(`═══ Request #${event.requestId} fulfilled (${durationMs}ms) ═══`);
    log.success(`  TX hash: ${txHash}`);
    log.success(`  Beta:    ${bytesToHex(proof.betaOutput)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordFailure(msg);
    feeGuard.invalidateBalance(); // a failed send may still have charged a fee
    if (err instanceof FulfillTerminalError) {
      // Deterministic: the same inputs fail the same way. Park the request so
      // reconciliation stops spending on it (see fulfillErrors.ts).
      recordTerminalFailure(err.reason);
      if (err.settled) {
        sendAttempts.clear(event.requestId);
        log.info(`Request ${event.requestId} needs no further work (${err.reason}).`);
      } else {
        sendAttempts.park(event.requestId);
        log.warn(
          `Request ${event.requestId} parked after terminal failure (${err.reason}); ` +
            `not retrying. The requester can timeout_refund().`
        );
      }
    }
    if (err instanceof Error && err.name === "FulfillAbortedError" && !/leadership lost/.test(msg)) {
      recordFeeDeferred(); // refused at send time by the fee guard; stays pending on-chain
    }
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

  // The contract is the single source of truth for drand genesis/period/key
  // and the oracle keys. Refuse to start when the environment disagrees:
  // every proof would be rejected on-chain and still cost fees.
  const skipCheck = (process.env.SKIP_CHAIN_CONFIG_CHECK || "").toLowerCase() === "true";
  const skipPolicy = chainConfigSkipPolicyError(
    skipCheck,
    NETWORK_PASSPHRASE,
    process.env.NODE_ENV,
    Networks.PUBLIC
  );
  if (skipPolicy) throw new Error(skipPolicy);
  if (skipCheck) {
    log.warn("SKIP_CHAIN_CONFIG_CHECK=true: NOT verifying config against the contract (debug only).");
  } else {
    await verifyChainConfig(
      {
        drandGenesisTime: DRAND_GENESIS_TIME,
        drandPeriod: DRAND_PERIOD,
        drandPublicKeyHex: DRAND_PUBLIC_KEY,
        oracleBlsPublicKey: blsPubKey,
        oracleAddress: ORACLE_PUBLIC_KEY,
      },
      () => withRetry("read_chain_config", () => readChainConfig(feeGuardServer))
    );
    log.info("Chain config check: drand genesis/period/key and oracle keys match the contract.");
  }

  // Report the economic posture up front so operators see it in the first log lines.
  const { fulfillCostStroops, minBalanceStroops, unpaidBudgetStroops, allowlist } = feeGuardOptions;
  log.info(`Fee guard spend ledger: ${spendLedger.describe()}`);
  try {
    const [fee, token] = await Promise.all([readFeeAmount(feeGuardServer), readFeeToken(feeGuardServer)]);
    const unpaidPosture =
      `Fee guard: unpaid budget ${formatXlm(unpaidBudgetStroops)}/hour (tx max fees, all instances) + ` +
      `${allowlist.size} allowlisted requester(s), balance floor ${formatXlm(minBalanceStroops)}.`;
    if (token !== NATIVE_TOKEN_ID) {
      log.warn(
        `Contract FeeToken ${token} is not native XLM (${NATIVE_TOKEN_ID}). The worker cannot price it, ` +
          `so EVERY request is treated as unpaid. ${unpaidPosture}`
      );
    } else if (fee < fulfillCostStroops) {
      log.warn(
        `Contract FeeAmount (${fee} stroops) is below the fulfill cost (${fulfillCostStroops} stroops): ` +
          `requests do not pay for themselves. ${unpaidPosture}`
      );
    } else {
      log.info(`Contract FeeAmount ${fee} stroops (XLM) covers the fulfill cost; balance floor ${formatXlm(minBalanceStroops)}.`);
    }
  } catch (err) {
    log.warn(`Could not read contract FeeAmount/FeeToken at startup (${err instanceof Error ? err.message : err}); treating requests as unpaid.`);
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
