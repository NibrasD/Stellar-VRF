/**
 * health.ts — HTTP health check endpoint
 *
 * Exposes /health and /metrics endpoints for monitoring.
 * Load balancers and process managers (PM2, Docker) use /health.
 */

import http from "http";
import { getLeaderState, getInstanceId } from "./leader.js";
import { getMetrics } from "./metrics.js";

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

  server.listen(HEALTH_PORT, () => {
    console.log(`[Health] HTTP server listening on port ${HEALTH_PORT}`);
  });

  server.on("error", (err) => {
    console.error(`[Health] Server error: ${err.message}`);
  });
}

function handleHealth(res: http.ServerResponse): void {
  const leaderState = getLeaderState();
  const metrics = getMetrics();
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

  // Mark unhealthy if no successful fulfillments in 10 min and we are leader
  const isHealthy =
    leaderState === "leader" || leaderState === "standby" || leaderState === "unknown";

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
  };

  res.writeHead(isHealthy ? 200 : 503, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function handleMetrics(res: http.ServerResponse): void {
  // Prometheus text format
  const m = getMetrics();
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
    pid: process.pid,
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

export function stopHealthServer(): void {
  server?.close();
}
