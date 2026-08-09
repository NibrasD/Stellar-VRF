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

## Quick Start

### Run contract tests
```bash
cd soroban-contract
cargo test
```

### Run oracle worker
```bash
cd oracle-worker
cp .env.example .env   # fill in your keys
npx tsx src/index.ts
```

### Run E2E test
```bash
node oracle-worker/e2e_test.mjs
```

## Security

See [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) and [`docs/CONSUMER_AUTHORIZATION.md`](docs/CONSUMER_AUTHORIZATION.md).
