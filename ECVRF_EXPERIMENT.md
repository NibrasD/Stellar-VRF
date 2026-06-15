# ECVRF Feasibility Experiment — Historical Record

> **Purpose:** This document preserves on-chain evidence of our ECVRF experiment on Stellar Testnet.
> Testnet resets periodically, so transaction links may expire. The data below was captured at experiment time (April 2026).

## Experiment Setup

- **VRF Construction:** ECVRF-SECP256K1-SHA256-TAI (RFC 9381)
- **On-chain library:** `k256` v0.13.1 (Rust, compiled to WASM)
- **Optimizations applied:** Shamir's Trick (combined scalar multiplication via `lincomb`)
- **Contract:** Soroban SDK 20.x, deployed to Stellar Testnet

## Measured Results

| Metric | Value |
|---|---|
| ECVRF verify (WASM k256) | ~91M CPU instructions |
| Full transaction (ECVRF + drand + Ed25519) | ~134M CPU instructions |
| Mainnet per-transaction limit | 100M |
| **Verdict** | ❌ **Exceeds mainnet limit** |

## Testnet Transaction Evidence

> ⚠️ These links may stop working after a Testnet reset.

| Test Case | Transaction Hash | Result |
|---|---|---|
| Valid proof (full pipeline) | [`7559ec1a…`](https://stellar.expert/explorer/testnet/tx/7559ec1af9f6de53f51e93f7d5fccddf0148610bcf34566bf9e5267749646be3) | ✅ SUCCESS (134M instructions) |
| Tampered `beta_output` | [`5a585a0a…`](https://stellar.expert/explorer/testnet/tx/5a585a0acd9c198a2329cdd49e07439f4e5c6411cbff14fec9f5be9a44b71bcc) | ❌ FAILED — `Error(Contract, #7)` EcvrfBetaMismatch |
| Tampered `gamma_point` | [`0f458c00…`](https://stellar.expert/explorer/testnet/tx/0f458c00640d422ea894f2030be97bb2050c2ca3ca97bfee8cc8cdb5a90623ee) | ❌ FAILED — `Error(Contract, #8)` EcvrfChallengeFail |

**Testnet contract address:** `CDSKLSIMDWMM5PVWCHXMUNN5H5VMSAN2PQNTVENKUBNDOCWL37IDJUJD`

## Why We Moved to BLS-VRF

The ECVRF experiment proved that full on-chain secp256k1 verification in WASM is not viable on Soroban due to the 100M instruction limit. Even after applying Shamir's Trick optimization (saving ~22M instructions), the total pipeline cost of **134M** still exceeded the mainnet budget.

We then adopted a **BLS12-381 pairing-based VRF** which leverages Soroban's native host functions (CAP-0059, Protocol 22+), achieving a total pipeline cost of **~58M instructions** — safely under the limit with 42% headroom.

| Construction | Cost | Status |
|---|---|---|
| ECVRF (WASM k256) | ~134M total | ❌ Over limit |
| BLS-VRF (native host functions) | ~58M total | ✅ Production-ready |
