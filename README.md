# Soroban-VRF — Verifiable Random Function for Stellar

<div align="center">

**Cryptographically provable, tamper-proof randomness for Soroban smart contracts.**

[![Stellar](https://img.shields.io/badge/Stellar-Testnet-blue?logo=stellar)](https://stellar.expert/explorer/testnet/contract/CDGNPXXJTBNJYBJ6O35Q6ZOBLEZVIX5INTPJ5JYSUFBIZOY4FMX4S5RQ)
[![Rust](https://img.shields.io/badge/Rust-WASM-orange?logo=rust)](https://www.rust-lang.org/)
[![RFC 9381](https://img.shields.io/badge/RFC-9381-green)](https://www.rfc-editor.org/rfc/rfc9381.html)

</div>

---

## Overview

Soroban-VRF is a production-grade VRF oracle for Stellar. It combines three independent, publicly auditable cryptographic components to deliver **verifiable on-chain randomness** that no single party can predict, bias, or manipulate:

| Component | Role |
|---|---|
| **ECVRF** (RFC 9381, secp256k1) | Produces a proof `(Γ, c, s)` alongside output `β`. Anyone can verify `β` was derived deterministically — the oracle has zero degrees of freedom over the result. |
| **drand** (League of Entropy) | Supplies unpredictable entropy via BLS12-381 threshold signatures (quicknet, 3s period). No single operator controls the beacon. |
| **Soroban Smart Contract** | Stores proofs on-chain, performs **full ECVRF cryptographic verification in WASM**, and enforces 9 security checks before accepting any proof. |

### Key Achievement: On-Chain Verification

Unlike most VRF implementations that rely on off-chain verification, Soroban-VRF performs **full ECVRF proof verification directly inside the smart contract** using elliptic curve arithmetic compiled to WASM. After extensive optimization (Shamir's Trick / `lincomb`, deterministic `hashToCurve` hints), the verification runs within Soroban's CPU budget:

| Metric | Value |
|---|---|
| CPU Instructions | **91,730,897** (under 100M limit ✅) |
| Gas Cost | **0.0143 XLM** (~$0.004) |
| WASM Size | **41.5 KB** |

---

## Live Deployment

| Component | Value |
|---|---|
| Contract ID (v3) | [`CDGNPXXJTBNJYBJ6O35Q6ZOBLEZVIX5INTPJ5JYSUFBIZOY4FMX4S5RQ`](https://stellar.expert/explorer/testnet/contract/CDGNPXXJTBNJYBJ6O35Q6ZOBLEZVIX5INTPJ5JYSUFBIZOY4FMX4S5RQ) |
| Network | Stellar Testnet |
| WASM Hash | `daa3ba5bf77b8e6a5ee826eb28fd9dad8fad0ef5236d523c096a5e47de93befa` |
| Oracle PK (secp256k1) | `032c8c31fc9f990c6b55e3865a184a4ce50e09481f2eaeb3e60ec1cea13a6ae645` |
| Oracle Address | [`GARPMPBJ5H43UNYHLIC46MSYRDGF4ZNKUYTZYDYVW5S2TUORAMBZRAMI`](https://stellar.expert/explorer/testnet/account/GARPMPBJ5H43UNYHLIC46MSYRDGF4ZNKUYTZYDYVW5S2TUORAMBZRAMI) |
| drand Chain | quicknet · BLS12-381 G2 · 3s period |

---

## Architecture

```
┌───────────────────────────────────────────────────┐
│  Consumer dApp / Contract                         │
│  request_randomness(context) → derive_random()    │
└────────────────────┬──────────────────────────────┘
                     │ Soroban invoke
┌────────────────────▼──────────────────────────────┐
│  VRF Oracle Contract (Rust, WASM, #![no_std])     │
│  ┌──────────────────────────────────────────────┐ │
│  │ 9 Security Checks:                           │ │
│  │  • require_auth  • PK match  • Ed25519 sig   │ │
│  │  • seed match    • ECVRF verify (on-chain!)  │ │
│  │  • drand round   • ctr_hint                  │ │
│  └──────────────────────────────────────────────┘ │
└──────┬─────────────────────────────────────┬──────┘
       │                                     │
  Soroban RPC                          Stellar Ledger
  (tx submit)                          (sequence, timestamp)
       │
┌──────▼────────────────────────────────────────────┐
│  Oracle Service (Node.js / TypeScript)            │
│  vrfCrypto.ts · sorobanSubmit.ts · drand.ts       │
└──────┬────────────────────────────────────────────┘
       │
   drand quicknet (League of Entropy, BLS12-381, 3s)
```

---

## Repository Structure

```
soroban-contract/           # Rust smart contract (the core)
├── src/
│   ├── lib.rs              # Contract logic: init, request, fulfill, derive_random
│   ├── ecvrf.rs            # Optimized on-chain ECVRF verification (lincomb + ctr_hint)
│   └── test.rs             # Unit tests
├── Cargo.toml              # Dependencies: k256, sha2, soroban-sdk
├── deploy.mjs              # Stellar CLI deployment script
└── deployed.json           # Current deployment record

artifacts/
├── api-server/             # Fastify REST API (oracle service)
│   └── src/
│       ├── lib/
│       │   ├── vrfCrypto.ts      # ECVRF proof generation (@noble/curves)
│       │   ├── sorobanSubmit.ts   # Soroban transaction builder
│       │   └── drand.ts           # drand quicknet beacon client
│       └── routes/               # API endpoints
└── soroban-vrf/            # React + Vite dashboard

lib/                        # Shared libraries (API spec, DB schema)
docs/                       # Supporting documentation
```

---

## How It Works

### 1. Request
```
User → contract.request(context, requester)
     → Stores context, computes required drand round, returns request_id
```

### 2. Fulfill (Oracle)
```
Oracle fetches drand round → builds alpha → generates ECVRF proof:
  H  = hashToCurve(PK, alpha)
  Γ  = x · H
  β  = SHA256(0xFE ‖ 0x03 ‖ Γ)
  proof = (Γ, c, s, ctr_hint)
```

### 3. On-Chain Verification (9 checks)
```
contract.fulfill(request_id, proof, signature)
  ✓ Access control (require_auth)
  ✓ Request exists & not yet fulfilled
  ✓ Public key matches stored oracle PK
  ✓ Ed25519 signature authenticates proof data
  ✓ Alpha seed exactly matches constructed hash(context ‖ timestamp ‖ round ‖ drand_randomness)
  ✓ Full ECVRF cryptographic verification (on-chain!)
  ✓ drand round matches contract-computed round
  ✓ ctr_hint produces valid curve point
```

### 4. Consume
```
Anyone → contract.derive_random(request_id, "winner") → u64
       → contract.derive_random(request_id, "prize")  → u64  (different!)
```

Different context strings from the same proof yield different outputs (domain separation).

---

## Gas Optimization Journey

The critical engineering challenge was fitting ECVRF verification within Soroban's 100M instruction budget:

| Version | Optimization | CPU Instructions | Status |
|---|---|---|---|
| v1 (Baseline) | None | 115,722,610 | ⚠️ Over limit |
| v2 | `ctr_hint` — deterministic hashToCurve | 114,135,304 | ⚠️ Over limit |
| **v3 (Current)** | **Shamir's Trick (`lincomb`)** | **91,730,897** | ✅ **Safe** |

**Key optimizations:**
- **`ctr_hint`**: Oracle submits the successful hashToCurve counter. Contract verifies in O(1) instead of looping — eliminates DoS risk.
- **`lincomb` (Shamir's Trick)**: Multi-scalar multiplication via `k256::LinearCombination`. Computes `s·G + (-c)·PK` in one pass instead of two separate scalar multiplications. Saved ~22.4M instructions.

---

## Building

### Smart Contract

Requires Rust with the `wasm32-unknown-unknown` target.

```bash
cd soroban-contract
cargo build --target wasm32-unknown-unknown --release
cargo test --features testutils
```

### Oracle Service

Requires Node.js 20+ and pnpm.

```bash
pnpm install
pnpm --filter @workspace/api-server run dev    # API on port 8080
pnpm --filter @workspace/soroban-vrf run dev   # Dashboard
```

### Deploy to Testnet

```bash
cd soroban-contract
node deploy.mjs   # deploys WASM and writes deployed.json
```

---

## Security Model

The contract enforces 9 security checks before accepting any proof. The system is designed to be secure against:

| Threat | Mitigation | Status |
|---|---|---|
| Oracle produces wrong β | VRF Uniqueness (RFC 9381) | ✅ Implemented |
| Oracle swaps alpha seed | Seed integrity check | ✅ Implemented |
| Unauthorized fulfillment | `require_auth()` + Ed25519 | ✅ Implemented |
| Double fulfillment | `Fulfilled` flag | ✅ Implemented |
| Nonce k grinding | Mathematically impossible (RFC 9381 §3.1) | ✅ By design |
| Oracle front-running | Commit-reveal with deterministic drand round | ✅ Designed |
| Oracle censorship | Timeout + refund + HA relay infrastructure | ⚠️ Mitigated |
| drand round grinding | Contract deterministically computes required round | ✅ Designed |

> **Full technical details:** See [`docs/`](docs/) and the [Technical Architecture Document](TECH_ARCH.md).

---

## Contract API

| Function | Access | Description |
|---|---|---|
| `init(oracle_pk, oracle_address, oracle_ed25519_pk)` | Public (once) | Initialize oracle identity |
| `request(context, requester) → u64` | Auth(requester) | Record a new randomness request |
| `fulfill(request_id, proof, signature)` | Auth(oracle) | Submit ECVRF proof; 9 security checks |
| `timeout_refund(request_id)` | Auth(requester) | Claim refund after deadline expires |
| `derive_random(request_id, context) → u64` | Public | Deterministic randomness from fulfilled proof |
| `get_proof(request_id) → EcvrfProof` | Public | Read stored proof |
| `is_fulfilled(request_id) → bool` | Public | Check fulfillment status |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Smart Contract | Rust, Soroban SDK v20, `#![no_std]`, WASM |
| Cryptography (on-chain) | `k256` v0.13 (secp256k1), `sha2` v0.10 |
| Cryptography (off-chain) | `@noble/curves` v2, `@noble/hashes` |
| Oracle Service | Node.js, TypeScript, Fastify |
| Blockchain | Stellar / Soroban (Testnet) |
| Entropy Source | drand quicknet (League of Entropy, BLS12-381) |

---

## License

MIT
