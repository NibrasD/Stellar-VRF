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
