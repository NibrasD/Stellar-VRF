# HA Failover Evidence

This document has two parts, and they prove **different** things. Please read the
scope of each before judging the Tranche 3 HA criterion.

| Part | What it proves | Status |
|---|---|---|
| **A. Mechanism drill** (automated, real Redis) | Election, split-brain resistance, takeover after hard failure, **fencing of a zombie primary** | ✅ **EXECUTED — 9/9 checks passed** |
| **B. Production two-host drill** | A standby on a *separate host* restoring real service, proven by a post-failover **Mainnet `fulfill()` TX** | ✅ **EXECUTED — 2026-09-21** |

Both parts are now complete. Part B is the one that satisfies the Tranche 3
criterion *"Primary oracle worker running in production with hot-standby replica
and automatic failover"* — see the Mainnet transaction hashes below.

---

# Part A — Mechanism drill (EXECUTED)

Automated and repeatable via `oracle-worker/failover_drill.mjs`, exercising the
**same compiled `RedisLease`** the oracle uses in production (`dist/redisLock.js`)
against a **real Redis server** (not a mock).

```bash
docker run -d --name vrf-redis-drill -p 6399:6379 redis:7-alpine
cd oracle-worker && npm run build && node failover_drill.mjs
```

This drill now runs on **every CI run** (`oracle-worker` job, with a `redis:7-alpine`
service container), so a regression in the failover logic fails the build.

### Result

```
PHASE 1 — initial election
PASS: HOST_A acquired the lease (leader)
PASS: HOST_B denied the lease (standby)
PHASE 2 — split-brain resistance while A renews
PASS: renew cycle 1: A still leader, B still standby
PASS: renew cycle 2: A still leader, B still standby
PASS: renew cycle 3: A still leader, B still standby
PHASE 3 — simulating kill -9 on HOST_A (renewals stop, lease NOT released)
PASS: HOST_B took over after stale lease expiry (3025 ms)
PASS: takeover waited for the TTL (no premature steal while A might still be alive)
PHASE 4 — HOST_A resumes as a zombie and must NOT reclaim leadership
PASS: zombie HOST_A fenced out (renew rejected, cannot double-submit)
PASS: HOST_B retains leadership
PHASE 5 — graceful release by B, A may reacquire
PASS: HOST_A reacquired after graceful release
PASS: HOST_B now standby
DRILL RESULT: ALL CHECKS PASSED
{ "takeover_ms": 3025, "ttl_ms": 3000, "failures": 0 }
```

| Metric | Value |
|---|---|
| Checks passed | **9 / 9** |
| Lease TTL | 3,000 ms (drill value; production default is longer) |
| **Measured takeover time** | **3,025 ms** (repeat runs: 3,175 / 3,187 / 3,191 ms) |
| Premature steal while primary alive | **none** (Phase 2) |
| Zombie primary reclaimed leadership | **no** — fenced (Phase 4) |
| Redis | real `redis:7-alpine` server |

**Why Phase 4 matters most.** Both instances share one oracle key, so the real risk
is a *double* `fulfill()`. Phase 4 proves the fenced Lua renew (`GET == instanceId`
before `PEXPIRE`) makes a resumed primary step down instead of continuing to submit.
Combined with the on-chain `is_fulfilled()` idempotency check, that is two
independent defenses against double submission.

---

# Part B — Production two-host drill (EXECUTED ✅)

Executed **2026-09-21** on two separate DigitalOcean droplets coordinating
through a shared, password-protected Redis instance.

## Topology

| Role | Host | Instance ID | Notes |
|---|---|---|---|
| Primary (HOST A) | `165.245.245.101` (`fra1`) | `oracle-118262` | also runs Redis 7.0.15 |
| Standby (HOST B) | `64.226.86.16` (`fra1`) | `oracle-9981` | connects to A's Redis over the network |

Both workers run commit `cde82d9`, Node v22.23.2, under PM2, with
`REDIS_URL=redis://:<password>@165.245.245.101:6379` and
`LEADER_REDIS_KEY=vrf-oracle:leader`. Redis is firewalled so **only HOST B** can
reach port 6379:

```
[1] 6379/tcp   ALLOW IN    64.226.86.16
[3] 6379/tcp   DENY IN     Anywhere
```

Both instances confirmed the distributed backend at startup:

```
[Leader] Starting election. Instance: oracle-118262, backend: redis (multi-server), TTL: 30000ms
[Leader] oracle-118262 is now the LEADER.
```

## Timeline

| # | Time (UTC) | Event |
|---|---|---|
| 1 | 20:17:31 | HOST A elected leader (`redis (multi-server)`, TTL 30 s); HOST B reports `"role":"standby"` |
| 2 | 20:24:01 | **`kill -9` on HOST A** (PID 118262) — lease deliberately *not* released |
| 3 | ~20:24:31 | Lease TTL expires; **HOST B becomes leader** (`"role":"leader"`) |
| 4 | 20:29:33 | **New Mainnet `request()`** submitted *after* the failure → request **#18** |
| 5 | 20:29:39 | HOST B: `Submitting fulfill for request 18 (attempt 1/5)…` |
| 6 | 20:29:44 | HOST B: `Request 18 fulfilled! TX: fafa522f…` (5,599 ms) |
| 7 | ~20:31 | HOST A restarted → comes back as **`"role":"standby"`** (fenced, did **not** reclaim) |

## Mainnet transaction evidence

| Item | Value |
|---|---|
| Post-failover **request** TX | [`6329d2b7cfc35fb51952d09a48830c2bbc2c51febe2bfd2e1cccc65a7bb77597`](https://stellar.expert/explorer/public/tx/6329d2b7cfc35fb51952d09a48830c2bbc2c51febe2bfd2e1cccc65a7bb77597) |
| — status / ledger / fee | `successful: true` / `64547359` / 1,121,653 stroops |
| **Request ID** | **#18** |
| Post-failover **`fulfill()`** TX (submitted by HOST B) | [`fafa522f31355e755d107eaeabe36c4e37a6b48baf794de42d402188b5de78b0`](https://stellar.expert/explorer/public/tx/fafa522f31355e755d107eaeabe36c4e37a6b48baf794de42d402188b5de78b0) |
| — status / ledger / fee | `successful: true` / `64547361` / 1,387,682 stroops |
| End-to-end latency (request → fulfilled) | **10 s** |
| On-chain `fulfill()` execution time | 5,599 ms |

HOST B's health endpoint after the drill — note `requests_fulfilled: 1`, proving
the standby (not the dead primary) did the work:

```json
{
  "status": "ok",
  "instance": "oracle-9981",
  "role": "leader",
  "requests_fulfilled": 1,
  "requests_failed": 0,
  "last_fulfill_at": "2026-09-21T20:29:44.422Z"
}
```

## Results

| Check | Result |
|---|---|
| Initial roles correct (A leader / B standby) | ✅ |
| Failover triggered by **hard kill** (not graceful stop) | ✅ |
| Standby took over automatically | ✅ (lease TTL 30 s) |
| **Service actually restored** — post-failover Mainnet `fulfill()` | ✅ `fafa522f…` |
| Restarted primary stepped down (fenced) | ✅ came back as `standby` |
| Lease owner after drill (`GET vrf-oracle:leader`) | `oracle-9981` (HOST B) |
| Double submission for the same request | ✅ **none** — `requests_fulfilled: 1` on B, `0` on A |
| Requests failed | **0** |

## Reproducing

```bash
# roles
curl -s http://165.245.245.101:8080/health   # leader
curl -s http://64.226.86.16:8080/health      # standby

# hard-kill the primary
ssh root@165.245.245.101 'kill -9 $(pm2 pid oracle-primary)'

# watch the standby take over, then create a new mainnet request
ssh root@64.226.86.16 'cd /root/Stellar-VRF/oracle-worker && node mainnet_proof_of_operation.mjs'
```

## Why an on-chain TX is the required artifact

A `/health` endpoint flipping to `leader` only proves the *lease* moved. The decisive
proof that the standby actually **restored service** is a `fulfill()` transaction,
submitted by HOST B, confirmed on Mainnet, for a request created *after* HOST A died.

## Drill procedure

```bash
# 1. Confirm initial roles
curl -s http://HOST_A:8080/health   # expect: "role":"leader"
curl -s http://HOST_B:8080/health   # expect: "role":"standby"

# 2. Hard-kill the primary (do not graceful-stop — that releases the lease cleanly
#    and would not exercise the stale-lease takeover path)
ssh HOST_A 'sudo kill -9 $(pgrep -f "node dist/index.js")'

# 3. Watch the standby take over (lease TTL must expire first)
watch -n1 'curl -s http://HOST_B:8080/health'   # expect: "role":"leader"

# 4. Create a NEW request on Mainnet (post-failover)
cd oracle-worker && node mainnet_proof_of_operation.mjs

# 5. Confirm HOST B fulfilled it
curl -s http://HOST_B:8080/metrics | grep vrf_fulfillments_total
```

## Evidence to record

| Field | Value |
|---|---|
| Drill timestamp (UTC) | _TBD_ |
| Primary host (A) | _TBD_ |
| Standby host (B) | _TBD_ |
| Redis endpoint | _TBD_ |
| Lease TTL / renew interval | _TBD_ |
| Initial role — HOST A | _TBD (expect `leader`)_ |
| Initial role — HOST B | _TBD (expect `standby`)_ |
| HOST A kill time | _TBD_ |
| HOST B takeover time | _TBD_ |
| **Measured failover duration** | _TBD_ |
| Post-failover request ID | _TBD_ |
| **Post-failover `fulfill()` TX hash** | _TBD_ |
| stellar.expert link | _TBD_ |
| TX status | _TBD (must be `successful`)_ |
| Double-submission observed? | _TBD (must be `no`)_ |

## Split-brain check

Both instances share one oracle key, so a split brain could double-submit. Two
defenses must be confirmed during the drill:

1. **Fenced lease** — a resumed HOST A must fail its fenced renew and step down
   rather than keep submitting.
2. **On-chain idempotency** — `is_fulfilled()` is checked before submitting, so a
   duplicate `fulfill()` is skipped.

Record the outcome:

| Check | Result |
|---|---|
| Restarted HOST A stepped down (did not stay leader) | _TBD_ |
| No duplicate `fulfill()` TX for the same request ID | _TBD_ |
