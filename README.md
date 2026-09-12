# Stellar VRF Oracle

A production-grade Verifiable Random Function (VRF) system for the Stellar/Soroban blockchain, using BLS12-381 cryptography and the drand distributed randomness beacon.

## Architecture

```
soroban-contract/   — On-chain VRF Oracle (Rust/Soroban)
oracle-worker/      — Off-chain Oracle Node (TypeScript)
consumer-example/   — Example consumer contract (Rust/Soroban)
docs/               — Security documentation
```

## Tranche 1 ✅ — Core VRF & Oracle Pipeline

- BLS-VRF on-chain verification (CAP-0059: `bls12_381_pairing_check`, `bls12_381_hash_to_g1`)
- drand quicknet binding with `round_offset ≥ 2` (future-round enforcement)
- Storage TTL extension on all persistent entries
- Oracle worker: event listener → drand beacon → BLS-VRF proof → `fulfill()`
- E2E validated on Stellar Testnet: 58.2M CPU instructions (< 70M target)

**Contract:** `CBBLOMK4ZYEO4IVVUBDBFHEZVYUOWWXN43Y5TBH6MAWCV23QAIMKGCEN`

## Tranche 2 ✅ — Composability & Security Hardening

- `fulfill()` implements full Checks-Effects-Interactions (CEI) pattern
- Re-entrancy guard via `DataKey::Fulfilling(request_id)` transient lock
- `rotate_oracle_keys()` — atomic rotation of BLS PK, Stellar address, Ed25519 key
- `rotate_drand_pk()` — drand chain key rotation support
- Consumer authorization model documented (VRF contract as caller)
- Consumer contract example library (`consumer-example/`)
- 27 unit tests: 14 core + 13 failure/rotation/edge-case scenarios
- Threat model documented (`docs/THREAT_MODEL.md`)

## Tranche 3 ✅ — Mainnet Deployment & Production Operations

### Mainnet Contract

| | |
|---|---|
| **Contract** | [`CCN75KEGLETGRTVJJDMXB2ZRQD6PC2S56VUOEKVLQPVEIJYGSOV55G57`](https://stellar.expert/explorer/public/contract/CCN75KEGLETGRTVJJDMXB2ZRQD6PC2S56VUOEKVLQPVEIJYGSOV55G57) |
| **Oracle** | `GAQ3XIUK4VSMKMDPX6TA2CQGHJ3CUK7Z5ZLMNQRHTBYLVT3NUEBI5TVU` |
| **Network** | Stellar Mainnet |

### Public Mainnet Transactions (Proof of Operation)

| Transaction | Hash | Explorer |
|---|---|---|
| WASM Upload | `296bbf77...` | [View ↗](https://stellar.expert/explorer/public/tx/296bbf779514e69e0e9731f3a22018fc31153f5fcc9bf29131311c839716790e) |
| Contract Deploy | `5febbea8...` | [View ↗](https://stellar.expert/explorer/public/tx/5febbea86e59a315c7d3ab80647cadab06c37def85bc247d764d1d8713dce181) |
| Contract Init | `bbcb6a1a...` | [View ↗](https://stellar.expert/explorer/public/tx/bbcb6a1a048ebc1aa1bd8915c80d6e727c21b940a60c6e34878114c3430222b9) |
| First `request()` | `fae15bdd...` | [View ↗](https://stellar.expert/explorer/public/tx/fae15bdd8e8b38163b69ed0c7df87150870aefb92078141fbdcef2bdc7d7846e) |
| First `fulfill()` | `5190ba03...` | [View ↗](https://stellar.expert/explorer/public/tx/5190ba03ba8cc708efe035996f90da0668f9f1d725658bd84aecbd63be24e5f2) |

### Instruction Budget

`fulfill()` measured at **58,641,186 CPU instructions** on mainnet — 21.8% headroom under 75M SCF target. See [`docs/PROFILING.md`](docs/PROFILING.md).

### Deliverables

- **Oracle HA:** Primary + hot-standby with file-based leader election and on-chain idempotency guard
- **Developer SDKs:** [JS SDK](sdk/js/) (`@stellar-vrf/sdk`) • [Rust SDK](sdk/rust/) (`stellar-vrf-sdk`)
- **Example dApp:** [example-dapp/](example-dapp/) — integration reference with neutral use cases
- **Dashboard:** [Live ↗](https://nibrasd.github.io/Stellar-VRF/dashboard/) — real-time oracle activity
- **Playground:** [Live ↗](https://nibrasd.github.io/Stellar-VRF/playground/) — interactive Testnet/Mainnet switcher
- **Operational Docs:** [OPERATIONS.md](docs/OPERATIONS.md) • [RUNBOOK.md](docs/RUNBOOK.md) • [HA_DEPLOYMENT.md](docs/HA_DEPLOYMENT.md) • [INCIDENT_RESPONSE.md](docs/INCIDENT_RESPONSE.md)

## Quick Start

### Run contract tests
```bash
cd soroban-contract
cargo test
```

### Run oracle worker (mainnet)
```bash
cd oracle-worker
cp .env.mainnet .env   # configure keys
npx tsc --outDir dist
node dist/index.js
```

### Run oracle worker (testnet)
```bash
cd oracle-worker
cp .env.example .env   # fill in testnet keys
npx tsc --outDir dist
node dist/index.js
```

## Documentation

| Document | Description |
|---|---|
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Day-to-day operational procedures |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | Step-by-step runbook for common tasks |
| [`docs/HA_DEPLOYMENT.md`](docs/HA_DEPLOYMENT.md) | High-availability deployment guide |
| [`docs/INCIDENT_RESPONSE.md`](docs/INCIDENT_RESPONSE.md) | Incident response playbook |
| [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) | Security threat model |
| [`docs/STRIDE_THREAT_MODEL.md`](docs/STRIDE_THREAT_MODEL.md) | STRIDE analysis |
| [`docs/CONSUMER_AUTHORIZATION.md`](docs/CONSUMER_AUTHORIZATION.md) | Consumer contract auth model |
| [`docs/PROFILING.md`](docs/PROFILING.md) | Instruction budget measurements |
