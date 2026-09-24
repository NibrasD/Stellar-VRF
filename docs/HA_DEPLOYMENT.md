# HA Deployment Guide

## Architecture Overview

Production (Mainnet) topology — **primary and standby on separate hosts**,
coordinating through a shared Redis lease:

```
          ┌───────────────────────────────────────────────┐
          │              Shared Redis (lease)              │
          │   SET vrf-oracle:leader <instance> PX 30000 NX │
          └───────────────┬───────────────────────────────┘
                          │  (network — no shared filesystem needed)
          ┌───────────────┴───────────────────────┐
          │                                        │
  ┌───────▼─────────── HOST A ──┐        ┌─────────▼──────── HOST B ──┐
  │   oracle-primary  (LEADER)  │        │   oracle-standby (STANDBY) │
  │   :8080                     │        │   :8081                    │
  │ ✓ Holds Redis lease         │        │ ✗ Lease held by A          │
  │ ✓ Submits fulfill() TXs     │        │ ✗ No TX submission         │
  │ ✓ Renews lease every 10s    │        │ ✓ Attempts acquire every 5s│
  └─────────────────────────────┘        └────────────────────────────┘
                          │                        │
                          └───────────┬────────────┘
                                      │
                           ┌──────────▼──────────┐
                           │   Stellar Mainnet   │
                           │   VRF Contract      │
                           └─────────────────────┘
```

Two backends are selected automatically at runtime:

| Backend | When | Multi-host? |
|---|---|---|
| **Redis lease** (`src/redisLock.ts`) | `REDIS_URL` is set | ✅ Yes — **required on Mainnet / `NODE_ENV=production`** |
| **Atomic file lock** (`src/leader.ts`) | `REDIS_URL` is empty | ❌ Single host only — development fallback |

**Production rules (enforced at startup, `src/policy.ts`).** On Mainnet or with
`NODE_ENV=production` the worker refuses to start without `REDIS_URL`, and refuses a
plaintext `redis://` URL to a non-loopback host. Use `rediss://` (TLS). The only exception is
`REDIS_ALLOW_PLAINTEXT=true`, for Redis on an isolated private network such as the internal
network of `docker-compose.ha.yml` (Redis there is `expose`d only, never published).

**File fallback.** The file lock and the file spend ledger do their read → decide → write under a
cross-process mutex (`src/fileMutex.ts`, an exclusively-created `.mutex` file, broken only after
10 s so a crashed holder can't block forever). This closes the race where two standbys both saw a
stale lock and both took it, and the one where two processes both passed the spend-limit check.
It relies on atomic `O_EXCL` create + rename, which local filesystems provide but some network
filesystems don't — another reason it is a development fallback only.

## Leader Election Protocol (Redis, multi-server)

1. **Acquire**: `SET vrf-oracle:leader <instanceId> PX <ttl> NX` — atomic; only one node can win.
2. **Renew**: Leader runs a fenced Lua `pexpire` every `LEADER_HEARTBEAT_MS` (only if it still owns the key).
3. **Failover**: If the leader stops renewing, the key expires after `LEADER_LOCK_TTL_MS`; a standby's next `SET … NX` succeeds and it becomes leader.
4. **Release**: On shutdown the leader runs a fenced Lua `del` (only deletes the key if it still owns it), so a standby takes over immediately.
5. **Fail-closed**: Any Redis error makes `acquireOrRenew()` return `false` → the node drops to standby, so a Redis outage never produces two leaders.
   - **Every Redis command has a deadline** (default `min(5s, TTL/3)`). A hung Redis connection can't hold up a renewal forever. On timeout the socket is destroyed, because RESP replies are matched to commands by order, so a late reply can't be trusted. The client reconnects on the next command.
   - **Commands are serialised** (single-flight queue), so concurrent callers never interleave on one socket.
   - **Local lease deadline.** `isLeader()` doesn't rely on the *last renewal result*. After each successful acquire/renew the node records `leaseValidUntil = sentAt + TTL − LEADER_LEASE_SAFETY_MS`. `sentAt` is when the command was **sent**, not when it returned. When that deadline passes, `isLeader()` returns `false` immediately, even if the renewal call is still hanging. Redis can only expire the key *after* this local deadline, so a node never thinks it is leader while a standby could already hold the lease.
6. **Pre-submit leadership re-check**: leadership is re-verified **immediately before spending money**, not just when a request is picked up. Processing a request involves a long wait (a future drand round is tens of seconds away), during which a paused, partitioned or GC-stalled leader can legitimately lose its lease to the standby. `handleRequest()` therefore checks `isLeader()` (a) on entry, (b) after proof generation and immediately before `submitFulfillment()`, and (c) inside the retry callback, since each retry adds more delay. A node that lost the lease mid-flight discards the work instead of submitting.
7. **Defense-in-depth**: Even in a rare split, the on-chain contract rejects duplicate `fulfill()` (idempotency + re-entrancy guard), so double *fulfillment* is impossible. A duplicate *submission attempt* is still possible,
   and it costs a wasted fee (see below).

### What this guarantees — and what it does not

To be precise about the strength of the claim (see also
[`HA_FAILOVER_EVIDENCE.md`](HA_FAILOVER_EVIDENCE.md) § *Terminology*):

- ✅ **Correctness of the result** is guaranteed unconditionally, by the contract's
  on-chain `Fulfilled` flag — not by the lease. Two leaders cannot produce two
  different randomness values for one request.
- ✅ **Split-brain mitigation**: the Redis lease plus the pre-submit re-check means a
  zombie leader that wakes up after its lease expired stops before submitting, so
  duplicate transaction attempts and wasted fees are avoided in practice.
- ⚠️ **Not a fencing token.** There is no monotonic epoch number carried into the
  Stellar transaction and validated by the contract. The accurate description of this
  design is **lease-based split-brain mitigation + on-chain idempotency**, not
  "fencing" in the strict distributed-systems sense. The residual risk if a process
  freezes between the final `isLeader()` check and the RPC call is a *duplicate
  submission attempt* (rejected on-chain, wasted fee) — never a corrupted result.
- ⚠️ **Not a liveness guarantee.** HA removes the single-host point of failure. It does
  not guarantee that every request gets fulfilled: both hosts, Redis, the RPC or drand
  can be unavailable, and the fee guard and per-request send cap deliberately stop
  serving some requests. The fallback for requesters is `timeout_refund()`.

## Listener Supervision & Reconciliation

Holding the lease isn't enough. The leader must also be *processing requests*. A leader whose listener loop has died, while it keeps renewing the lease, is the worst failure mode because the standby never takes over. The worker handles this in four ways:

1. **Session-numbered listener** (`src/supervisor.ts`). Each leadership acquisition starts a new listener *session* with a monotonically increasing number. A loop keeps running only while `isCurrent(session) && isLeader()`. After a lose→regain leadership flap, the old loop sees it's no longer current and exits, so **two listener loops never run at the same time**.
2. **Crash recovery.** If the loop throws, for example after `LISTENER_MAX_POLL_FAILURES` consecutive failed RPC polls, the supervisor restarts it with exponential backoff (`LISTENER_RESTART_BASE_MS` → `LISTENER_RESTART_MAX_MS`). It doesn't restart if leadership was lost during the backoff.
3. **Demotion on repeated failure.** After `LISTENER_MAX_RESTARTS` crashes within `LISTENER_RESTART_WINDOW_MS`, the node calls `relinquishLeadership()`. This releases the Redis lease (fenced `del`) and enters a cooldown (`LEADER_RELINQUISH_COOLDOWN_MS`, default 2×TTL) during which it won't re-acquire, so the **standby takes over** instead of the broken node taking the lease back. An unexpected error inside the supervisor itself also triggers a relinquish.
4. **Reconciliation.** Event polling alone can miss requests: events that fell out of the RPC retention window during downtime, a crash between seeing an event and fulfilling it, or a failover. Reconciliation catches these. It runs **when each listener session starts** and **every `RECONCILE_INTERVAL_MS`** (default 120s) while leader. It reads the on-chain `Counter`, then batch-reads `Fulfilled` / `Refunded` / `RequestRound` for the newest `RECONCILE_MAX_SCAN` request IDs (newest first, ≤150 ledger keys per `getLedgerEntries` call). Every ID that is neither fulfilled nor refunded is handed to the normal fulfillment path. The on-chain `Fulfilled` flag makes this idempotent.

   > Each pass also checks **one more window of older IDs**, with a cursor that walks down to ID 1 and then wraps. The newest `RECONCILE_MAX_SCAN` IDs are checked every pass, and every older ID at least once every `ceil(older IDs / RECONCILE_MAX_SCAN)` passes, so no pending request stays undiscovered after a long outage, whatever the request volume. The cursor is in memory; after a restart it starts from the top again, which only re-checks IDs.

**Pre-submit gate inside retries.** `submitFulfillment()` takes a `canSubmit` callback (wired to `isLeader()`) and checks it before **every** internal attempt, including simulate/send retries. A node that loses the lease mid-retry throws `FulfillAbortedError`, and the outer retry wrapper does not retry that error.

**Health.** A LEADER reports `degraded` on `/health` if no listener session is running, or if the listener made no progress (successful poll or reconciliation) for `HEALTH_LISTENER_STALE_MS`. A grace period of `HEALTH_LISTENER_GRACE_MS` applies after a session starts. Alert on this. It is exactly the "leader holds the lease but isn't working" case.

## Failover Timing

| Event | Time |
|---|---|
| Primary crashes | T+0 |
| Lock becomes stale | T+30s (LOCK_TTL) |
| Standby detects stale lock | T+30-35s |
| Standby acquires lock | T+35s |
| Standby starts fulfilling | T+35s |
| **Maximum gap in service** | **~35 seconds** |

## Single-Host Demo

`docker-compose.ha.yml` bundles Redis + primary + standby on one machine:

```bash
docker compose -f docker-compose.ha.yml up -d
```

## Multi-Host Production Setup (recommended for Mainnet)

For true geographic redundancy, run one Redis reachable by both hosts and set
the SAME `REDIS_URL` on each oracle. No shared filesystem is required.

```bash
# 1. Provision a managed/HA Redis (or self-host) reachable by both oracle hosts.

# 2. On HOST A (.env):
INSTANCE_ID=oracle-primary
REDIS_URL=rediss://:password@redis.internal:6380    # TLS — required across hosts
HEALTH_PORT=8080

# 3. On HOST B (.env):
INSTANCE_ID=oracle-standby
REDIS_URL=rediss://:password@redis.internal:6380    # same Redis
HEALTH_PORT=8080

# 4. Start the worker on each host:
npm install && npm run build && node dist/index.js
```

Whichever node acquires the Redis lease becomes the sole leader/submitter; the
other automatically takes over if the leader dies. The Redis client is
implemented over a raw TCP RESP socket in `src/redisLock.ts` — **no extra npm
dependency is required** (works with `rediss://` for TLS too).

## Monitoring HA State

```bash
# Both instances
watch -n 5 'curl -s http://localhost:8080/status | jq .role; \
            curl -s http://localhost:8081/status | jq .role'
```

Expected output:
```
"leader"
"standby"
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `INSTANCE_ID` | `oracle-<pid>` | Unique name for this node |
| `REDIS_URL` | *(empty)* | If set, use the distributed Redis lease (multi-host). Empty = file lock. |
| `LEADER_REDIS_KEY` | `vrf-oracle:leader` | Redis key holding the leader lease |
| `LEADER_LOCK_FILE` | `/tmp/vrf-oracle.lock` | Lock file (single-host fallback only) |
| `LEADER_LOCK_TTL_MS` | `30000` | Lease/lock expiry in ms |
| `LEADER_HEARTBEAT_MS` | `10000` | How often the leader renews |
| `LEADER_POLL_MS` | `5000` | How often a standby tries to acquire |
| `LEADER_LEASE_SAFETY_MS` | `TTL/5` | `isLeader()` fails closed this long before the lease could expire |
| `LEADER_RELINQUISH_COOLDOWN_MS` | `2×TTL` | No re-acquire for this long after voluntarily relinquishing |
| `LISTENER_MAX_POLL_FAILURES` | `20` | Consecutive failed polls before the listener loop throws |
| `LISTENER_MAX_RESTARTS` | `5` | Crashes within the window before leadership is relinquished |
| `LISTENER_RESTART_WINDOW_MS` | `600000` | Sliding window for counting listener crashes |
| `LISTENER_RESTART_BASE_MS` / `LISTENER_RESTART_MAX_MS` | `2000` / `60000` | Restart backoff (exponential, capped) |
| `RECONCILE_MAX_SCAN` | `1000` | Newest request IDs re-checked per reconciliation |
| `RECONCILE_INTERVAL_MS` | `120000` | Periodic reconciliation interval while leader |
| `HEALTH_LISTENER_STALE_MS` | `120000` | Leader is degraded if the listener made no progress for this long |
| `HEALTH_LISTENER_GRACE_MS` | `60000` | Grace period after a listener session starts |
| `HEALTH_PORT` | `8080` | HTTP health/metrics port |
