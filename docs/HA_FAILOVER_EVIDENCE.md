# HA Failover Evidence

This document has two parts, and they prove **different** things. Please read the
scope of each before judging the Tranche 3 HA criterion.

| Part | What it proves | Status |
|---|---|---|
| **A. Mechanism drill** (automated, real Redis) | Election, split-brain resistance, takeover after hard failure, **fencing of a zombie primary** | ✅ **EXECUTED — 9/9 checks passed** |
| **B. Production two-host drill** | A standby on a *separate host* restoring real service, proven by a post-failover **Mainnet `fulfill()` TX** | ⚠️ Executed 2026-09-21 against the **earlier** Mainnet contract `CCN75KEG…55G57` (superseded by Part C) |
| **C. Production two-host drill on the current contract `CAW6KECQ…UPRX`** | Hard-kill of the primary, automatic standby takeover, new request + standby `fulfill()` on the current contract | ✅ **EXECUTED — 2026-10-12** (request `a993bcbd…`, fulfill `63f8e2aa…`) |

> **Scope correction.** The Part B transactions below (request `6329d2b7…`,
> fulfill `fafa522f…`) invoked the earlier Mainnet instance
> `CCN75KEGLETGRTVJJDMXB2ZRQD6PC2S56VUOEKVLQPVEIJYGSOV55G57` (verified from the
> transaction's invoke-contract operation on Horizon), **not** the current
> production contract `CAW6KECQMHRTX2GS3JVHWBMOB5JNNOHNOCE635RQS4SWJ72YF56EUPRX`.
> Part B still demonstrates the HA mechanism on two real hosts, but it is **not**
> evidence about the current deployment. **Part C** repeats the drill against
> `CAW6…UPRX` and is the evidence for the Tranche 3 criterion *"Primary oracle
> worker running in production with hot-standby replica and automatic failover"*.

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
is a *double* `fulfill()`. Phase 4 proves the compare-and-set Lua renew
(`GET == instanceId` before `PEXPIRE`) makes a resumed primary step down instead of
continuing to submit. Combined with the on-chain `is_fulfilled()` idempotency check,
that is two independent defenses against double submission.

### Terminology — what "fenced" does and does not mean here

To be precise about the guarantee, because "fencing" has a stronger meaning in the
distributed-systems literature:

- **What this is:** a *lease* with **compare-and-set renew/release**. A worker that
  loses its lease can no longer renew or release it, and the worker also
  **re-checks leadership immediately before submitting** a `fulfill()` transaction
  (and again inside each retry) — see `oracle-worker/src/index.ts`.
- **What this is not:** a true **fencing token** passed to and validated by the
  resource being protected. The Stellar network does not receive a monotonically
  increasing epoch number and so cannot itself reject a stale leader's transaction.
- **Why the result is still safe:** correctness does not depend on the lease at all.
  The contract enforces single fulfillment via the on-chain `Fulfilled` flag, so a
  stale leader cannot corrupt or replace a result. The lease plus the pre-submit
  re-check exist to avoid *wasted fees and duplicate transaction attempts*, not to
  protect randomness integrity.

Accurate one-line description: **lease-based split-brain mitigation with a
pre-submit leadership re-check, backed by on-chain idempotency.**

---

# Part B — Production two-host drill (executed, earlier contract)

Executed **2026-09-21** on two separate DigitalOcean droplets coordinating
through a shared, password-protected Redis instance. **Target contract:
`CCN75KEG…55G57` (earlier Mainnet instance), not the current `CAW6…UPRX`.**

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

---

# Part C — Re-run against the current contract `CAW6KECQ…UPRX` (EXECUTED ✅ 2026-10-12)

Executed **2026-10-12 (UTC)** on the same two production hosts, against the
current Mainnet contract
`CAW6KECQMHRTX2GS3JVHWBMOB5JNNOHNOCE635RQS4SWJ72YF56EUPRX`. Both workers have
`CONTRACT_ADDRESS` set to that value in `oracle-worker/.env` (checked on each
host), and both transactions below were verified on Horizon to invoke that
contract. All output below is copied from the live run, not reconstructed.

> **Note on the request script.** `mainnet_proof_of_operation.mjs` has a
> hardcoded legacy `CONTRACT_ID` (`CBTCC5QL…`) and must **not** be used for this
> drill. The request was created with the new
> `oracle-worker/failover_drill_request.mjs`, which reads `CONTRACT_ADDRESS`
> from `.env` (no hardcoded id) and prints the contract it targets.

## Worker commit on both hosts

| | HOST A (primary) `165.245.245.101` | HOST B (standby) `64.226.86.16` |
|---|---|---|
| `git rev-parse HEAD` | `1758bf8c1a589f5a418007ab59fbb3c7617cce2f` | `1758bf8c1a589f5a418007ab59fbb3c7617cce2f` |
| Commit | `feat(mainnet): migrate to new contract CBTCC5QL...TSUHU` (2026-09-22) | same |
| `CONTRACT_ADDRESS` | `CAW6KECQ…UPRX` | `CAW6KECQ…UPRX` |
| Uncommitted changes | `M oracle-worker/package-lock.json` | `M oracle-worker/package-lock.json` (+ `failover_drill_request.mjs` copied for this drill) |
| pm2 process | `oracle-primary`, pid 160853, up 18 d | `oracle-standby`, pid 61493, up 18 d |

Both hosts run the **identical** commit. **Disclosure:** that commit is **not**
an ancestor of the current repository `HEAD` (`d7a65b3`); `HEAD` is 80 commits
ahead and touches 33 files under `oracle-worker/src` (later audit fixes such as
the spend ledger, send-attempt cap and supervisor). So the hosts run the
`CAW6…UPRX`-configured worker as deployed on 2026-09-24, **not** the latest
source. Redeploying both hosts to a current commit and repeating this drill is
the remaining follow-up if the reviewer requires the latest source in production.

## Timeline (UTC, 2026-10-12)

| Time | Event |
|---|---|
| 20:21:17 | Before: HOST A `"role":"leader"` (`oracle-160853`, `requests_fulfilled: 3`); HOST B `"role":"standby"` (`oracle-61493`, `requests_fulfilled: 0`) |
| 20:24:21.816 | **`kill -9` on HOST A** (pid 160853), lease not released. Process gone; `/health` no response |
| 20:24:21.692 | HOST B `/health` still `"role":"standby"` |
| 20:24:52.328 | HOST B log: `[Leader] oracle-61493 is now the LEADER.` then `Became LEADER — starting event listener.` |
| 20:24:54.080 | HOST B `/health` → `"role":"leader"` |
| 20:25:12 | **New `request()` — request #6 on `CAW6…UPRX`**, created *after* the takeover |
| 20:25:24.5 | HOST B: `VRF proof generated for request 6, round 33011118`, then `Submitting fulfill for request 6 (attempt 1/5)…` |
| 20:25:29.061 | HOST B: `Request 6 fulfilled! TX: 63f8e2aa…` |
| 20:25:49.886 | HOST A restarted (`pm2 restart`) |
| 20:25:53.516 | HOST A log: `[Leader] oracle-387162 is STANDBY. Watching for leader failure.` |

## Transactions (verified on Horizon against `CAW6…UPRX`)

| Item | Value |
|---|---|
| New **request** TX (request #6) | [`a993bcbddbae89ff1be64d9c65a52c3c70a11503fa0d107b36470cc44c72de40`](https://stellar.expert/explorer/public/tx/a993bcbddbae89ff1be64d9c65a52c3c70a11503fa0d107b36470cc44c72de40) |
| — result | `successful: true`, ledger `64910186`, 2026-10-12T20:25:12Z, fee 1,066,227 stroops |
| — contract / function | `CAW6KECQMHRTX2GS3JVHWBMOB5JNNOHNOCE635RQS4SWJ72YF56EUPRX` / `request` |
| Standby **`fulfill()`** TX (submitted by HOST B) | [`63f8e2aa4b1ce9a2ddaeea1f33ac1d90b5d3589bfa3d7e1628fb4190271358e7`](https://stellar.expert/explorer/public/tx/63f8e2aa4b1ce9a2ddaeea1f33ac1d90b5d3589bfa3d7e1628fb4190271358e7) |
| — result | `successful: true`, ledger `64910189`, 2026-10-12T20:25:27Z, fee 1,518,559 stroops |
| — contract / function | `CAW6KECQMHRTX2GS3JVHWBMOB5JNNOHNOCE635RQS4SWJ72YF56EUPRX` / `fulfill` |
| Worker-reported duration | 15,671 ms (request seen → fulfilled) |


## Health output

Before (20:21:17 UTC) — HOST A `/health`:

```json
{ "status": "ok", "instance": "oracle-160853", "role": "leader", "uptime_seconds": 1557617,
  "requests_fulfilled": 3, "requests_failed": 0, "last_fulfill_at": "2026-10-08T14:03:43.796Z" }
```

HOST B `/health` after takeover and after the fulfillment (20:25:49 UTC):

```json
{ "status": "ok", "instance": "oracle-61493", "role": "leader", "uptime_seconds": 1558104,
  "requests_fulfilled": 1, "requests_failed": 0, "last_fulfill_at": "2026-10-12T20:25:29.061Z" }
```

`requests_fulfilled` on HOST B went `0 → 1`: the standby, not the dead primary,
fulfilled request #6. HOST A `/health` 12 s after `pm2 restart`:

```json
{ "status": "ok", "instance": "oracle-387162", "role": "standby", "uptime_seconds": 9,
  "requests_fulfilled": 0, "requests_failed": 0, "last_fulfill_at": null }
```

## Results

| Check | Result |
|---|---|
| Initial roles correct (A leader / B standby) | ✅ |
| Primary **hard-killed** (`kill -9`, lease not released) | ✅ |
| Standby became leader automatically, no operator action | ✅ log line 30.5 s after the kill, `/health` showed `leader` at 32.3 s (lease TTL 30 s) |
| New request created **after** takeover, on `CAW6…UPRX` | ✅ #6, TX `a993bcbd…` |
| Standby submitted `fulfill()` on `CAW6…UPRX` | ✅ TX `63f8e2aa…`, `successful: true` |
| Restarted primary came back as standby (did not reclaim) | ✅ |
| Double submission | ✅ none — A `requests_fulfilled: 0`, B `1`; one fulfill TX |
| Requests failed | **0** |

**Operator action disclosed:** right after the `kill -9`, `pm2 stop oracle-primary`
was issued so pm2 could not auto-restart the primary and race the standby. The
kill itself was `kill -9` with no lease release; the takeover was by lease expiry.

**Not captured:** the raw `GET vrf-oracle:leader` lease value (no `redis-cli` on
HOST B; the credentialed call from HOST A was rejected). Lease ownership is shown
through each worker's own `[Leader]` log lines and `/health` instead.

**End state left in production:** HOST B (`oracle-standby`) is the **leader**;
HOST A (`oracle-primary`) is the **standby**. Roles are interchangeable; no action
is required unless you want A to lead again.


## Capture sequence used (for repeating)

```bash
# 0. commit + config on BOTH hosts
for H in 165.245.245.101 64.226.86.16; do
  ssh root@$H 'hostname; cd /root/Stellar-VRF && git rev-parse HEAD; grep -E "^CONTRACT_ID" oracle-worker/.env'
done

# 1. roles before
curl -s http://165.245.245.101:8080/health | tee roles_before_A.json   # expect "role":"leader"
curl -s http://64.226.86.16:8080/health    | tee roles_before_B.json   # expect "role":"standby"

# 2. hard-kill the primary
ssh root@165.245.245.101 'date -u +%T; kill -9 $(pm2 pid oracle-primary)'

# 3. role change on the standby (TTL 30 s) — keep the log lines
ssh root@64.226.86.16 'pm2 logs oracle-standby --lines 50 --nostream | grep -E "LEADER|Starting listener|Became"'
curl -s http://64.226.86.16:8080/health | tee roles_after_B.json       # expect "role":"leader"

# 4. NEW request on CAW6…UPRX, after the failover (run on HOST B; reads CONTRACT_ADDRESS from .env)
cd oracle-worker && node failover_drill_request.mjs                    # prints REQUEST_TX / REQUEST_ID

# 5. standby fulfils it
ssh root@64.226.86.16 'pm2 logs oracle-standby --lines 80 --nostream | grep -E "Submitting fulfill|fulfilled"'
curl -s http://64.226.86.16:8080/health      # requests_fulfilled >= 1

# 6. restarted primary must come back as standby
ssh root@165.245.245.101 'pm2 restart oracle-primary'; sleep 5
curl -s http://165.245.245.101:8080/health                              # expect "role":"standby"
```

### Part C evidence summary

| Field | Value |
|---|---|
| Contract under test | `CAW6KECQMHRTX2GS3JVHWBMOB5JNNOHNOCE635RQS4SWJ72YF56EUPRX` |
| Worker commit — HOST A | `1758bf8c1a589f5a418007ab59fbb3c7617cce2f` |
| Worker commit — HOST B | `1758bf8c1a589f5a418007ab59fbb3c7617cce2f` (identical) |
| Roles before kill | A `leader` (`oracle-160853`), B `standby` (`oracle-61493`) |
| Roles after takeover | B `leader` — log `20:24:52.328Z`, `/health` `20:24:54.080Z`; A down |
| New request TX / request ID | `a993bcbd…de40` / #6 |
| Standby `fulfill()` TX | `63f8e2aa…58e7` |
| Both TXs confirmed against `CAW6…UPRX`? | Yes — Horizon invoke-contract operation, both `successful: true` |
| Restarted primary came back as standby? | Yes — `oracle-387162`, `"role":"standby"` |

## Drill procedure (generic template)

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

## Evidence record — Part C (current contract `CAW6…UPRX`)

| Field | Value |
|---|---|
| Drill timestamp (UTC) | 2026-10-12, 20:21 – 20:26 |
| Primary host (A) | `165.245.245.101` (`oracle-primary`) |
| Standby host (B) | `64.226.86.16` (`oracle-standby`) |
| Redis | shared, password-protected; `REDIS_URL` set on both hosts, backend logged as `redis (multi-server)`. Host/port not re-queried in this run (see Part B topology) |
| Lease TTL / renew interval | TTL `30000 ms` (from worker log). `LEADER_HEARTBEAT_MS` is not set in `.env`, so the worker default applies |
| Initial role — HOST A | `leader` |
| Initial role — HOST B | `standby` |
| HOST A kill time | `20:24:21.816Z` (`kill -9`) |
| HOST B takeover time | log `20:24:52.328Z`; `/health` `leader` at `20:24:54.080Z` |
| **Measured failover duration** | **30.5 s** (kill → leader log line); 32.3 s until `/health` reported `leader` |
| Post-failover request ID | #6 |
| **Post-failover `fulfill()` TX hash** | `63f8e2aa4b1ce9a2ddaeea1f33ac1d90b5d3589bfa3d7e1628fb4190271358e7` |
| stellar.expert link | https://stellar.expert/explorer/public/tx/63f8e2aa4b1ce9a2ddaeea1f33ac1d90b5d3589bfa3d7e1628fb4190271358e7 |
| TX status | `successful: true`, ledger 64910189 |
| Double-submission observed? | **No** |

## Split-brain check — Part C outcome

Both instances share one oracle key, so a split brain could double-submit. Two
defenses:

1. **Fenced lease** — a resumed HOST A must fail its fenced renew and step down
   rather than keep submitting.
2. **On-chain idempotency** — `is_fulfilled()` is checked before submitting, so a
   duplicate `fulfill()` is skipped.

| Check | Result |
|---|---|
| Restarted HOST A stepped down (did not stay leader) | Yes — came back `standby`, did not reclaim the lease while B held it |
| No duplicate `fulfill()` TX for the same request ID | Yes — one fulfill TX for #6, from HOST B; HOST A `requests_fulfilled: 0` |

The on-chain idempotency path (`is_fulfilled()` rejecting a second `fulfill()`)
was **not** exercised live in this drill; it is covered by the contract tests.
