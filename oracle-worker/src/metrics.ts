/**
 * metrics.ts — In-memory metrics store
 *
 * Tracks oracle performance metrics. Consumed by health.ts for
 * Prometheus /metrics endpoint and /status endpoint.
 */

export interface OracleMetrics {
  requestsFulfilled: number;
  requestsFailed: number;
  avgFulfillDurationMs: number;
  drandDelays: number;
  lastFulfillAt: number | null;
  lastErrorAt: number | null;
  lastErrorMsg: string | null;
  fulfillDurations: number[]; // rolling window of last 100
}

const metrics: OracleMetrics = {
  requestsFulfilled: 0,
  requestsFailed: 0,
  avgFulfillDurationMs: 0,
  drandDelays: 0,
  lastFulfillAt: null,
  lastErrorAt: null,
  lastErrorMsg: null,
  fulfillDurations: [],
};

export function getMetrics(): Readonly<OracleMetrics> {
  return metrics;
}

export function recordFulfillment(durationMs: number): void {
  metrics.requestsFulfilled++;
  metrics.lastFulfillAt = Date.now();

  // Rolling average (last 100)
  metrics.fulfillDurations.push(durationMs);
  if (metrics.fulfillDurations.length > 100) {
    metrics.fulfillDurations.shift();
  }
  const sum = metrics.fulfillDurations.reduce((a, b) => a + b, 0);
  metrics.avgFulfillDurationMs = sum / metrics.fulfillDurations.length;
}

export function recordFailure(error: string): void {
  metrics.requestsFailed++;
  metrics.lastErrorAt = Date.now();
  metrics.lastErrorMsg = error;
}

export function recordDrandDelay(): void {
  metrics.drandDelays++;
}

// ─── Fee guard (spend on requests that don't pay for themselves) ────────────

export interface FeeGuardStats {
  /** Requests deferred by the fee guard (balance floor or unpaid cap). */
  deferred: number;
  /** Fulfillments submitted where the on-chain fee did not cover the cost. */
  unpaidFulfilled: number;
  /** Last observed oracle balance in stroops (null until first read). */
  oracleBalanceStroops: bigint | null;
  /** Unpaid spend (tx max fees, stroops) in the shared rolling hour, last observed. */
  unpaidSpendWindowStroops: bigint | null;
  /** Configured unpaid budget per rolling hour (stroops). */
  unpaidBudgetStroops: bigint | null;
}

const feeGuardStats: FeeGuardStats = {
  deferred: 0,
  unpaidFulfilled: 0,
  oracleBalanceStroops: null,
  unpaidSpendWindowStroops: null,
  unpaidBudgetStroops: null,
};

export function recordUnpaidSpendWindow(stroops: bigint): void {
  feeGuardStats.unpaidSpendWindowStroops = stroops;
}

export function recordUnpaidBudget(stroops: bigint): void {
  feeGuardStats.unpaidBudgetStroops = stroops;
}

export function getFeeGuardStats(): Readonly<FeeGuardStats> {
  return feeGuardStats;
}

export function recordFeeDeferred(): void {
  feeGuardStats.deferred++;
}

export function recordUnpaidFulfilled(): void {
  feeGuardStats.unpaidFulfilled++;
}

export function recordOracleBalance(stroops: bigint): void {
  feeGuardStats.oracleBalanceStroops = stroops;
}

/**
 * Number of requests the listener has picked up but not yet completed.
 *
 * Health checks need this to distinguish "idle because nobody asked for
 * randomness" (healthy) from "work arrived and is not getting done" (stuck).
 * Without it, a correctly idle oracle would be reported unhealthy and process
 * managers would restart it in a loop.
 */
let inFlight = 0;

export function recordRequestSeen(): void {
  inFlight++;
}

/** Call when a request leaves the pipeline, whether it succeeded or failed. */
export function recordRequestSettled(): void {
  if (inFlight > 0) inFlight--;
}

export function getInFlightCount(): number {
  return inFlight;
}

// ─── Listener liveness ──────────────────────────────────────────────────────
//
// Holding the leader lease is not the same as doing the leader's job. The
// lease lives in Redis and is renewed by a timer, so it stays valid even if the
// event loop has crashed or is stuck on a dead RPC. These fields let /health
// tell "leader and working" apart from "leader in name only".

export interface ListenerStatus {
  /** A listener session is currently running on this instance. */
  running: boolean;
  /** Last time the listener made verified progress (poll OK / request reconciled). */
  lastHeartbeatAt: number | null;
  /** When the current session started (null when not running). */
  sessionStartedAt: number | null;
  /** Total number of times the supervisor restarted a crashed session. */
  restarts: number;
  /** Most recent session failure, for operators. */
  lastError: string | null;
}

const listener: ListenerStatus = {
  running: false,
  lastHeartbeatAt: null,
  sessionStartedAt: null,
  restarts: 0,
  lastError: null,
};

export function getListenerStatus(): Readonly<ListenerStatus> {
  return listener;
}

export function recordListenerStarted(): void {
  listener.running = true;
  listener.sessionStartedAt = Date.now();
}

export function recordListenerStopped(error?: string): void {
  listener.running = false;
  listener.sessionStartedAt = null;
  if (error) listener.lastError = error;
}

/** Call whenever the listener proves it can still talk to the chain. */
export function recordListenerHeartbeat(): void {
  listener.lastHeartbeatAt = Date.now();
}

export function recordListenerRestart(): void {
  listener.restarts++;
}
