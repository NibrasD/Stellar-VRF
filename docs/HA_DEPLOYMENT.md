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
| **Redis lease** (`src/redisLock.ts`) | `REDIS_URL` is set | ✅ Yes — production |
| **Atomic file lock** (`src/leader.ts`) | `REDIS_URL` is empty | ❌ Single host / shared volume only |

## Leader Election Protocol (Redis, multi-server)

1. **Acquire**: `SET vrf-oracle:leader <instanceId> PX <ttl> NX` — atomic; only one node can win.
2. **Renew**: Leader runs a fenced Lua `pexpire` every `LEADER_HEARTBEAT_MS` (only if it still owns the key).
3. **Failover**: If the leader stops renewing, the key expires after `LEADER_LOCK_TTL_MS`; a standby's next `SET … NX` succeeds and it becomes leader.
4. **Release**: On shutdown the leader runs a fenced Lua `del` (only deletes the key if it still owns it), so a standby takes over immediately.
5. **Fail-closed**: Any Redis error makes `acquireOrRenew()` return `false` → the node drops to standby, so a Redis outage never produces two leaders.
6. **Pre-submit leadership re-check**: leadership is re-verified **immediately before spending money**, not just when a request is picked up. Processing a request involves a long wait (a future drand round is tens of seconds away), during which a paused, partitioned or GC-stalled leader can legitimately lose its lease to the standby. `handleRequest()` therefore checks `isLeader()` (a) on entry, (b) after proof generation and immediately before `submitFulfillment()`, and (c) inside the retry callback, since each retry adds more delay. A node that lost the lease mid-flight discards the work instead of submitting.
7. **Defense-in-depth**: Even in a rare split, the on-chain contract rejects duplicate `fulfill()` (idempotency + re-entrancy guard), so double-submission is impossible.

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
REDIS_URL=redis://:password@redis.internal:6379
HEALTH_PORT=8080

# 3. On HOST B (.env):
INSTANCE_ID=oracle-standby
REDIS_URL=redis://:password@redis.internal:6379   # same Redis
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
| `HEALTH_PORT` | `8080` | HTTP health/metrics port |
