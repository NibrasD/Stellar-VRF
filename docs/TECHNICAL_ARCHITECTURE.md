# Soroban-VRF — Technical Architecture

## 1. Overview

Soroban-VRF is a Verifiable Random Function oracle for Stellar. It provides cryptographically provable, tamper-proof randomness to Soroban smart contracts using ECVRF (RFC 9381) with secp256k1, sourced from drand (League of Entropy) beacons.

```
┌───────────────────────────────────────────────────┐
│  Consumer dApp / Contract                         │
│  request_randomness(context) → derive_random()    │
└────────────────────┬──────────────────────────────┘
                     │ Soroban invoke
┌────────────────────▼──────────────────────────────┐
│  VRF Oracle Contract (Rust, wasm32, #![no_std])   │
│  request() → fulfill() → derive_random()          │
│  On-chain: ECVRF verify, Ed25519 sig, seed match  │
└──────┬─────────────────────────────────────┬──────┘
       │                                     │
  Soroban RPC                          Stellar Ledger
  (tx submit, poll)                    (sequence, timestamp)
       │
┌──────▼────────────────────────────────────────────┐
│  High-Availability Oracle Infrastructure          │
│  ┌─────────────────┐    ┌──────────────────────┐  │
│  │ Relay Nodes (3+) │───►│ Isolated Signing Svc │  │
│  │ (Monitor/drand)  │RPC │                      │  │
│  └─────────────────┘    └──────────────────────┘  │
└──────┬────────────────────────────────────────────┘
       │
   drand quicknet (League of Entropy, BLS12-381, 3s)
```

---

## 2. Cryptographic Layer — ECVRF

**Suite:** ECVRF-SECP256K1-SHA256-TAI per [RFC 9381](https://www.rfc-editor.org/rfc/rfc9381.html)

**Libraries:**
- Off-chain (TypeScript): `@noble/curves` v2 (secp256k1), `@noble/hashes` (SHA-256)
- On-chain (Rust/WASM): `k256` v0.13, `sha2` v0.10 — both `#![no_std]`, no allocator

### 2.1 Proof Generation (off-chain)

```
Input: alpha (seed string), SK (oracle private key)

1. H  = hashToCurve(PK, alpha)           // Try-and-Increment (§5.4.1.1)
2. Γ  = x · H                            // scalar mult with private key x
3. k  = deterministicNonce(SK, H)         // RFC 6979-style, NOT random
4. U  = k · G,  V = k · H
5. c  = SHA256(PK ‖ H ‖ Γ ‖ U ‖ V)[0:16] // 128-bit challenge
6. s  = (k + c·x) mod n                   // response scalar
7. β  = SHA256(0xFE ‖ 0x03 ‖ Γ)           // VRF output
```

### 2.2 VRF Uniqueness — Why k-Grinding Is Impossible

The VRF output β depends **only** on Γ, and Γ = x·H(α) is uniquely determined by (private key, input). The nonce k appears only in the proof (c, s) and has **zero effect** on β.

This is the "Full Uniqueness" property (RFC 9381 §3.1): for any fixed public key and input, there is exactly one valid output β — regardless of nonce choice.

> **Implication:** The oracle cannot produce different outputs for the same input. Assuming RFC 9381-compliant hashToCurve and proof verification, the oracle has zero degrees of freedom over β.

### 2.3 Proof Verification (6 steps, on-chain and off-chain)

```
Input: proof(Γ, c, s, ctr_hint), PK (public key), alpha (seed)

1. Validate PK is a valid secp256k1 point
2. Deserialize and validate Γ
3. H  = hashToCurve(PK, alpha, ctr_hint) // Uses hint to avoid on-chain loop (DoS protection)
4. U' = s·G − c·PK   // Reconstructed via Shamir's Trick (lincomb) for multi-scalar multiplication
   V' = s·H − c·Γ    // Reconstructed via Shamir's Trick (lincomb)
5. c' = SHA256(PK ‖ H ‖ Γ ‖ U' ‖ V')[0:16]
   Assert c' == c
6. β  = SHA256(0xFE ‖ 0x03 ‖ Γ)
```

No oracle private key is involved in verification. Anyone with the public key can verify.

---

## 3. Entropy Source — drand

**Chain:** quicknet (BLS12-381 G2, unchained, 3-second period)
**Hash:** `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`
**Operators:** Cloudflare, EPFL, Protocol Labs, cLabs, Emerald Onion, and others

drand produces a threshold BLS signature every 3 seconds. No single operator can predict or bias the output until the quorum assembles it.

### 3.1 Why drand Is Needed

Without an external entropy source, the VRF input (alpha) could be predictable or chosen by either party:

| Threat | VRF alone | VRF + drand (commit-reveal) |
|---|---|---|
| Oracle predicts β before committing | ⚠️ Yes (knows own key) | ❌ Alpha includes future drand round |
| User biases the input | ⚠️ Could choose favorable context | ❌ drand component is uncontrollable |
| Oracle produces wrong β | ❌ VRF uniqueness prevents this | ❌ Same |

### 3.2 Binding VRF to drand

To remove the oracle's control over the input, the VRF `alpha` string is bound to a specific, unpredictable drand round:

```
alpha = SHA256(context ‖ ledger_timestamp ‖ required_drand_round ‖ drand_randomness)
```

The oracle service fetches and validates both `drand_signature` and `drand_randomness` from the drand API (full BLS verification off-chain). Only `drand_signature` is submitted on-chain as part of `EcvrfProof`. The contract derives `drand_randomness = sha256(drand_sig)` on-chain to reconstruct the full alpha seed, ensuring the oracle cannot substitute a fabricated entropy value.

> **Note on Entropy Reconstruction:** For unchained quicknet beacons, the published randomness is itself derived directly from the BLS signature. The contract uses `sha256(drand_sig)` as the canonical entropy reconstruction to exactly match the drand specification.

The on-chain SHA256 check ensures the oracle cannot fabricate drand data — the signature and randomness must be internally consistent. Full BLS pairing verification is not performed on-chain due to the computational cost of BLS12-381 in WASM.

The League of Entropy public keys are hardcoded in the oracle service for both chains (quicknet and default).

---

## 4. Anti-Front-Running — Commit-Reveal with Deterministic drand Round

### 4.1 The Problem

If the oracle builds alpha and computes β before committing on-chain, it knows the outcome in advance. This enables front-running and selective fulfillment.

### 4.2 drand Round Grinding (and why the contract must choose the round)

A naive approach — "oracle uses the next drand round after the request ledger" — leaves the oracle with a degree of freedom: it can observe round N, compute β, and if the result is unfavorable, wait 3 seconds for round N+1, recompute β, and repeat until it finds a favorable outcome.

**The contract, not the oracle, must deterministically select the required drand round.** This eliminates all degrees of freedom.

### 4.3 The Solution

```
1. User calls contract.request(context)
   → Contract records (context, ledger_timestamp)
   → Contract computes and stores:
     required_drand_round = floor((ledger_timestamp - DRAND_GENESIS) / DRAND_PERIOD) + 2
     (where DRAND_GENESIS = 1692803367, DRAND_PERIOD = 3 for quicknet)

2. Oracle fetches EXACTLY drand round = required_drand_round
   (no choice — the contract will reject any other round)

3. alpha = SHA256(context ‖ ledger_timestamp ‖ required_drand_round ‖ drand_randomness)

4. Oracle computes β = VRF(alpha) and submits proof

5. Contract verifies (check #8):
   assert(proof.drand_round == stored_required_drand_round)
   → Rejects ANY other round number
```

**Why `+ 2`?** The `+1` round may already be in-flight or published by the time the request's ledger is finalized. Using `+2` provides a safe margin ensuring the round is genuinely in the future at commitment time.

**Result:** Neither the oracle nor the user has any choice over which drand round is used. The round is computed deterministically from the ledger timestamp, eliminating round-grinding attacks entirely.

---

## 5. Liveness and Fault Tolerance

The protocol enforces a fulfillment deadline for every randomness request.

- On `request()`, a deadline is recorded on-chain.
- If the oracle fulfills before the deadline, the proof and randomness are stored.
- If the deadline expires without fulfillment, the request becomes refundable and the requester can recover the paid fee through `timeout_refund()`.

All request metadata, including request ledger, target drand round, deadline, and fulfillment status, is recorded on-chain and can be independently audited by anyone.

For operational reliability, the oracle infrastructure will be deployed with redundant relay services and monitoring to reduce downtime caused by hardware, networking, or service failures.

---

## 6. Smart Contract — Security Model

**Contract ID (Testnet, v3):** `CDGNPXXJTBNJYBJ6O35Q6ZOBLEZVIX5INTPJ5JYSUFBIZOY4FMX4S5RQ`
**Runtime:** Soroban SDK v20.0.0, `wasm32-unknown-unknown`, `#![no_std]`
**WASM:** 41.5 KB (`ecvrf` feature, `opt-level = \"z\"`, LTO)

### 6.1 Data Structures

```rust
#[contracttype]
pub struct EcvrfProof {
    pub alpha_seed:    Bytes,       // Full alpha: sha256(context ‖ timestamp ‖ round ‖ drand_rand)
    pub gamma_point:   BytesN<33>,  // compressed secp256k1 point
    pub c_scalar:      BytesN<16>,  // 128-bit challenge
    pub s_scalar:      BytesN<32>,  // 256-bit response
    pub beta_output:   BytesN<32>,  // SHA-256 VRF output
    pub public_key:    BytesN<33>,  // compressed oracle PK
    pub ctr_hint:      u8,          // hashToCurve loop counter (max 255, prevents DoS)
    pub drand_round:   u64,         // drand round used (prevents round grinding)
    pub drand_sig:     Bytes,       // BLS12-381 signature from drand (48 bytes for G1, or 96 bytes for G2)
}
```

### 6.2 Security Checks in `fulfill()`

The contract enforces **9 security checks** before accepting a proof:

| # | Check | Purpose |
|---|---|---|
| 1 | `oracle_addr.require_auth()` | Only registered oracle can submit |
| 2 | `request_id` exists in storage | Prevents fulfilling non-existent requests |
| 3 | `!already_fulfilled` | Double-fulfillment prevention |
| 4 | `proof.public_key == stored_pk` | Prevents key-substitution attacks |
| 5 | `ed25519_verify(...)` | Proof data authenticated by oracle Ed25519 key |
| 6 | `proof.alpha_seed == constructed_alpha` | Contract computes `drand_rand = sha256(proof.drand_sig)`, then verifies `alpha = hash(context ‖ timestamp ‖ round ‖ drand_rand)` exactly matches |
| 7 | `ecvrf::verify_ecvrf(...)` | Full on-chain ECVRF cryptographic verification (see §12.1) |
| 8 | `proof.drand_round == stored_required_round` | Prevents drand round grinding (see §4.2) |
| 9 | `validate_ctr_hint(...)` | Ensures hashToCurve hint is valid, preventing infinite loop DoS |

> **Binding Operator Identity to VRF Key:** During `init()`, the contract permanently stores `oracle_address` (Ed25519 identity), `oracle_ed25519_pk`, and `oracle_vrf_pk` (secp256k1). All fulfillments must be authorized by `oracle_address` and must contain proofs generated under `oracle_vrf_pk`. This creates a permanent on-chain binding between the operational signer and the VRF key.

### 6.3 Contract Functions

| Function | Access | Description |
|---|---|---|
| `init(oracle_pk, oracle_address, oracle_ed25519_pk)` | Public (once) | Initialize oracle identity |
| `request(context, requester) → u64` | Auth(requester) | Record a new request. *Note: Full alpha is constructed later by hashing this context with timestamp, round, and drand.* |
| `fulfill(request_id, proof, signature)` | Auth(oracle) | Submit ECVRF proof; 9 security checks |
| `timeout_refund(request_id)` | Auth(requester) | Claim refund after deadline expires |
| `derive_random(request_id, context) → u64` | Public | Deterministic randomness from fulfilled proof |
| `get_proof(request_id) → EcvrfProof` | Public | Read stored proof |
| `is_fulfilled(request_id) → bool` | Public | Check fulfillment status |
| `oracle_pk() → BytesN<33>` | Public | Return stored oracle public key |
| `oracle_address() → Address` | Public | Return stored oracle address |

### 6.4 Storage

| Type | Key | Data | TTL |
|---|---|---|---|
| Instance | `OraclePK`, `OracleAddr`, `OracleEd25519`, `Counter` | Oracle identity, request counter | 518,400 ledgers |
| Persistent | `RequestContext(u64)` | User context bytes per request (full alpha constructed at fulfill time) | 518,400 ledgers |
| Persistent | `RequestTimestamp(u64)` | Ledger timestamp of request (for alpha reconstruction) | 518,400 ledgers |
| Persistent | `RequestRound(u64)` | Required drand round computed at request time | 518,400 ledgers |
| Persistent | `RequestDeadline(u64)` | Fulfillment deadline for timeout/refund | 518,400 ledgers |
| Persistent | `Proof(u64)` | Full ECVRF proof per request | 518,400 ledgers |
| Persistent | `Fulfilled(u64)` | Boolean fulfillment flag | 518,400 ledgers |

---

## 7. Stellar Integration Layers

### 7.1 Smart Contract Execution (Soroban / Rust / WASM)

The core VRF logic and cryptographic verification (ECVRF per RFC 9381) are written in Rust and compiled to WASM. The contract performs secp256k1 EC arithmetic on-chain via the `k256` crate in `#![no_std]` — hashToCurve, point multiplication, challenge recomputation — verifying VRF proofs deterministically within Soroban's runtime.

### 7.2 State & Time Binding (Stellar Ledger Protocol)

The contract integrates with Stellar's ledger state via `env.ledger().sequence()` and `env.ledger().timestamp()` to bind each request to a specific ledger moment. This ensures the oracle must use a drand round published **after** the request's ledger, preventing use of past or pre-selected entropy.

### 7.3 Off-Chain Infrastructure (Soroban RPC)

The oracle service interacts with Stellar via Soroban RPC using `@stellar/stellar-sdk` v15. It simulates transactions for resource footprinting, assembles and signs transactions, and polls for finality. drand quicknet beacons provide the entropy source. A timeout-and-refund mechanism enforces liveness: if the oracle fails to respond within the defined ledger window, the request expires and the user is refunded.

### 7.4 Developer Integration (Stellar SDKs)

Consumer dApps invoke the contract's `request` function directly using `@stellar/stellar-sdk`, passing their application context. After fulfillment, they call `derive_random(request_id, context)` to obtain a deterministic `u64`. Different context strings from the same proof yield different outputs (domain separation).

> **For production dApps, a pre-audited, reusable `VRFConsumer` Soroban contract library will be provided.** This library abstracts the request/callback cycle into a simple Rust trait, allowing developers to integrate verifiable randomness into their contracts in minutes without handling low-level proof verification.

---

## 8. Request Lifecycle

```
Consumer Contract                   VRF Oracle Contract              Oracle Service
       │                                   │                              │
       │  request(context)                 │                              │
       │──────────────────────────────────►│                              │
       │  ◄── request_id                   │  stores: context, ledger_timestamp,  │
       │                                   │          required_drand_round,       │
       │                                   │          deadline                    │
       │                                   │  emit "request" event                │
       │                                   │─────────────────────────────────────►│
       │                                   │                                      │ polls via Soroban RPC
       │                                   │                                      │ waits for next drand
       │                                   │                                      │ round > ledger_time
       │                                   │                                      │
       │                                   │                                      │ builds alpha =
       │                                   │                                      │   hash(context ‖
       │                                   │                                      │   ledger_timestamp ‖
       │                                   │                                      │   required_drand_round ‖
       │                                   │                                      │   drand_randomness)
       │                                   │                                      │
       │                                   │                                      │ Γ = x·H(alpha)
       │                                   │                                      │ β = SHA256(Γ)
       │                                   │                                      │ proof = (Γ, c, s)
       │                                   │                                      │
       │                                   │  fulfill(id, proof, sig)           ◄─│
       │                                   │  9 security checks                   │
       │                                   │  stores proof on-chain       │
       │                                   │  emit "fulfill" event        │
       │                                   │                              │
       │  derive_random(id, "winner")      │                              │
       │──────────────────────────────────►│                              │
       │  ◄── u64 = first 8 bytes of SHA256(β ‖ context)      │                              │
```

---

## 9. Threat Model Summary

| Threat | Mitigation | Status |
|---|---|---|
| Oracle produces wrong β | VRF Uniqueness (RFC 9381) | Implemented (Testnet) |
| Oracle swaps alpha seed | Seed integrity check | Implemented (Testnet) |
| Unauthorized fulfillment | `require_auth()` + Ed25519 | Implemented (Testnet) |
| Double fulfillment | `Fulfilled` flag | Implemented (Testnet) |
| Nonce k grinding | Mathematically impossible (RFC 9381 §3.1) | Implemented (Testnet) |
| Oracle front-running | Commit-reveal with deterministic drand round | Planned for Tranche 1 |
| Oracle censorship | Timeout + refund + HA relay infrastructure | Planned for Tranches 1 & 2 |
| drand round grinding | Contract deterministically computes required round | Planned for Tranche 1 |

---

## 10. Dependencies

| Library | Version | Purpose | Layer |
|---|---|---|---|
| `soroban-sdk` | 20.0.0 | Soroban contract SDK | On-chain |
| `k256` | 0.13 | secp256k1 EC arithmetic (`#![no_std]`) | On-chain |
| `sha2` | 0.10 | SHA-256 (`#![no_std]`) | On-chain |
| `@noble/curves` | 2.x | secp256k1 EC arithmetic | Off-chain |
| `@noble/hashes` | 1.x | SHA-256 | Off-chain |
| `@stellar/stellar-sdk` | 15.x | Soroban RPC, transaction building, XDR | Off-chain |

---

## 11. Deployment

| Component | Value |
|---|---|
| Contract ID (v3) | `CDGNPXXJTBNJYBJ6O35Q6ZOBLEZVIX5INTPJ5JYSUFBIZOY4FMX4S5RQ` |
| WASM hash | `daa3ba5bf77b8e6a5ee826eb28fd9dad8fad0ef5236d523c096a5e47de93befa` |
| WASM Size | 41.5 KB |
| Network | Stellar Testnet |
| Oracle PK (secp256k1) | `032c8c31fc9f990c6b55e3865a184a4ce50e09481f2eaeb3e60ec1cea13a6ae645` |
| Oracle Address | `GARPMPBJ5H43UNYHLIC46MSYRDGF4ZNKUYTZYDYVW5S2TUORAMBZRAMI` |
| drand chain | quicknet · BLS12-381 G2 · 3s period |
| Deployed | 2026-06-07 |

---

## 12. Security Considerations

### 12.1 On-Chain ECVRF Verification & Gas Optimization (Proven on Testnet)

The ECVRF verification (check #7) is fully enabled and optimized for Soroban's WASM runtime. The `ecvrf` Cargo feature must remain enabled in all production deployments — disabling it degrades the system to a trusted oracle model where the "V" in VRF is lost.

Achieving practical gas costs required solving two major computational bottlenecks inherent to elliptic curve operations on-chain:

**Bottleneck 1: Non-deterministic `hashToCurve` (DoS Vector)**

The RFC 9381 Try-and-Increment method uses a loop to find a valid curve point, making execution time variable and exposing the contract to DoS attacks (an attacker could force many loop iterations).

* **Solution:** The oracle calculates the successful loop counter (`ctr_hint`) off-chain and submits it as part of the `EcvrfProof`. The contract validates the hint in a single iteration, making the on-chain execution strictly deterministic and capping CPU instructions.

**Bottleneck 2: Expensive Scalar Multiplications & Inversions**

A naive implementation of the verification equation (`U' = s*G - c*PK`, `V' = s*H - c*Γ`) requires 4 separate scalar multiplications and 4 modular inversions (`to_affine`). This initially consumed **~115.7M instructions**, dangerously exceeding Soroban's 100M target limit.

* **Solution:** Applied **Shamir's Trick (Linear Combination / `lincomb`)** via the `k256` crate's `LinearCombination` trait. This merges the two scalar multiplications per equation into a single multi-scalar multiplication, cutting the total from 4 to 2.
* **Note on Batch Inversion:** Montgomery's Batch Inversion was evaluated to reduce the 4 remaining `to_affine` calls but requires a Global Allocator (`alloc`), which is unavailable in Soroban's `#![no_std]` WASM environment. Fortunately, `lincomb` alone was sufficient.

**Benchmark Results (Stellar Testnet):**

| Version | Optimization | CPU Instructions | Fee (XLM) | Status |
|---|---|---|---|---|
| v1 (Baseline) | None | 115,722,610 | 0.0157 | ⚠️ Exceeds 100M limit |
| v2 | `ctr_hint` (Deterministic loop) | 114,135,304 | 0.0159 | ⚠️ Exceeds 100M limit |
| **v3 (Current)** | **`lincomb` (Shamir's Trick)** | **91,730,897** | **0.0143** | ✅ **Safe (Under 100M)** |

The final contract operates safely at **~91.7M instructions**, costing approximately **$0.004 per verification** — making it one of the most cost-effective VRF implementations on any blockchain.

### 12.2 Modulo Bias in `derive_random()`

`derive_random()` returns a `u64` by taking the first 8 bytes of `SHA256(β ‖ context)`. This produces a uniform value in `[0, 2^64 - 1]`.

When a consumer reduces this to a smaller range (e.g., `result % 1000`), **modulo bias** occurs: the remainder is not perfectly uniform because `2^64` is not evenly divisible by 1000. The bias magnitude is `(2^64 mod 1000) / 2^64 ≈ 5.4 × 10⁻¹⁷` — negligible for most applications.

For high-stakes applications requiring provably uniform distribution, consumers should implement **rejection sampling** on their side, or use the full `BytesN<32>` from `get_proof().beta_output` and apply bias-free reduction in their own contract logic.

### 12.3 Dual Key Management & Infrastructure Isolation

The oracle operates two distinct keypairs, operationally separated to minimize attack surface:

| Key | Curve | Purpose |
|---|---|---|
| Stellar auth key | Ed25519 | Transaction signing, `require_auth()` |
| VRF key | secp256k1 | ECVRF proof generation (Γ = x·H) |

**Production requirements:**
- Ed25519 transaction signing is isolated from the secp256k1 VRF signing environment.
- A dedicated remote signing service manages transaction authorization.
- The secp256k1 VRF key is managed in an isolated signing environment that is operationally separated from relay nodes and never exposed to internet-facing infrastructure.
- Relay nodes never possess private key material.

---

## 13. Soroban-Specific Constraints

### 13.1 Instruction Budget and Gas Cost

Soroban's per-transaction CPU instruction limit is **100M instructions** (default). The ECVRF verification in `fulfill()` performs multiple EC point multiplications and SHA256 hashes in WASM — operations that are significantly more expensive than native execution.

**Proven measurements (Stellar Testnet, v3 contract):**
- WASM binary size: **41.5 KB** (with `ecvrf` feature enabled, `opt-level = "z"`, LTO)
- ECVRF verification cost: **91,730,897 instructions** (includes hashToCurve, 2× lincomb, 4× to_affine, challenge hash)
- Resource fee: **0.0143 XLM** (~$0.004)

**Optimizations applied (see §12.1 for full details):**
1. **`ctr_hint`:** Oracle submits the successful hashToCurve counter. Contract verifies in O(1) instead of looping. Eliminates DoS risk from variable-cost execution.
2. **Shamir's Trick (`lincomb`):** Multi-scalar multiplication reduces 4 scalar mults to 2 lincomb calls, saving ~22.4M instructions.

**Remaining optimization opportunity:** Montgomery's Batch Inversion for the 4 `to_affine()` calls would save an additional ~9M instructions (bringing total to ~82M), but requires a global allocator unavailable in Soroban's `#![no_std]` WASM. This may become possible if Soroban exposes an allocator for guest libraries in a future protocol upgrade.

### 13.2 Stellar–drand Timing Race Condition

Stellar ledgers close every **5–7 seconds**. drand quicknet produces rounds every **3 seconds**. These clocks are independent and not synchronized.

**The problem with the deterministic round formula:**

```
required_drand_round = floor((ledger_timestamp - DRAND_GENESIS) / DRAND_PERIOD) + 2
```

The `ledger_timestamp` jumps in 5–7 second increments (not continuous). When a request is committed:
- The required drand round is computed from the ledger timestamp
- The drand round may be published 1–4 seconds after the ledger closes
- The oracle must fetch the drand data AND submit a Stellar transaction before the next ledger closes

**Scenario:**
```
Ledger N closes at T=100  →  required_drand_round = R
drand round R published at T=102  (2s later)
Oracle computes proof by T=103
Ledger N+1 closes at T=106  →  oracle submits fulfill() here

*(Note: In practice, fetching drand + ECVRF computation + Tx simulation + submission takes 5–8 seconds. The 3-ledger FULFILL_WINDOW provides adequate buffer.)*
```

**Design rules:**
1. The `FULFILL_WINDOW` must be measured in **ledger_sequence** (not timestamp), because sequence is deterministic and countable
2. The window must be at least **3 ledgers** (~15–21 seconds) to account for: drand round publication delay + proof computation time + transaction submission and finality
3. The `+ 2` offset in the round formula provides margin for the drand round to be genuinely in the future at commitment time

### 13.3 State Expiration (TTL) and Unfulfilled Requests

Soroban garbage-collects persistent storage entries whose TTL has expired (~30 days). If an unfulfilled request is garbage-collected before the user claims a refund, the user could lose their funds.

**Mitigation:**
1. **Auto-extend TTL:** The contract automatically calls `extend_ttl()` for all unfulfilled request entries whenever any contract interaction occurs, preventing expiration while a request is pending.
2. **Immediate expiration on deadline:** Once the `ledger_sequence` deadline passes, the request is marked expired in the same ledger. This allows the user to claim the refund immediately, long before the 30-day TTL is reached.
