# HA Failover Evidence — Production Drill

> **Status: PENDING EXECUTION.** This document is the evidence template for the
> production failover drill required by the Tranche 3 completion criterion
> *"Primary oracle worker running in production with hot-standby replica and
> automatic failover."*
>
> Code-level HA is implemented and unit-tested (Redis `SET NX PX` lease with fenced
> Lua renew/release, fail-closed, automatic takeover — see
> [`HA_DEPLOYMENT.md`](HA_DEPLOYMENT.md) and `oracle-worker/src/redisLock.ts`).
> **This file must be filled in with a real two-host drill before Tranche 3 is
> claimed complete.** Do not mark the criterion satisfied on the basis of code alone.

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
