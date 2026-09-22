/**
 * health.ts — HTTP health check endpoint
 *
 * Exposes /health and /metrics endpoints for monitoring.
 * Load balancers and process managers (PM2, Docker) use /health.
 */

import http from "http";
import { getLeaderState, getInstanceId } from "./leader.js";
import { getMetrics, getInFlightCount, getListenerStatus, getFeeGuardStats } from "./metrics.js";

const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || "8080", 10);

let server: http.Server | null = null;
let startTime = Date.now();

export function startHealthServer(): void {
  server = http.createServer((req, res) => {
    const url = req.url || "/";

    if (url === "/health" || url === "/") {
      handleHealth(res);
    } else if (url === "/metrics") {
      handleMetrics(res);
    } else if (url === "/status") {
      handleStatus(res);
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  server.listen(HEALTH_PORT, "127.0.0.1", () => {
    console.log(`[Health] HTTP server listening on 127.0.0.1:${HEALTH_PORT}`);
  });

  server.on("error", (err) => {
    console.error(`[Health] Server error: ${err.message}`);
  });
}

/** A leader that has seen requests but stopped completing them is stuck. */
const STALL_THRESHOLD_MS = parseInt(process.env.HEALTH_STALL_MS || "600000", 10); // 10 min

/**
 * A leader whose listener has not made progress (successful poll or
 * reconciliation) for this long is not doing its job, even with zero traffic.
 * Default: 2 minutes (≈40 polls at the default 3s interval).
 */
const LISTENER_STALE_MS = parseInt(process.env.HEALTH_LISTENER_STALE_MS || "120000", 10);

/** Grace period after a listener session starts before staleness is judged. */
const LISTENER_GRACE_MS = parseInt(process.env.HEALTH_LISTENER_GRACE_MS || "60000", 10);

/**
 * Pure liveness evaluation for a leader's listener — exported for tests.
 * Returns a human-readable reason if degraded, else null.
 */
export function evaluateListenerHealth(
  role: string,
  listener: {
    running: boolean;
    lastHeartbeatAt: number | null;
    sessionStartedAt: number | null;
  },
  now: number,
  staleMs = LISTENER_STALE_MS,
  graceMs = LISTENER_GRACE_MS
): string | null {
  if (role !== "leader") return null;
  if (!listener.running) {
    return "leader holds the lease but no listener session is running";
  }
  const started = listener.sessionStartedAt ?? now;
  if (now - started < graceMs) return null;
  const last = listener.lastHeartbeatAt ?? started;
  const idle = now - last;
  if (idle > staleMs) {
    return (
      `listener has made no progress for ${Math.floor(idle / 1000)}s ` +
      `(threshold ${Math.floor(staleMs / 1000)}s) — RPC unreachable or loop stuck`
    );
  }
  return null;
}

function handleHealth(res: http.ServerResponse): void {
  const leaderState = getLeaderState();
  const metrics = getMetrics();
  const listener = getListenerStatus();
  const now = Date.now();
  const uptimeSeconds = Math.floor((now - startTime) / 1000);

  // Liveness rules:
  //  - "standby"/"unknown" are healthy: a standby is *supposed* to be idle, so
  //    fulfillment staleness says nothing about it.
  //  - A "leader" is degraded if it has fulfilled at least one request before
  //    but nothing for STALL_THRESHOLD_MS — that is a genuine stall.
  //  - A leader that has never fulfilled anything is only judged once it has
  //    been up longer than the threshold, so a fresh start is not flagged.
  //
  // Previously this function accepted every leader state unconditionally, so a
  // wedged leader still returned 200 OK and monitoring never fired.
  //  - A "leader" is ALSO degraded if its listener is not running or has made
  //    no progress recently. Holding the lease does not prove the event loop
  //    is alive, and an idle leader with a dead listener would otherwise look
  //    exactly like an idle healthy one.
  let degradedReason: string | null = evaluateListenerHealth(leaderState, listener, now);
  const inFlight = getInFlightCount();
  if (!degradedReason && leaderState === "leader" && inFlight > 0) {
    const reference = metrics.lastFulfillAt ?? startTime;
    const idleMs = now - reference;
    if (idleMs > STALL_THRESHOLD_MS) {
      degradedReason =
        `${inFlight} request(s) in flight but none completed for ` +
        `${Math.floor(idleMs / 1000)}s (threshold ${Math.floor(STALL_THRESHOLD_MS / 1000)}s)`;
    }
  }

  const isHealthy = degradedReason === null;

  const body = {
    status: isHealthy ? "ok" : "degraded",
    instance: getInstanceId(),
    role: leaderState,
    uptime_seconds: uptimeSeconds,
    requests_fulfilled: metrics.requestsFulfilled,
    requests_failed: metrics.requestsFailed,
    last_fulfill_at: metrics.lastFulfillAt
      ? new Date(metrics.lastFulfillAt).toISOString()
      : null,
    listener: {
      running: listener.running,
      last_progress_at: listener.lastHeartbeatAt
        ? new Date(listener.lastHeartbeatAt).toISOString()
        : null,
      restarts: listener.restarts,
      last_error: listener.lastError,
    },
    ...(degradedReason ? { degraded_reason: degradedReason } : {}),
  };

  res.writeHead(isHealthy ? 200 : 503, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function handleMetrics(res: http.ServerResponse): void {
  // Prometheus text format
  const m = getMetrics();
  const fg = getFeeGuardStats();
  const lines = [
    `# HELP vrf_requests_fulfilled_total Total VRF requests successfully fulfilled`,
    `# TYPE vrf_requests_fulfilled_total counter`,
    `vrf_requests_fulfilled_total ${m.requestsFulfilled}`,
    ``,
    `# HELP vrf_requests_failed_total Total VRF requests that failed`,
    `# TYPE vrf_requests_failed_total counter`,
    `vrf_requests_failed_total ${m.requestsFailed}`,
    ``,
    `# HELP vrf_fulfill_duration_ms_avg Average fulfill() duration in ms`,
    `# TYPE vrf_fulfill_duration_ms_avg gauge`,
    `vrf_fulfill_duration_ms_avg ${m.avgFulfillDurationMs.toFixed(2)}`,
    ``,
    `# HELP vrf_drand_delays_total Times drand round was delayed`,
    `# TYPE vrf_drand_delays_total counter`,
    `vrf_drand_delays_total ${m.drandDelays}`,
    ``,
    `# HELP vrf_oracle_uptime_seconds Oracle uptime in seconds`,
    `# TYPE vrf_oracle_uptime_seconds gauge`,
    `vrf_oracle_uptime_seconds ${Math.floor((Date.now() - startTime) / 1000)}`,
    ``,
    `# HELP vrf_is_leader 1 if this instance is leader, 0 otherwise`,
    `# TYPE vrf_is_leader gauge`,
    `vrf_is_leader ${getLeaderState() === "leader" ? 1 : 0}`,
    ``,
    `# HELP vrf_listener_running 1 if an event listener session is running`,
    `# TYPE vrf_listener_running gauge`,
    `vrf_listener_running ${getListenerStatus().running ? 1 : 0}`,
    ``,
    `# HELP vrf_listener_restarts_total Listener sessions restarted after a crash`,
    `# TYPE vrf_listener_restarts_total counter`,
    `vrf_listener_restarts_total ${getListenerStatus().restarts}`,
    ``,
    `# HELP vrf_fee_guard_deferred_total Requests deferred by the fee guard (balance floor or unpaid cap)`,
    `# TYPE vrf_fee_guard_deferred_total counter`,
    `vrf_fee_guard_deferred_total ${fg.deferred}`,
    ``,
    `# HELP vrf_unpaid_fulfillments_total Fulfillments whose on-chain fee did not cover the network cost`,
    `# TYPE vrf_unpaid_fulfillments_total counter`,
    `vrf_unpaid_fulfillments_total ${fg.unpaidFulfilled}`,
    ...(fg.oracleBalanceStroops !== null
      ? [
          ``,
          `# HELP vrf_oracle_balance_stroops Last observed native balance of the oracle account`,
          `# TYPE vrf_oracle_balance_stroops gauge`,
          `vrf_oracle_balance_stroops ${fg.oracleBalanceStroops}`,
        ]
      : []),
  ].join("\n");

  res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
  res.end(lines);
}

function handleStatus(res: http.ServerResponse): void {
  const m = getMetrics();
  const body = {
    instance: getInstanceId(),
    role: getLeaderState(),
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    metrics: m,
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

export function stopHealthServer(): void {
  server?.close();
}
