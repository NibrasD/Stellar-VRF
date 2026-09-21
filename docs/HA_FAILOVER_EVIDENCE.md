# HA Failover Evidence

This document has two parts, and they prove **different** things. Please read the
scope of each before judging the Tranche 3 HA criterion.

| Part | What it proves | Status |
|---|---|---|
| **A. Mechanism drill** (automated, real Redis) | Election, split-brain resistance, takeover after hard failure, **fencing of a zombie primary** | ✅ **EXECUTED — 9/9 checks passed** |
| **B. Production two-host drill** | A standby on a *separate host* restoring real service, proven by a post-failover **Mainnet `fulfill()` TX** | ❌ **PENDING EXECUTION** |

**Part A does not substitute for Part B.** Part A proves the locking mechanism is
correct; only Part B proves end-to-end production service restoration. The Tranche 3
criterion is **not** satisfied until Part B is filled in.

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

# Part B — Production two-host drill (PENDING EXECUTION)

> **Status: PENDING EXECUTION.** Required by the Tranche 3 criterion *"Primary
> oracle worker running in production with hot-standby replica and automatic
> failover."*
>
> Current production state (verified over SSH): a **single** instance
> `oracle-primary` is running under PM2 on one 512 MB host, reporting
> `"role":"leader"`, and **`REDIS_URL` is not set** — so that host is using the
> single-node file-lock fallback. A second host and a shared Redis endpoint must be
> provisioned to execute this part.
>
> **Do not mark the criterion satisfied on the basis of Part A alone.**

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
