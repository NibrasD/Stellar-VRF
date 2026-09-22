# Operational Procedures

This document covers day-to-day operational procedures for the Stellar VRF Oracle
on mainnet.

## Deployment

### Contract Addresses

| Network | Contract ID | Oracle Account |
|---|---|---|
| **Mainnet** | `CBTCC5QL5T3JSLEZO4PH6LSJYEQF6GEFDCAO67OXI4DTM5NXMK6TSUHU` | `GA6HYAVWPVOVB4XJHGUZSDHRVYOKLPU4JAHYPXZRSJWO2PM4HSCNKP5P` |
| Testnet | `CCOX44NFMB3G4TDOLG5EKCXBP3EZ5PCEC3SQNMWP24WG6BA6HCSU2CBE` | — |

### Mainnet Transaction Proof

| Transaction | Hash | Explorer |
|---|---|---|
| WASM Upload | `0b555662fcdf5083237b7ab337583cb9d8c8124deb4c1220a385745299702222` | [View](https://stellar.expert/explorer/public/tx/0b555662fcdf5083237b7ab337583cb9d8c8124deb4c1220a385745299702222) |
| Contract Deploy | `348f0fde4ac4954f4ebed808b1bba9dbdbf2137cbb29156f69188fc69fad3af1` | [View](https://stellar.expert/explorer/public/tx/348f0fde4ac4954f4ebed808b1bba9dbdbf2137cbb29156f69188fc69fad3af1) |
| Contract Init | `6e1c73daa40844480228de844f61d2fd56bca050965911d08eea090e1d03fbbc` | [View](https://stellar.expert/explorer/public/tx/6e1c73daa40844480228de844f61d2fd56bca050965911d08eea090e1d03fbbc) |
| First request() | `0051354cb715ce8af3f2d591d5f040441a41aa0531fdb96aa6d23126690c5cd3` | [View](https://stellar.expert/explorer/public/tx/0051354cb715ce8af3f2d591d5f040441a41aa0531fdb96aa6d23126690c5cd3) |
| First fulfill() | `f3e83555c54c33230627fd971aefca376f257dd053ca3cb5501f31f8476482bf` | [View](https://stellar.expert/explorer/public/tx/f3e83555c54c33230627fd971aefca376f257dd053ca3cb5501f31f8476482bf) |

## Starting the Oracle Worker

### Prerequisites

- Node.js ≥ 22.12.0 (required by `@stellar/stellar-sdk` v17 `engines.node`)
- Oracle account funded with XLM on mainnet
- `.env` file configured (see `.env.mainnet` template)

### Start Primary

```bash
cd oracle-worker
cp .env.mainnet .env
npx tsc --outDir dist
node dist/index.js
```

The worker will:
1. Print configuration
2. Start leader election. The backend is auto-selected by `src/leader.ts`:
   - **Production (multi-host):** Redis distributed lease (`SET NX PX` + fenced
     Lua renew/release) — used when `REDIS_URL` is set.
   - **Development (single host):** file-based lock — fallback when `REDIS_URL`
     is unset. Do **not** use this for production HA across two hosts.
3. If elected leader, begin polling for VRF request events
4. Automatically fulfill pending requests with BLS-VRF proofs
5. Health endpoint available at `http://localhost:8080/health`

### Start Hot-Standby Replica

**Production:** run the standby on a **separate host**, pointing at the same Redis
instance via `REDIS_URL`. See [HA_DEPLOYMENT.md](HA_DEPLOYMENT.md) for the
two-host topology. Running both instances on one server is a development-only
configuration and does not satisfy hot-standby requirements.

```bash
# On HOST B (standby) — same REDIS_URL as HOST A
node dist/index.js
```

The replica will:
1. Detect the existing leader lease
2. Enter standby mode, monitoring the lock heartbeat
3. Automatically take over if the primary's heartbeat is stale (>30s)
4. On-chain idempotency check (`is_fulfilled()`) prevents double-submission

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SOROBAN_RPC_URL` | No | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint |
| `NETWORK_PASSPHRASE` | No | Test SDF Network | Network passphrase |
| `CONTRACT_ADDRESS` | **Yes** | — | VRF oracle contract ID |
| `ORACLE_STELLAR_SECRET` | **Yes** | — | Oracle Ed25519 secret key |
| `ORACLE_BLS_SECRET_KEY` | **Yes** | — | Oracle BLS12-381 private scalar (hex) |
| `DRAND_API_URL` | No | `https://api.drand.sh` | drand HTTP API |
| `POLL_INTERVAL_MS` | No | `3000` | Event polling interval |
| `MAX_RETRIES` | No | `3` | Max fulfill retry attempts |
| `TX_FEE` | No | `1000000` | Transaction fee (stroops) |
| `LISTENER_MAX_POLL_FAILURES` | No | `20` | Consecutive failed polls before the listener restarts |
| `LISTENER_MAX_RESTARTS` / `LISTENER_RESTART_WINDOW_MS` | No | `5` / `600000` | Crash budget before relinquishing leadership |
| `LISTENER_RESTART_BASE_MS` / `LISTENER_RESTART_MAX_MS` | No | `2000` / `60000` | Listener restart backoff |
| `LEADER_LEASE_SAFETY_MS` | No | `TTL/5` | Local fail-closed margin before lease expiry |
| `LEADER_RELINQUISH_COOLDOWN_MS` | No | `2×TTL` | No re-acquire after relinquishing |
| `RECONCILE_MAX_SCAN` | No | `1000` | Newest request IDs re-checked on each reconciliation |
| `RECONCILE_INTERVAL_MS` | No | `120000` | Periodic reconciliation interval while leader |
| `HEALTH_LISTENER_STALE_MS` / `HEALTH_LISTENER_GRACE_MS` | No | `120000` / `60000` | Leader listener staleness threshold / grace |

Leader-election variables (`REDIS_URL`, `LEADER_LOCK_TTL_MS`, …) are listed in [HA_DEPLOYMENT.md](HA_DEPLOYMENT.md#environment-variables).

## Monitoring

### Health Check

```bash
curl http://localhost:8080/health
```

Returns HTTP **200** when healthy and **503** when degraded, with JSON:
- `status`: `"ok"` or `"degraded"` (plus `degraded_reason` when degraded)
- `role`: `"leader"`, `"standby"` or `"unknown"`
- `uptime_seconds`, `requests_fulfilled`, `requests_failed`, `last_fulfill_at`
- `listener`: `{ running, last_progress_at, restarts, last_error }`

A **standby is always healthy**. It's supposed to be idle. A **leader is degraded** when any of these is true:
- no listener session is running while it holds the lease;
- the listener made no progress (successful poll or reconciliation) for `HEALTH_LISTENER_STALE_MS` (default 120s, after a `HEALTH_LISTENER_GRACE_MS` 60s grace period from session start);
- requests are in flight but none completed within the stall threshold.

Point your load balancer / uptime monitor at `/health` and alert on non-200 from the **leader**.

### Prometheus Metrics (`/metrics`)

| Metric | Type | Alert on |
|---|---|---|
| `vrf_is_leader` | gauge | `sum(vrf_is_leader)` across instances ≠ 1 for > 1 min |
| `vrf_listener_running` | gauge | `vrf_is_leader == 1 and vrf_listener_running == 0` for > 1 min |
| `vrf_listener_restarts_total` | counter | `increase(...[10m]) > 2`. A flapping RPC endpoint, or a node about to relinquish |
| `vrf_requests_fulfilled_total` / `vrf_requests_failed_total` | counter | failure ratio rising |
| `vrf_fulfill_duration_ms_avg` | gauge | > 60000 |
| `vrf_drand_delays_total` | counter | sustained growth |

### Listener crash / relinquish behaviour

- Log `[Supervisor] Listener crashed (<error>). Restart i/N in Xms.` means the supervisor is recovering automatically. Look at `listener.last_error` on `/health`.
- Log `[Supervisor] Listener crashed K times within …s … Relinquishing leadership so the standby can take over.` means the listener crashed `LISTENER_MAX_RESTARTS` times within `LISTENER_RESTART_WINDOW_MS`. The node released the lease and won't re-acquire for `LEADER_RELINQUISH_COOLDOWN_MS`. **Confirm the standby became leader** (`/status` on both hosts), then investigate the relinquishing node's RPC connectivity.
- Log `Reconciliation found N unfulfilled request(s)` after a failover or restart is expected. These are requests whose events the previous leader never finished handling. If it keeps appearing on every periodic run, fulfillment is failing for those IDs. Check the logs for their `request_id`.

### Key Metrics to Watch

1. **XLM Balance** — Oracle account needs XLM for transaction fees
   - Alert if balance < 5 XLM
   - Each `fulfill()` costs ~0.14 XLM in fees (mainnet measured: 1,387,682 stroops
     = 0.1387682 XLM on TX
     [`fafa522f...`](https://stellar.expert/explorer/public/tx/fafa522f31355e755d107eaeabe36c4e37a6b48baf794de42d402188b5de78b0)).
     Budget ~0.15 XLM per fulfillment.

2. **Fulfill Latency** — Time from request event to fulfill TX confirmation
   - Normal: 5–15 seconds
   - Alert if > 60 seconds

3. **drand Availability** — The oracle depends on drand quicknet beacons
   - If drand is down, oracle cannot generate proofs
   - Retry logic handles temporary outages (up to MAX_RETRIES)

4. **drand Beacon Verification Failures** — the worker verifies every beacon's BLS
   signature locally before building a proof (`DRAND_VERIFY_BEACONS=true`, default).
   - Log signature: `drand BEACON VERIFICATION FAILED`
   - **One-off:** benign; `api.drand.sh` is load balanced and the retry hits a good node.
   - **Persistent:** treat as an incident. Either the relay is compromised/misbehaving,
     or `DRAND_PUBLIC_KEY` no longer matches `DRAND_CHAIN_HASH` (e.g. after a chain or
     group-key change). Re-fetch the key and compare:
     ```bash
     curl -s https://api.drand.sh/$DRAND_CHAIN_HASH/info | jq -r .public_key
     ```
     If drand rotated its group key, update **both** `DRAND_PUBLIC_KEY` (compressed,
     96 bytes) in the worker `.env` **and** the on-chain key via `rotate_drand_pk()`
     (uncompressed, 192 bytes) — see *Rotate drand Public Key* below.
   - Note this check protects **fees and CPU only**. The contract re-verifies drand
     on-chain, so a forged beacon can never yield accepted randomness.

5. **Instruction Budget** — Monitor `fulfill()` instruction count
   - Current: **58,073,400** (fee=0) / **58,342,003** (nonzero-fee)
   - Soroban protocol limit: **400,000,000** (85.4% headroom)
   - Internal target: 75,000,000 — alert if > 70,000,000 after contract upgrades
   - See [`PROFILING.md`](PROFILING.md) for the measurement method

## Key Rotation

### Rotate Oracle BLS Key

```bash
# Generate new BLS keypair
node -e "const { bls12_381 } = require('@noble/curves/bls12-381');
const sk = bls12_381.utils.randomPrivateKey();
console.log('Secret:', Buffer.from(sk).toString('hex'));
const pk = bls12_381.G2.ProjectivePoint.BASE.multiply(BigInt('0x' + Buffer.from(sk).toString('hex')));
console.log('Public (192 bytes):', Buffer.from(pk.toRawBytes(false)).toString('hex'));"

# Call rotate_oracle_keys() on-chain with new public key
# Update .env with new ORACLE_BLS_SECRET_KEY
# Restart worker
```

### Rotate drand Public Key

Only needed if drand quicknet rotates their key (extremely rare).

> **Scope: key rotation for the *same* chain only. This is not a chain migration.**
> `rotate_drand_pk()` replaces only the stored `DrandPK`. `DrandGenesis`, `DrandPeriod`, and the drand signature DST are fixed at `init()` or compiled into the contract. `DRAND_DST` is the quicknet `bls-unchained-g1-rfc9380` scheme (G1 signatures, unchained). The contract has no upgrade entrypoint. So you **can't** move an existing deployment to a drand chain with a different genesis time, period, or signature scheme by rotating the key. The pairing check would reject every beacon, or the round↔time mapping would be wrong. Switching chains means deploying and initializing a new contract instance and migrating consumers to it.

```bash
# Fetch new key from drand API
curl https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/info

# Call rotate_drand_pk() on-chain with new uncompressed G2 key (192 bytes)
```

Both sides must be updated, or the worker and the contract will disagree:

| Where | Value | Encoding |
| :--- | :--- | :--- |
| Contract `DrandPK` (via `rotate_drand_pk()`) | drand group key | **uncompressed** G2, 192 bytes |
| Worker `.env` → `DRAND_PUBLIC_KEY` | same key | **compressed** G2, 96 bytes (the `public_key` field from `/info`) |

Order of operations: rotate on-chain first, then update the worker `.env` and restart.
If only the worker is updated, every off-chain verification fails and no request is
fulfilled; if only the contract is updated, the worker keeps submitting proofs that
the contract rejects.

## Storage TTL Management

Soroban storage entries expire. The oracle worker extends TTLs during `fulfill()`:

- **Instance storage** (contract state): extended on every `fulfill()`
- **Request data**: extended to at least 100,000 ledgers (~5.7 days)
- **Proof cleanup**: `cleanup_proof()` (callable by the requester **or the oracle**)
  removes the proof, request context and callback metadata while retaining the
  `Fulfilled` flag. After cleanup, `get_proof()` / `derive_random()` for that
  request panic, so consumers must read or cache their result first.
- **Nothing is permanent**: every persistent entry, including `Fulfilled`, is
  subject to Soroban TTL and is archived if not extended. Results are durably
  verifiable through the `fulfill` transaction and its events, which are
  independent of contract storage.

Manual TTL extension is not typically needed if the oracle processes requests
regularly.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "txInsufficientBalance" | Oracle account low on XLM | Fund the oracle account |
| "is_fulfilled = true" (skip) | Another instance already fulfilled | Normal for HA — no action needed |
| "drand beacon not found" | drand round not yet available | Oracle retries automatically |
| "Leader lock stale" | Primary crashed | Standby takes over automatically |
| Worker starts but no events | No pending requests | Normal idle state |
