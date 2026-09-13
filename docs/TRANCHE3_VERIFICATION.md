# Tranche 3 — Verification & Evidence Guide

**Goal:** Deploy and operate a production-ready randomness oracle on Stellar Mainnet.

This document maps every completion criterion to **independently verifiable evidence**:
a public link, an on-chain transaction hash, a re-runnable command, and/or a code
reference. A reviewer needs no privileged access — everything below can be checked
from a browser or a terminal.

---

## Quick Reference — Live Artifacts

| Artifact | Value |
|---|---|
| **Mainnet Contract** | `CCN75KEGLETGRTVJJDMXB2ZRQD6PC2S56VUOEKVLQPVEIJYGSOV55G57` |
| **Oracle Account** | `GAQ3XIUK4VSMKMDPX6TA2CQGHJ3CUK7Z5ZLMNQRHTBYLVT3NUEBI5TVU` |
| **WASM Hash** | `a193c0653d3da5d5d0f23302ccdebc979fb16d7e3b6dad14291d0c627319a723` |
| **Contract Explorer** | https://stellar.expert/explorer/public/contract/CCN75KEGLETGRTVJJDMXB2ZRQD6PC2S56VUOEKVLQPVEIJYGSOV55G57 |
| **Dashboard (Live)** | https://nibrasd.github.io/Stellar-VRF/dashboard/ |
| **Playground (Live)** | https://nibrasd.github.io/Stellar-VRF/playground/ |
| **Example dApp (Live)** | https://nibrasd.github.io/Stellar-VRF/example-dapp/ |

---

## Criterion 1 — Mainnet Deployment Completed

**Evidence (public, on-chain):**

1. Open the contract on Stellar Expert:
   https://stellar.expert/explorer/public/contract/CCN75KEGLETGRTVJJDMXB2ZRQD6PC2S56VUOEKVLQPVEIJYGSOV55G57

2. Verify via the public Stellar Expert API (re-runnable by the reviewer):
   ```bash
   curl -s https://api.stellar.expert/explorer/public/contract/CCN75KEGLETGRTVJJDMXB2ZRQD6PC2S56VUOEKVLQPVEIJYGSOV55G57
   ```
   Expected response fields prove a live, working deployment:
   ```json
   { "invocations": 6, "events": 5, "errors": 0, "storage_entries": 12,
     "creator": "GAQ3XIUK4VSMKMDPX6TA2CQGHJ3CUK7Z5ZLMNQRHTBYLVT3NUEBI5TVU" }
   ```
   `errors: 0` across all invocations demonstrates correct production behavior.

Deployment transaction trail: see Criterion 7 for hashes.

---

## Criterion 2 — Primary Oracle Worker + Hot-Standby + Automatic Failover

**Evidence (code + runnable demo):**

- HA topology defined in [`oracle-worker/docker-compose.ha.yml`](../oracle-worker/docker-compose.ha.yml):
  - `oracle-primary` (health port 8080) + `oracle-standby` (health port 8081)
  - Shared `leader-lock` volume for coordination
  - Docker healthchecks on `/health` every 15s
- Each instance exposes a health/metrics API: [`oracle-worker/src/health.ts`](../oracle-worker/src/health.ts)
  — endpoints `/health`, `/metrics` (Prometheus), `/status`.

**Reproducible failover demo** (documented in [`docs/HA_DEPLOYMENT.md`](HA_DEPLOYMENT.md)):
```bash
cd oracle-worker
cp .env.mainnet .env               # provide oracle keys
docker compose -f docker-compose.ha.yml up -d
curl http://localhost:8080/health  # primary -> role: "leader"
curl http://localhost:8081/health  # standby -> role: "standby"

# Kill the primary and watch the standby take over within LEADER_LOCK_TTL_MS (30s):
docker compose -f docker-compose.ha.yml stop oracle-primary
sleep 31
curl http://localhost:8081/health  # standby -> role: "leader"
```

---

## Criterion 3 — Leader Election (Prevents Double-Submission)

**Evidence (code + defense-in-depth):**

- Leader election implementation: [`oracle-worker/src/leader.ts`](../oracle-worker/src/leader.ts)
  - Atomic lock acquisition using the OS exclusive-create flag (`fs ... flag: "wx"`),
    which the operating system guarantees only one process can win — eliminating the
    TOCTOU race.
  - Heartbeat renewal (`LEADER_HEARTBEAT_MS`) + stale-lock takeover (`LEADER_LOCK_TTL_MS`).
- **Second, independent guard** — even if two nodes ever acted simultaneously, the
  on-chain contract makes a duplicate `fulfill()` impossible:
  - Worker-side idempotency check `isRequestFulfilled()` before submitting
    ([`oracle-worker/src/index.ts`](../oracle-worker/src/index.ts), step 1).
  - Contract-side rejection of duplicate fulfillment, proven by the unit tests
    `test_fulfill_duplicate_rejected` and `test_reentancy_guard_blocks_during_callback`
    ([`soroban-contract/src/test.rs`](../soroban-contract/src/test.rs)).

**Verify the on-chain guards:**
```bash
cd soroban-contract && cargo test
# 33 passed; 0 failed — includes test_fulfill_duplicate_rejected
```


---

## Criterion 4 — Developer SDK Released (JS and Rust)

**Evidence (code + build/test commands):**

- **JavaScript/TypeScript SDK** — [`sdk/js/`](../sdk/js/) — package `@stellar-vrf/sdk`
  - Public API in [`sdk/js/src/index.ts`](../sdk/js/src/index.ts):
    `request()`, `waitForFulfillment()`, `getProof()`, `isFulfilled()`,
    `deriveRandomInRange()`, `getRequestEvents()`, `getFulfillEvents()`.
  - Build check:
    ```bash
    cd sdk/js && npm install && npx tsc --noEmit    # exits 0 (compiles clean)
    ```
- **Rust SDK** — [`sdk/rust/`](../sdk/rust/) — crate `stellar-vrf-sdk`
  - Async client in [`sdk/rust/src/lib.rs`](../sdk/rust/src/lib.rs).
  - Build & test:
    ```bash
    cd sdk/rust && cargo test
    # 11 passed; 0 failed + doctest passed
    ```

---

## Criterion 5 — Example Integration dApp Published

**Evidence (public link + code):**

- Live: https://nibrasd.github.io/Stellar-VRF/example-dapp/
- Source: [`example-dapp/index.html`](../example-dapp/index.html) — integration reference
  wired to the mainnet contract, with neutral use cases (audit sampling, ID assignment,
  trait generation).
- Also: an on-chain **consumer contract** reference library
  [`consumer-example/`](../consumer-example/) demonstrating the callback pattern.

---

## Criterion 6 — Operational Procedures Documented

**Evidence (documents in [`docs/`](.)):**

| Document | Purpose |
|---|---|
| [`OPERATIONS.md`](OPERATIONS.md) | Day-to-day operations, contract addresses, worker startup |
| [`RUNBOOK.md`](RUNBOOK.md) | Step-by-step runbook for common tasks (239 lines) |
| [`HA_DEPLOYMENT.md`](HA_DEPLOYMENT.md) | High-availability deployment + failover test |
| [`INCIDENT_RESPONSE.md`](INCIDENT_RESPONSE.md) | Incident response playbook |
| [`MONITORING_PLAN.md`](MONITORING_PLAN.md) | Metrics, alerting, health monitoring |
| [`THREAT_MODEL.md`](THREAT_MODEL.md) / [`STRIDE_THREAT_MODEL.md`](STRIDE_THREAT_MODEL.md) | Security analysis |
| [`PROFILING.md`](PROFILING.md) | Instruction-budget measurements |

---

## Criterion 7 — Public Mainnet Transactions (Proof of Operation)

**Evidence (every hash is publicly verifiable on Stellar Expert):**

| Step | Transaction Hash | Verify |
|---|---|---|
| WASM Upload | `296bbf779514e69e0e9731f3a22018fc31153f5fcc9bf29131311c839716790e` | [View](https://stellar.expert/explorer/public/tx/296bbf779514e69e0e9731f3a22018fc31153f5fcc9bf29131311c839716790e) |
| Contract Deploy | `5febbea86e59a315c7d3ab80647cadab06c37def85bc247d764d1d8713dce181` | [View](https://stellar.expert/explorer/public/tx/5febbea86e59a315c7d3ab80647cadab06c37def85bc247d764d1d8713dce181) |
| Contract Init | `bbcb6a1a048ebc1aa1bd8915c80d6e727c21b940a60c6e34878114c3430222b9` | [View](https://stellar.expert/explorer/public/tx/bbcb6a1a048ebc1aa1bd8915c80d6e727c21b940a60c6e34878114c3430222b9) |
| First `request()` | `fae15bdd8e8b38163b69ed0c7df87150870aefb92078141fbdcef2bdc7d7846e` | [View](https://stellar.expert/explorer/public/tx/fae15bdd8e8b38163b69ed0c7df87150870aefb92078141fbdcef2bdc7d7846e) |
| First `fulfill()` | `5190ba03ba8cc708efe035996f90da0668f9f1d725658bd84aecbd63be24e5f2` | [View](https://stellar.expert/explorer/public/tx/5190ba03ba8cc708efe035996f90da0668f9f1d725658bd84aecbd63be24e5f2) |

**API-level verification (re-runnable):**
```bash
# request() — confirms it exists and succeeded on ledger 64392911
curl -s https://api.stellar.expert/explorer/public/tx/fae15bdd8e8b38163b69ed0c7df87150870aefb92078141fbdcef2bdc7d7846e

# fulfill() — confirms it exists, succeeded on ledger 64392913,
#             and includes the on-chain cpu_insn budget metric
curl -s https://api.stellar.expert/explorer/public/tx/5190ba03ba8cc708efe035996f90da0668f9f1d725658bd84aecbd63be24e5f2
```
The `fulfill()` transaction's on-chain `core_metrics.cpu_insn` measured
**58,641,186 CPU instructions** — 21.8% headroom under the 75M SCF target
(see [`PROFILING.md`](PROFILING.md)).

---

## Criterion 8 — Public Dashboard Published

**Evidence (public link):**

- Live: https://nibrasd.github.io/Stellar-VRF/dashboard/
- Real-time on-chain oracle activity: total requests, fulfillments, success rate,
  average fulfill time, latest drand round, recent VRF activity table.
- Testnet/Mainnet switcher.
- Source: [`dashboard/index.html`](../dashboard/index.html); deployment automated via
  [`.github/workflows/pages.yml`](../.github/workflows/pages.yml).

---

## Criterion 9 — Interactive Randomness Playground Deployed

**Evidence (public link):**

- Live: https://nibrasd.github.io/Stellar-VRF/playground/
- Submit **real on-chain VRF requests** and watch the oracle fulfill them live.
- Features: Testnet/Mainnet switch, Verifiable Random Number, Range Pick,
  Proof Explorer, client-side verification (verify beta from alpha using only the
  public oracle key — no trust required).
- Source: [`playground/index.html`](../playground/index.html).

---

## One-Shot Reviewer Checklist

```bash
# 1. Contract tests (on-chain logic, dup/re-entrancy guards)
cd soroban-contract && cargo test            # 33 passed

# 2. Rust SDK
cd ../sdk/rust && cargo test                 # 11 passed + doctest

# 3. JS SDK compiles
cd ../js && npm install && npx tsc --noEmit  # exit 0

# 4. Oracle worker compiles
cd ../../oracle-worker && npm install && npx tsc --noEmit   # exit 0

# 5. Mainnet contract is live with zero errors
curl -s https://api.stellar.expert/explorer/public/contract/CCN75KEGLETGRTVJJDMXB2ZRQD6PC2S56VUOEKVLQPVEIJYGSOV55G57
```

Plus open the three live pages: **Dashboard**, **Playground**, **Example dApp**.
