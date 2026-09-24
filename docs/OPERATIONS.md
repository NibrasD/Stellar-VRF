# Operational Procedures

This document covers day-to-day operational procedures for the Stellar VRF Oracle
on mainnet.

## Deployment

### Contract Addresses

| Network | Contract ID | Oracle Account |
|---|---|---|
| **Mainnet** | `CAW6KECQMHRTX2GS3JVHWBMOB5JNNOHNOCE635RQS4SWJ72YF56EUPRX` | `GA6HYAVWPVOVB4XJHGUZSDHRVYOKLPU4JAHYPXZRSJWO2PM4HSCNKP5P` |
| Testnet | `CBEDNSJ63LANUSJHRZSNQUV22X6JYU6E7PTUDIGQDOHNH7VIT4CAJTBR` | `GA6HYAVWPVOVB4XJHGUZSDHRVYOKLPU4JAHYPXZRSJWO2PM4HSCNKP5P` |

### Mainnet Transaction Proof

| Transaction | Hash | Explorer |
|---|---|---|
| WASM Upload | `fe1b7f85b738bdc65620bffd9f10abbfdf7995adfbb4a7a90803c3a17c6cf41b` | [View](https://stellar.expert/explorer/public/tx/fe1b7f85b738bdc65620bffd9f10abbfdf7995adfbb4a7a90803c3a17c6cf41b) |
| Contract Deploy & Atomic Config | `fccef97c5ec84a1a8f483aee779f925c819fab99e91edc692e56644d1089af50` | [View](https://stellar.expert/explorer/public/tx/fccef97c5ec84a1a8f483aee779f925c819fab99e91edc692e56644d1089af50) |
| Verified request() | `978297f0df8d9e6c7ec1167043127287404821758586573e97a99265aa167cae` | [View](https://stellar.expert/explorer/public/tx/978297f0df8d9e6c7ec1167043127287404821758586573e97a99265aa167cae) |
| Verified fulfill() | `e0cc4b6089b98300a7dfd230320fe5f37917a1dfd6ee034e762ccdf91d3a960b` | [View](https://stellar.expert/explorer/public/tx/e0cc4b6089b98300a7dfd230320fe5f37917a1dfd6ee034e762ccdf91d3a960b) |

### Reproducible contract build (pinned toolchain)

The Rust toolchain is pinned to **1.95.0** in [`rust-toolchain.toml`](../rust-toolchain.toml)
(with `clippy`, `rustfmt` and the `wasm32v1-none` target). rustup picks it up automatically
for every crate in the repo. CI installs the same version explicitly, and a CI step fails if
`ci.yml` and `rust-toolchain.toml` ever disagree. Changing the compiler changes the WASM bytes
and the measured CPU instruction counts, so bump it deliberately and re-record the hash below.

```bash
cd soroban-contract
cargo build --release --target wasm32v1-none
sha256sum target/wasm32v1-none/release/soroban_vrf_oracle.wasm
```

| Source | Toolchain | `soroban_vrf_oracle.wasm` SHA256 | Size |
|---|---|---|---|
| current `main` (callback isolation) | 1.95.0 | `feb19ddd87aa483af842853be5a870fc3543f424b84b4b62049c4b6e9362703a` | 53,045 B |

Two clean release builds on Windows produced this same hash (it was recorded for an earlier
revision of `main`; re-record it after contract changes). This hash is for the unoptimized
`cargo build` output.

The **deployed** contract (Mainnet `CAW6KECQ…UPRX` and Testnet `CBEDNSJ6…JTBR`) runs the
`stellar contract optimize` output, whose on-chain WASM hash is
`6a261a26976ca5a45c5bd23b545b0a83faec363b3de132a882cfbe1b4f19e556` (see
`oracle-worker/deployed.mainnet.json`). To verify it, rebuild, optimize, and compare the
SHA256 of `soroban_vrf_oracle.optimized.wasm` with that value.

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
| `MAX_SENDS_PER_REQUEST` | No | `6` | Hard cap on `sendTransaction()` calls per request id, across inner/outer retries **and** reconciliation passes. Once reached, the request is parked (log `Request N is parked`) and the requester can `timeout_refund()`. Per process: restarts/failover reset it. Must be ≥ 1 |
| `TX_FEE` | No | `1000000` | Transaction fee (stroops) |
| `LISTENER_MAX_POLL_FAILURES` | No | `20` | Consecutive failed polls before the listener restarts |
| `LISTENER_MAX_RESTARTS` / `LISTENER_RESTART_WINDOW_MS` | No | `5` / `600000` | Crash budget before relinquishing leadership |
| `LISTENER_RESTART_BASE_MS` / `LISTENER_RESTART_MAX_MS` | No | `2000` / `60000` | Listener restart backoff |
| `LEADER_LEASE_SAFETY_MS` | No | `TTL/5` | Local fail-closed margin before lease expiry |
| `LEADER_RELINQUISH_COOLDOWN_MS` | No | `2×TTL` | No re-acquire after relinquishing |
| `RECONCILE_MAX_SCAN` | No | `1000` | Newest request IDs re-checked on each reconciliation |
| `RECONCILE_INTERVAL_MS` | No | `120000` | Periodic reconciliation interval while leader |
| `HEALTH_LISTENER_STALE_MS` / `HEALTH_LISTENER_GRACE_MS` | No | `120000` / `60000` | Leader listener staleness threshold / grace |
| `DRAND_VERIFY_BEACONS` | No | `true` | Local drand verification. `false` is **refused** on Mainnet or with `NODE_ENV=production` |
| `FULFILL_COST_STROOPS` | No | `1500000` | Estimated fulfill cost. On-chain fee ≥ this counts as "paid" |
| `MIN_ORACLE_BALANCE_XLM` | No | `5` | Never submit below this balance |
| `UNPAID_BUDGET_XLM_PER_HOUR` | No | `1.5` | Hard cap on the total **transaction max-fees** sent for unpaid, non-allowlisted requests per rolling hour, across **all** instances. `0` = serve only the allowlist |
| `UNPAID_FULFILL_MAX_PER_HOUR` | No | — | *Legacy.* If set and `UNPAID_BUDGET_XLM_PER_HOUR` is not, budget = N × `FULFILL_COST_STROOPS` |
| `UNPAID_REQUESTER_ALLOWLIST` | No | — | Comma-separated requester addresses always served |
| `FEE_GUARD_REDIS_KEY` | No | `vrf-oracle:unpaid-spend` | Spend-ledger key (used when `REDIS_URL` is set) |
| `PAID_FAILURE_BUDGET_XLM_PER_HOUR` | No | `10` | Max total **transaction max-fees at risk on paid requests** per rolling hour, all instances. Each paid send reserves its max fee; success or a pre-inclusion rejection releases it, a failed or unresolved send keeps it. Stops unbounded failing paid sends |
| `FEE_GUARD_PAID_REDIS_KEY` / `FEE_GUARD_PAID_STATE_FILE` | No | `vrf-oracle:paid-exposure` / `$TMPDIR/vrf-oracle-paid-exposure.json` | Ledger for the above (separate from the unpaid budget) |
| `FEE_GUARD_STATE_FILE` | No | `$TMPDIR/vrf-oracle-unpaid-spend.json` | Spend-ledger file (used when `REDIS_URL` is empty; single host only) |
| `MAX_FULFILL_INSTRUCTIONS` | No | `90000000` | **Resource guard.** A `fulfill()` whose simulation exceeds this CPU count is not signed or sent. A callback request includes the consumer's `on_vrf()`. The refusal is terminal: the request is parked |
| `MAX_FULFILL_RESOURCE_FEE_STROOPS` | No | `5000000` | Resource guard: max simulated `minResourceFee` |
| `MAX_FULFILL_TX_FEE_STROOPS` | No | `6000000` | Resource guard: max assembled envelope fee (inclusion + resource) |
| `DRAND_GENESIS_TIME` / `DRAND_PERIOD` / `DRAND_PUBLIC_KEY` | No | quicknet | Must equal the contract's `DrandGenesis` / `DrandPeriod` / `DrandPK`. Checked at startup |
| `SKIP_CHAIN_CONFIG_CHECK` | No | `false` | Skip the startup check that drand config, oracle BLS key and oracle address match the contract. **Refused** on Mainnet or with `NODE_ENV=production` |

**Terminal vs. retryable failures.** A failure that no retry can change is
**terminal**: the request is parked immediately, with no inner, outer or
reconciliation retries. This covers contract panics such as `already fulfilled`,
an invalid proof or a round mismatch, a callback that traps or exceeds resource
limits, a resource-guard refusal, and `txInsufficientBalance` / `txBadAuth`.
`already fulfilled` / `request refunded` count as *settled*: nothing is left to
do. Transient failures (`txBadSeq`, insufficient fee, RPC/network errors,
confirmation timeouts) keep the normal backoff, bounded by
`MAX_SENDS_PER_REQUEST`. Terminal failures are counted per reason in the fee
guard metrics (`terminalFailures`).

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
| `vrf_oracle_balance_stroops` | gauge | < 2 × `MIN_ORACLE_BALANCE_XLM` |
| `vrf_fee_guard_deferred_total` | counter | `increase(...[1h]) > 0`. Spam, an exhausted unpaid budget, or a balance at the floor |
| `vrf_unpaid_fulfillments_total` | counter | informational: fulfillments that didn't pay for themselves |
| `vrf_unpaid_spend_window_stroops` / `vrf_unpaid_budget_stroops` | gauge | spend ≥ 80% of budget for > 15 min (budget being exhausted: legitimate non-allowlisted users are about to be deferred) |

### Economic guard

The current Mainnet contract (`CAW6KECQ…UPRX`) has `FeeAmount = 2,000,000` stroops (0.2 XLM,
native XLM SAC), which covers the measured fulfill cost (~0.14 XLM), so its requests are "paid"
under rule 2. The guard still matters for zero-fee deployments (the Testnet instance and the
legacy `CBTCC5QL…`, both `FeeAmount = 0`) and for the part of a transaction's max fee above
`FeeAmount`. Before any drand wait, proof generation, or submission, the worker checks each
request in this order:

| # | Rule | Setting (default) |
|---|---|---|
| 1 | Refuse if balance − cost would drop below the floor. Fail closed if the balance can't be read. Applies to **all** requests, and is re-checked with a fresh balance before every send. | `MIN_ORACLE_BALANCE_XLM` (`5`) |
| 2 | Serve as "paid" only if `FeeToken` is the **native XLM SAC** and `FeeAmount` ≥ the estimated fulfill cost. Any other fee token is unpaid, because the worker can't price it. | `FULFILL_COST_STROOPS` (`1500000`) |
| 3 | Serve requesters on the allowlist without limit. | `UNPAID_REQUESTER_ALLOWLIST` (empty) |
| 4 | Serve anyone else from a shared spend budget (see below). Defer when it's used up. | `UNPAID_BUDGET_XLM_PER_HOUR` (`1.5`) |

**How rule 4 is enforced.** Right before **every** `sendTransaction()` (first attempt, internal
retries and outer retries), the worker atomically reserves that transaction's **maximum fee**
in a rolling-hour spend ledger. If the reservation would exceed the budget, the transaction
isn't sent. Stellar never charges more than the max fee, so the real spend on unpaid
requests is **≤ `UNPAID_BUDGET_XLM_PER_HOUR` per rolling hour, per deployment**. That holds
even when a request is retried or its result is ambiguous.

- With `REDIS_URL` set (production HA), the ledger is a Redis sorted set in the same Redis as
  the leader lease. It's updated by one Lua script using Redis' clock, so primary and standby
  share **one** budget. Failover and restarts don't reset it. `spend_ledger_drill.mjs`
  proves this against real Redis in CI.
- Without Redis, the ledger is a file (`FEE_GUARD_STATE_FILE`). It survives restarts, but
  like the file lock it's correct only on a single host.
- If the ledger can't be read or written, the worker **fails closed**: nothing unpaid is
  sent.

**Residual risk — liveness, not money.** Anyone can use up the shared budget with cheap
`request()` calls. After that, legitimate non-allowlisted requesters are deferred and may
only get `timeout_refund()`. The fee guard turns *economic drain* into *selective denial of
service*. It doesn't guarantee liveness for permissionless users. A redeployment with an XLM
`fee_amount` ≥ the fulfill cost removes this *economic* reason for deferral. Even then,
fulfillment is best-effort (oracle, RPC and drand availability), with `timeout_refund()`
as the fallback.

**Per-request send cap.** Separately from the budget, no request gets more than
`MAX_SENDS_PER_REQUEST` (default 6) `sendTransaction()` calls per worker process. This
bounds the fee a single request can cost when it keeps failing after simulation, e.g. a
consumer callback that aborts the transaction (see THREAT_MODEL.md → *Callback griefing*).
Log `Request N is parked: 6/6 fulfill sends already spent` means the cap was hit. The
request stays pending on-chain, and the requester can `timeout_refund()`. To retry a
parked request deliberately, restart the worker.

- Log `Deferring request N: …` shows the reason. A deferred request is **not dropped**. It stays
  pending on-chain, periodic reconciliation retries it once budget frees up, and the requester can
  call `timeout_refund()` after the timeout window.
- The startup log states the posture, e.g. `Contract FeeAmount (0 stroops) is below the fulfill cost …`.
- Put your own consumer contracts (`C…`) on the allowlist so they're always served. Set
  `UNPAID_BUDGET_XLM_PER_HOUR=0` to serve **only** the allowlist.
- Log `aborting fulfill(N) attempt K: sending would exceed the unpaid budget …` means the
  budget ran out between admission and send, for example because a retry needed another fee.
  The request stays pending, and reconciliation retries it when budget frees up.
- On a deployment whose fee covers the cost, rule 2 applies to every request. `mainnet_deploy.mjs`
  requires `FEE_AMOUNT_STROOPS` and refuses values below `1500000` unless explicitly overridden.

**Production fee token = native XLM only.** The contract accepts any token address as
`fee_token`, but the worker's economics are defined in XLM. On Mainnet or with
`NODE_ENV=production`, the worker **refuses to start** if the contract's `FeeToken` isn't the
native XLM SAC, and it fails closed if `FeeToken` can't be read. `mainnet_deploy.mjs` always
deploys with the XLM SAC. Other SEP-41 fee tokens aren't supported in production: that would
need a price source.

**Paid requests are reserved too.** A paid request whose `FeeAmount` covers the max fee used
to skip the ledgers. Then nothing bounded how many *failing* paid `fulfill()` sends the
oracle could pay for. Now every paid send reserves its covered max fee in a separate
paid-exposure ledger (`PAID_FAILURE_BUDGET_XLM_PER_HOUR`), keyed by the transaction hash
(member `"<amount>:<hash>"`, amount first as the Lua sum expects). How the send ends
decides what happens:

| Outcome | Covered part | Unpaid shortfall | Source |
|---|---|---|---|
| Applied, success | released (escrow reimbursed it) | kept | `getTransaction` SUCCESS |
| Rejected before inclusion (`tx_bad_seq`, `tx_insufficient_fee`, time bounds, bad auth, insufficient balance, `TRY_AGAIN_LATER`) | released | released | codes in `fulfillErrors.ts` (`isPreInclusionRejection`): no fee is charged |
| Applied, failed | kept (full max fee, conservative) | kept | `getTransaction` FAILED |
| Unlisted submission error | kept | kept | conservative |
| No answer (RPC error, timeout) | kept until resolved | kept until resolved | reconciliation: SUCCESS releases, FAILED keeps, NOT_FOUND after the tx's `maxTime` releases |

Unresolved reservations are tracked in memory. After a restart they simply stay counted
until they leave the one-hour window. This is a risk bound, not accounting: a failed
transaction counts its full max fee even if Stellar charged less.

**Fee vs. maximum transaction fee.** A "paid" request is only fully reimbursed if
`FeeAmount ≥` the transaction's max fee. At send time, the worker charges any shortfall
(`maxFee − FeeAmount`) to the unpaid budget, so a fee below the cap can't cause unbounded
loss. A deliberate deployment should still set:

```
FEE_AMOUNT (on-chain, immutable)  >=  MAX_FULFILL_TX_FEE_STROOPS (worker)
```

`mainnet_deploy.mjs` refuses otherwise (override: `ALLOW_FEE_BELOW_TX_CAP=yes-shortfall-charged-to-unpaid-budget`).
It records the evidence in `deployed.mainnet.json` → `feeEconomics`:
`FEE_AMOUNT`, `MAX_TOTAL_FEE` (= `MAX_FULFILL_TX_FEE_STROOPS`), `MAX_RESOURCE_FEE`,
`MAX_FULFILL_INSTRUCTIONS`, `feeCoversMaxTxFee`. Run the worker with the same cap values you
deployed with.

### Listener crash / relinquish behaviour

- Log `[Supervisor] Listener crashed (<error>). Restart i/N in Xms.` means the supervisor is recovering automatically. Look at `listener.last_error` on `/health`.
- Log `[Supervisor] Listener crashed K times within …s … Relinquishing leadership so the standby can take over.` means the listener crashed `LISTENER_MAX_RESTARTS` times within `LISTENER_RESTART_WINDOW_MS`. The node released the lease and won't re-acquire for `LEADER_RELINQUISH_COOLDOWN_MS`. **Confirm the standby became leader** (`/status` on both hosts), then investigate the relinquishing node's RPC connectivity.
- Log `Reconciliation found N unfulfilled request(s)` after a failover or restart is expected. These are requests whose events the previous leader never finished handling. If it keeps appearing on every periodic run, fulfillment is failing for those IDs. Check the logs for their `request_id`.

### Key Metrics to Watch

1. **XLM Balance** — Oracle account needs XLM for transaction fees
   - `vrf_oracle_balance_stroops` (gauge, updated by the fee guard). Alert well above
     `MIN_ORACLE_BALANCE_XLM`, e.g. at 2× the floor. At the floor the worker stops submitting.
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

Normally **never needed**. drand resharing (committee members joining or leaving) keeps the
group public key, and so the chain hash (drand `common/chain/info.go`: the hash is stable
"regardless of the network composition"). A different public key means a different chain,
with a new chain hash. Before rotating, confirm that the chain hash in `/info` is still
`DRAND_CHAIN_HASH`. If it changed, this is a new chain; check that its genesis, period and
scheme match (see the scope note below).

> **Scope: key rotation for the *same* chain only. This is not a chain migration.**
> `rotate_drand_pk()` replaces only the stored `DrandPK`. `DrandGenesis`, `DrandPeriod`, and the drand signature DST are fixed at construction or compiled into the contract. `DRAND_DST` is the quicknet `bls-unchained-g1-rfc9380` scheme (G1 signatures, unchained). The contract has no upgrade entrypoint. So you **can't** move an existing deployment to a drand chain with a different genesis time, period, or signature scheme by rotating the key. The pairing check would reject every beacon, or the round↔time mapping would be wrong. Switching chains means deploying and initializing a new contract instance and migrating consumers to it.

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
  removes the proof (~450 B), request context and callback metadata. It
  **keeps** the `Fulfilled` flag and the 32-byte `Beta(id)` entry, so after
  cleanup `get_beta()`, `derive_random()`, `derive_random_in_range()` and
  `derive_range_for_domain()` still return the same values. Only `get_proof()`
  panics. (Legacy Mainnet WASM: there is no separate `Beta` entry, so
  `derive_*()` also panics after cleanup.)
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
| "configuration does not match the deployed contract" at startup | Worker env (drand genesis/period/key, BLS key, oracle account) differs from contract storage, e.g. after `rotate_drand_pk()` | Fix the env to match the contract, which is authoritative |
| "refusing fulfill(N): simulated CPU … exceeds MAX_FULFILL_INSTRUCTIONS" | The consumer's `on_vrf()` is too expensive | Request parked; the requester can `timeout_refund()`. Raise the bound only deliberately |
| "parked after terminal failure (…)" | A deterministic failure; retrying cannot help | Check the reason; the request is not retried |
