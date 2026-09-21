/**
 * failover_drill.mjs — Automated leader-election failover drill run against a
 * REAL Redis instance, exercising the same compiled `RedisLease` used in
 * production (`dist/redisLock.js`).
 *
 * What it proves:
 *   1. Initial election — exactly one leader.
 *   2. Split-brain resistance while the leader keeps renewing.
 *   3. Takeover after a hard failure (kill -9 semantics: renewals simply stop
 *      and the lease is NEVER gracefully released).
 *   4. Fencing — a resumed "zombie" primary CANNOT reclaim leadership, which is
 *      what prevents a double `fulfill()` submission.
 *   5. Graceful handback.
 *
 * Usage:
 *   docker run -d --name vrf-redis-drill -p 6399:6379 redis:7-alpine
 *   npm run build && node failover_drill.mjs
 *   REDIS_URL=redis://host:6379 node failover_drill.mjs   # custom endpoint
 *
 * Exit code 0 = all checks passed.
 *
 * SCOPE: this validates the distributed-lock/failover mechanism. It does NOT by
 * itself prove a post-failover Mainnet `fulfill()`; see
 * docs/HA_FAILOVER_EVIDENCE.md for the two-host production drill.
 */
import { RedisLease } from "./dist/redisLock.js";

const URL_ = process.env.REDIS_URL || "redis://127.0.0.1:6399";
const KEY = "vrf-oracle:leader:drill";
const TTL = 3000;          // short TTL so the drill is fast
const RENEW_EVERY = 1000;

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

const A = new RedisLease({ url: URL_, key: KEY, instanceId: "HOST_A", ttlMs: TTL });
const B = new RedisLease({ url: URL_, key: KEY, instanceId: "HOST_B", ttlMs: TTL });

let failures = 0;
const expect = (cond, msg) => { if (!cond) { failures++; log(`FAIL: ${msg}`); } else { log(`PASS: ${msg}`); } };

// ── Phase 1: initial election ────────────────────────────────────────────────
log("PHASE 1 — initial election");
expect(await A.acquireOrRenew() === true, "HOST_A acquired the lease (leader)");
expect(await B.acquireOrRenew() === false, "HOST_B denied the lease (standby)");

// ── Phase 2: split-brain resistance while A is alive ────────────────────────
log("PHASE 2 — split-brain resistance while A renews");
for (let i = 0; i < 3; i++) {
  await new Promise((r) => setTimeout(r, RENEW_EVERY));
  const aOk = await A.acquireOrRenew();
  const bOk = await B.acquireOrRenew();
  expect(aOk === true && bOk === false, `renew cycle ${i + 1}: A still leader, B still standby`);
}

// ── Phase 3: hard failure of A (stop renewing = kill -9) ────────────────────
log("PHASE 3 — simulating kill -9 on HOST_A (renewals stop, lease NOT released)");
const killedAt = Date.now();
let tookOverMs = null;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 250));
  if (await B.acquireOrRenew()) { tookOverMs = Date.now() - killedAt; break; }
}
expect(tookOverMs !== null, `HOST_B took over after stale lease expiry (${tookOverMs} ms)`);
expect(tookOverMs !== null && tookOverMs >= TTL - 500,
  "takeover waited for the TTL (no premature steal while A might still be alive)");

// ── Phase 4: zombie A must step down (fencing) ──────────────────────────────
log("PHASE 4 — HOST_A resumes as a zombie and must NOT reclaim leadership");
expect(await A.acquireOrRenew() === false, "zombie HOST_A fenced out (renew rejected, cannot double-submit)");
expect(await B.acquireOrRenew() === true, "HOST_B retains leadership");

// ── Phase 5: graceful handback ──────────────────────────────────────────────
log("PHASE 5 — graceful release by B, A may reacquire");
await B.release();
expect(await A.acquireOrRenew() === true, "HOST_A reacquired after graceful release");
expect(await B.acquireOrRenew() === false, "HOST_B now standby");

await A.release();
A.close(); B.close();

log(failures === 0 ? "DRILL RESULT: ALL CHECKS PASSED" : `DRILL RESULT: ${failures} CHECK(S) FAILED`);
console.log(JSON.stringify({ takeover_ms: tookOverMs, ttl_ms: TTL, failures }, null, 2));
process.exit(failures === 0 ? 0 : 1);
