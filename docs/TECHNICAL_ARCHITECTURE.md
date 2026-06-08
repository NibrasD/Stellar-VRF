# Soroban-VRF — Technical Architecture

## 1. Overview

Soroban-VRF is one of the first Verifiable Random Function (VRF) oracle systems on Stellar with **fully on-chain cryptographic proof verification**. It provides cryptographically verifiable randomness with a single-operator liveness assumption to Soroban smart contracts using:
- **ECVRF** (RFC 9381) with secp256k1 — verified on-chain
- **BLS12-381** pairing verification of drand (League of Entropy) signatures — verified on-chain
- **Ed25519** oracle signature binding — verified on-chain via Soroban host function

All cryptographic verification executes **entirely on-chain**. The oracle cannot forge proofs, fabricate drand data, or substitute keys. This reduces the trust model to the drand network's threshold security (2/3 honest operators), and the oracle's liveness/round selection (to be addressed in Tranche 1).

```
┌───────────────────────────────────────────────────┐
│  Consumer dApp / Contract                         │
│  request(context) → derive_random(id, ctx)        │
└────────────────────┬──────────────────────────────┘
                     │ Soroban invoke
┌────────────────────▼──────────────────────────────┐
│  VRF Oracle Contract (Rust, wasm32, #![no_std])   │
│  request() → fulfill() → derive_random()          │
│  On-chain: BLS12-381 + ECVRF + Ed25519 + alpha    │
└──────┬─────────────────────────────────────┬──────┘
       │                                     │
  Soroban RPC                          Stellar Ledger
  (tx submit, poll)
       │
┌──────▼────────────────────────────────────────────┐
│  Oracle Infrastructure                            │
│  ┌─────────────────┐    ┌──────────────────────┐  │
│  │ Relay Node       │───►│ Isolated Signing Svc │  │
│  │ (Monitor/drand)  │RPC │ (Ed25519 + secp256k1)│  │
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

### 2.3 Proof Verification (on-chain, 8 steps in `ecvrf.rs`)

```
Input: proof(Γ, c, s, ctr_hint, beta), PK (public key), alpha (seed)

1. Decompress PK → AffinePoint → ProjectivePoint
2. Decompress Γ  → AffinePoint → ProjectivePoint
3. Parse c (16 bytes, zero-padded to 32) and s (32 bytes) as Scalars
4. H  = hashToCurve(PK_compressed, alpha, ctr_hint) // O(1) with hint
5. U' = lincomb(G, s, PK, -c)    // Shamir's Trick
   V' = lincomb(H, s, Γ, -c)     // Shamir's Trick
6. Convert H, Γ, U', V' to affine
7. c' = SHA256(0xFE ‖ 0x02 ‖ PK_compressed ‖ H_uncompressed ‖ Γ_uncompressed ‖ U'_uncompressed ‖ V'_uncompressed)[0:16]
   Assert c' == c → Err("ECVRF challenge mismatch") if not
8. β_expected = SHA256(0xFE ‖ 0x03 ‖ Γ_uncompressed)
   Assert β_expected == β → Err("ECVRF beta_output mismatch") if not
```

No oracle private key is involved in verification. Anyone with the public key can verify.

---

## 3. Entropy Source — drand

**Chain:** quicknet (BLS12-381, G1 signatures, unchained, 3-second period)
**Hash:** `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`
**Operators:** Cloudflare, EPFL, Protocol Labs, cLabs, Emerald Onion, and others

drand produces a threshold BLS signature every 3 seconds. No single operator can predict or bias the output until the quorum assembles it.

### 3.1 Why drand Is Needed

Without an external entropy source, the VRF input (alpha) could be predictable or chosen by either party:

| Threat | VRF alone | VRF + drand |
|---|---|---|
| Oracle predicts β before committing | ⚠️ Yes (knows own key) | ❌ Alpha includes drand randomness |
| User biases the input | ⚠️ Could choose favorable context | ❌ drand component is uncontrollable |
| Oracle produces wrong β | ❌ VRF uniqueness prevents this | ❌ Same |

### 3.2 On-Chain BLS12-381 Verification of drand Signatures

The contract performs **full BLS12-381 pairing verification** of the drand signature on-chain using Soroban's native `bls12_381` host functions. This reduces the trust in the entropy source strictly to the drand threshold security assumption (2/3 honest operators).

**Implementation (lib.rs L168-231):**
- The **negated drand Quicknet public key** is hardcoded as an uncompressed G2 point (192 bytes)
- The **G2 generator** is hardcoded as an uncompressed point (192 bytes)
- The drand round number (8-byte big-endian) is hashed via SHA-256, then mapped to G1 via `hash_to_g1()` with DST: `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_`
- Pairing equation: `e(sig, G2_gen) · e(H(msg), -PK) == 1`

**Cost:** ~20M instructions (native host function — highly efficient compared to WASM EC arithmetic)

### 3.3 Alpha Seed Derivation

The VRF alpha seed is derived on-chain during `fulfill()` to bind the user's context to the drand entropy:

```
alpha = SHA256(stored_context ‖ drand_round_be8 ‖ SHA256(drand_sig))
```

Where:
- `stored_context` = the user's context bytes stored at `request()` time (parameter `alpha_seed` in code)
- `drand_round_be8` = the drand round number as 8-byte big-endian (from `proof.drand_round`)
- `SHA256(drand_sig)` = the drand randomness, reconstructed on-chain from the BLS-verified signature

> **Alpha Uniqueness Note:** Two requests with identical `context` fulfilled with the same `drand_round` would produce the same alpha and thus the same β. Consumers should include unique identifiers (e.g., requester address, nonce, or the contract-assigned `request_id`) in their context to ensure distinct alpha seeds across requests.

The contract verifies that `proof.alpha_seed == expected_alpha`, ensuring the oracle cannot substitute fabricated entropy. Since the BLS signature is also verified on-chain, the entire chain from drand beacon → alpha seed → VRF output is cryptographically bound.

---

## 4. Anti-Front-Running — Commit-Reveal

### 4.1 The Problem

If the oracle builds alpha and computes β before committing on-chain, it knows the outcome in advance. This enables front-running and selective fulfillment.

### 4.2 Current State — Round-Grinding Vulnerability

In the current implementation, the `request()` function stores the user's context seed on-chain. The oracle fetches a drand round, combines it with the stored context to form alpha, and submits the proof. The on-chain alpha integrity check (§3.3) ensures the oracle uses **real** drand data (verified by BLS pairing), but the contract does not yet enforce *which specific* drand round must be used.

**This means the oracle can currently:**
1. Observe a request on-chain
2. Compute β for drand round N (using real, BLS-verified data)
3. If the result is unfavorable, wait 3 seconds for round N+1 and recompute
4. Repeat until a favorable β is found
5. Submit the proof with the chosen round — the contract accepts it

**The oracle cannot forge proofs or fabricate drand data**, but it can **select** which valid round to use. This is the single remaining trust assumption in the current system.

### 4.3 Planned: Deterministic drand Round Selection (Tranche 1)

> **Status: Planned for Tranche 1 — eliminates the round-grinding vulnerability**

To eliminate all degrees of freedom from the oracle, the contract will deterministically compute the required drand round:

```
required_drand_round = floor((ledger_timestamp - DRAND_GENESIS) / DRAND_PERIOD) + 2
```

Where `DRAND_GENESIS = 1692803367` and `DRAND_PERIOD = 3` for quicknet.

This will be stored at `request()` time and enforced during `fulfill()`. The oracle will have zero choice over which round to use.

**Why `+ 2`?** The `+1` round may already be in-flight or published by the time the request's ledger is finalized. Using `+2` provides a safe margin ensuring the round is genuinely in the future at commitment time.

---

## 5. Liveness and Fault Tolerance

### 5.1 Planned: Fulfillment Deadline & Timeout Refund (Tranche 1)

> **Status: Planned for Tranche 1**

The protocol will enforce a fulfillment deadline for every randomness request:

- On `request()`, a deadline will be recorded on-chain: `deadline = ledger_sequence + FULFILL_WINDOW`
- If the oracle fulfills before the deadline, the proof and randomness are stored
- If the deadline expires without fulfillment, the request becomes refundable via `timeout_refund()`

### 5.2 Current State

Currently, the contract does not enforce deadlines or provide refund mechanisms. Requests remain open until fulfilled. For production deployments, the oracle infrastructure will include redundant relay services and monitoring to reduce downtime.

---

## 6. Smart Contract — Security Model

**Contract ID (Testnet, v4):** `CCL2ON3EYVF7WQ5IKSF5QWRI5IQN5V7QAQV4VHBWAZP7DRYF4MM6G2DP`
**Runtime:** Soroban SDK v20.0.0, `wasm32v1-none`, `#![no_std]`

### 6.1 Data Structures

```rust
#[contracttype]
pub struct EcvrfProof {
    pub alpha_seed:  Bytes,       // SHA256(context ‖ round_be8 ‖ SHA256(drand_sig))
    pub gamma_point: BytesN<33>,  // compressed secp256k1 point
    pub c_scalar:    BytesN<16>,  // 128-bit challenge
    pub s_scalar:    BytesN<32>,  // 256-bit response
    pub beta_output: BytesN<32>,  // SHA-256 VRF output
    pub public_key:  BytesN<33>,  // compressed oracle PK
    pub ctr_hint:    u32,         // hashToCurve loop counter (cast to u8 internally; u32 because Soroban ScVal has no native u8 type)
    pub drand_round: u64,         // drand round used
    pub drand_sig:   BytesN<96>,  // Uncompressed G1 point (drand Quicknet BLS signature)
}
```

```rust
#[contracterror]
#[repr(u32)]
pub enum ContractError {
    AlreadyInitialized    = 1,   // init() called twice
    RequestNotFound       = 2,   // fulfill() for non-existent request
    AlreadyFulfilled      = 3,   // fulfill() for already-fulfilled request
    OracleKeyMismatch     = 4,   // proof.public_key != stored PK
    BlsVerificationFailed = 5,   // drand BLS12-381 pairing check failed
    AlphaSeedMismatch     = 6,   // alpha != SHA256(context ‖ round ‖ drand_rand)
    EcvrfBetaMismatch     = 7,   // beta != SHA256(0xFE ‖ 0x03 ‖ gamma)
    EcvrfChallengeFail    = 8,   // ECVRF challenge c' ≠ c
    EcvrfError            = 9,   // Generic ECVRF verification error
    NotFulfilled          = 10,  // derive_random() before fulfillment
}
```

### 6.2 Security Checks in `fulfill()`

The contract enforces **8 security checks** before accepting a proof:

| # | Check | Code Location | Error | Purpose |
|---|---|---|---|---|
| 1 | `oracle_addr.require_auth()` | L121 | Auth failure | Only registered oracle can submit |
| 2 | `RequestSeed(request_id)` exists | L123-125 | `#2 RequestNotFound` | Prevents fulfilling non-existent requests |
| 3 | `!already_fulfilled` | L127-134 | `#3 AlreadyFulfilled` | Double-fulfillment prevention |
| 4 | `proof.public_key == stored_pk` | L136-143 | `#4 OracleKeyMismatch` | Prevents key-substitution attacks |
| 5 | `ed25519_verify(oracle_ed25519, msg, sig)` | L145-166 | Ed25519 host error | Proof data authenticated by oracle Ed25519 key |
| 6 | `bls.pairing_check(...)` | L168-231 | `#5 BlsVerificationFailed` | drand BLS12-381 signature fully verified on-chain |
| 7 | `proof.alpha_seed == expected_alpha` | L233-250 | `#6 AlphaSeedMismatch` | Alpha integrity: `SHA256(context ‖ round ‖ drand_rand)` |
| 8 | `verify_ecvrf(...)` | L252-283 | `#7` / `#8` / `#9` | Full ECVRF challenge + beta verification (feature-gated) |

**Ed25519 message coverage (check #5):**
```
message = request_id_be8 ‖ gamma_point ‖ c_scalar ‖ s_scalar ‖ beta_output
```

**Fields NOT covered by Ed25519 but protected by independent checks:**
- `public_key` → protected by check #4 (compared against on-chain stored PK)
- `drand_sig` → protected by check #6 (BLS12-381 pairing verification)
- `drand_round` → protected by check #7 (alpha seed derivation uses round)
- `alpha_seed` → protected by check #7 (reconstructed and compared on-chain)

> **Typed Error Diagnostics:** The contract uses typed `ContractError` codes (e.g., `Error(Contract, #7)` for `EcvrfBetaMismatch`) rather than generic panics. This allows operators and consumers to precisely diagnose cryptographic rejection reasons directly from the Stellar transaction explorer.

> **Binding Operator Identity to VRF Key:** During `init()`, the contract permanently stores `oracle_address` (Ed25519 identity), `oracle_ed25519_pk`, and `oracle_vrf_pk` (secp256k1). All fulfillments must be authorized by `oracle_address` and must contain proofs generated under `oracle_vrf_pk`. This creates a permanent on-chain binding between the operational signer and the VRF key.

### 6.3 Contract Functions

| Function | Access | Description |
|---|---|---|
| `init(oracle_pk, oracle_address, oracle_ed25519_pk)` | Public (once) | Initialize oracle identity (PK, address, Ed25519 key) |
| `request(alpha_seed, requester) → u64` | Auth(requester) | Record a new request. Stores user context as `RequestSeed(id)`. Note: the parameter is named `alpha_seed` in the code, but it is strictly just the user's context seed (not the cryptographic alpha). The actual cryptographic alpha is derived during `fulfill()`. |
| `fulfill(request_id, proof, signature)` | Auth(oracle) | Submit ECVRF proof; 8 security checks; stores proof on-chain |
| `derive_random(request_id, context) → u64` | Public | Deterministic randomness: `SHA256(β ‖ context)[0:8]` |
| `get_proof(request_id) → EcvrfProof` | Public | Read stored proof |
| `is_fulfilled(request_id) → bool` | Public | Check fulfillment status |
| `oracle_pk() → BytesN<33>` | Public | Return stored oracle public key |
| `oracle_address() → Address` | Public | Return stored oracle address |

### 6.4 Storage

| Type | Key | Data | TTL |
|---|---|---|---|
| Instance | `OraclePK` | `BytesN<33>` secp256k1 compressed PK | 518,400 ledgers |
| Instance | `OracleAddr` | `Address` oracle Stellar address | 518,400 ledgers |
| Instance | `OracleEd25519` | `BytesN<32>` Ed25519 public key | 518,400 ledgers |
| Instance | `Counter` | `u64` request counter | 518,400 ledgers |
| Persistent | `RequestSeed(u64)` | `Bytes` user context seed per request | 518,400 ledgers |
| Persistent | `Proof(u64)` | `EcvrfProof` full proof per request | 518,400 ledgers |
| Persistent | `Fulfilled(u64)` | `bool` fulfillment flag | 518,400 ledgers |

---

## 7. Stellar Integration Layers

### 7.1 Smart Contract Execution (Soroban / Rust / WASM)

The core VRF logic and cryptographic verification are written in Rust and compiled to WASM. The contract performs:
- **BLS12-381 pairing verification** via native Soroban host functions (`bls12_381().pairing_check()`, `hash_to_g1()`)
- **secp256k1 EC arithmetic** on-chain via the `k256` crate in `#![no_std]` — hashToCurve, Shamir's Trick (lincomb), challenge recomputation
- **Ed25519 verification** via native Soroban host function (`crypto().ed25519_verify()`)

### 7.2 Off-Chain Infrastructure (Soroban RPC)

The oracle service interacts with Stellar via Soroban RPC using `@stellar/stellar-sdk` v15. It simulates transactions for resource footprinting, assembles and signs transactions, and polls for finality. drand quicknet beacons provide the entropy source.

### 7.3 Developer Integration (Stellar SDKs)

Consumer dApps invoke the contract's `request` function directly using `@stellar/stellar-sdk`, passing their application context. After fulfillment, they call `derive_random(request_id, context)` to obtain a deterministic `u64`. Different context strings from the same proof yield different outputs (domain separation).

---

## 8. Request Lifecycle

```
Consumer Contract                   VRF Oracle Contract              Oracle Service
       │                                   │                              │
       │  request(context_seed)            │                              │
       │──────────────────────────────────►│                              │
       │  ◄── request_id                   │  stores: RequestSeed(id)     │
       │                                   │          Fulfilled(id)=false  │
       │                                   │  emit "request" event         │
       │                                   │─────────────────────────────►│
       │                                   │                              │ polls via Soroban RPC
       │                                   │                              │ fetches drand round
       │                                   │                              │
       │                                   │                              │ builds alpha =
       │                                   │                              │   SHA256(context ‖
       │                                   │                              │   round_be8 ‖
       │                                   │                              │   SHA256(drand_sig))
       │                                   │                              │
       │                                   │                              │ Γ = x·H(alpha)
       │                                   │                              │ β = SHA256(0xFE‖0x03‖Γ)
       │                                   │                              │ proof = (Γ, c, s, β)
       │                                   │                              │ sig = Ed25519(rid‖Γ‖c‖s‖β)
       │                                   │                              │
       │                                   │  fulfill(id, proof, sig)   ◄─│
       │                                   │  8 security checks            │
       │                                   │  stores proof on-chain        │
       │                                   │  emit "fulfill" event         │
       │                                   │                              │
       │  derive_random(id, "winner")      │                              │
       │──────────────────────────────────►│                              │
       │  ◄── u64 = SHA256(β ‖ "winner")[0:8]                            │
```

---

## 9. Threat Model Summary

| Threat | Mitigation | Status |
|---|---|---|
| Oracle produces wrong β | VRF Uniqueness (RFC 9381) + on-chain ECVRF verification | ✅ Proven on Testnet |
| Oracle fabricates drand data | BLS12-381 pairing verification on-chain (hardcoded PK) | ✅ Proven on Testnet |
| Oracle swaps alpha seed | Alpha integrity check: SHA256(context ‖ round ‖ drand_rand) | ✅ Proven on Testnet |
| Oracle substitutes VRF key | `proof.public_key == stored_pk` check | ✅ Proven on Testnet |
| Unauthorized fulfillment | `require_auth()` + Ed25519 signature | ✅ Proven on Testnet |
| Tampered beta accepted | Beta verification: β == SHA256(0xFE ‖ 0x03 ‖ Γ) | ✅ Proven on Testnet (Error #7) |
| Tampered gamma accepted | Challenge recomputation: c' == c | ✅ Proven on Testnet (Error #8) |
| Double fulfillment | `Fulfilled(id)` flag check | ✅ Implemented |
| Nonce k grinding | Mathematically impossible (RFC 9381 §3.1) | ✅ By design |
| **Oracle round-grinding** | **Oracle can currently choose which valid drand round to use, allowing selective fulfillment** | ⚠️ **Open — fix in Tranche 1** |
| Oracle front-running | Deterministic drand round selection (contract computes required round) | 🔜 Planned (Tranche 1) |
| Oracle censorship | Timeout + refund + HA relay infrastructure | 🔜 Planned (Tranches 1 & 2) |

---

## 10. Dependencies

| Library | Version | Purpose | Layer |
|---|---|---|---|
| `soroban-sdk` | 20.0.0 | Soroban contract SDK (BLS12-381, Ed25519, SHA-256 host functions) | On-chain |
| `k256` | 0.13 | secp256k1 EC arithmetic, Shamir's Trick (`#![no_std]`) | On-chain |
| `sha2` | 0.10 | SHA-256 for ECVRF challenge/beta (`#![no_std]`) | On-chain |
| `@noble/curves` | 2.x | secp256k1 EC arithmetic | Off-chain |
| `@noble/hashes` | 1.x | SHA-256 | Off-chain |
| `@stellar/stellar-sdk` | 15.x | Soroban RPC, transaction building, XDR | Off-chain |

---

## 11. Deployment & On-Chain Evidence

| Component | Value |
|---|---|
| Contract ID (v4, positive test) | `CCL2ON3EYVF7WQ5IKSF5QWRI5IQN5V7QAQV4VHBWAZP7DRYF4MM6G2DP` |
| Contract ID (v4, negative tests) | `CC3TIBYWOL7CMLZTSYSPSPUMGUKQA22FMHVLAC233YPOBA4OGCNLQVK5` |
| Network | Stellar Testnet |
| Oracle PK (secp256k1) | `032c8c31fc9f990c6b55e3865a184a4ce50e09481f2eaeb3e60ec1cea13a6ae645` |
| drand chain | quicknet · BLS12-381 G1 · 3s period |
| Deployed | 2026-06-08 |

### On-Chain Test Evidence

| Test | TX Hash | Status | Error Code |
|---|---|---|---|
| Valid proof (full pipeline) | [`7559ec1a...`](https://stellar.expert/explorer/testnet/tx/7559ec1af9f6de53f51e93f7d5fccddf0148610bcf34566bf9e5267749646be3) | ✅ SUCCESS | — |
| Tampered `beta_output` | [`5a585a0a...`](https://stellar.expert/explorer/testnet/tx/5a585a0acd9c198a2329cdd49e07439f4e5c6411cbff14fec9f5be9a44b71bcc) | ❌ FAILED | `Error(Contract, #7)` EcvrfBetaMismatch |
| Tampered `gamma_point` | [`0f458c00...`](https://stellar.expert/explorer/testnet/tx/0f458c00640d422ea894f2030be97bb2050c2ca3ca97bfee8cc8cdb5a90623ee) | ❌ FAILED | `Error(Contract, #8)` EcvrfChallengeFail |

---

## 12. Security Considerations

### 12.1 On-Chain Verification Pipeline & Gas Cost

The `fulfill()` function executes a complete 3-tier cryptographic verification pipeline:

| Layer | What | Method | Cost |
|---|---|---|---|
| 1. BLS12-381 | drand signature verification | Native Soroban `pairing_check()` host function | ~20M instructions |
| 2. ECVRF | VRF proof verification (challenge + beta) | WASM (`k256` crate, Shamir's Trick) | ~91M instructions |
| 3. Ed25519 | Oracle signature binding | Native Soroban `ed25519_verify()` host function | ~1M instructions |
| 4. Alpha | Seed integrity (SHA256) | Native Soroban `sha256()` host function | ~1M instructions |
| 5. Storage | State reads/writes, TTL extensions, event publishing | Soroban storage host functions | ~21M instructions |
| **Total** | | | **~134M instructions** |

> The system operates efficiently within Soroban's instruction constraints. The ~134M instruction consumption was successfully validated on Stellar Testnet. Algorithmic optimizations (Shamir's Trick, deterministic `hashToCurve` hints) reduced the ECVRF WASM cost significantly, allowing the full verification pipeline to execute in a single transaction.

### 12.2 ECVRF Optimization Details

**Bottleneck 1: Non-deterministic `hashToCurve` (DoS Vector)**

The RFC 9381 Try-and-Increment method uses a loop to find a valid curve point. The oracle calculates the successful loop counter (`ctr_hint`) off-chain and submits it as part of the `EcvrfProof`. The contract validates the hint in O(1).

**Bottleneck 2: Expensive Scalar Multiplications**

Applied **Shamir's Trick (`lincomb`)** via the `k256` crate's `LinearCombination` trait. This merges two scalar multiplications per equation into a single multi-scalar multiplication, cutting 4 scalar mults to 2.

### 12.3 Modulo Bias in `derive_random()`

`derive_random()` returns a `u64` by taking the first 8 bytes of `SHA256(β ‖ context)`. This produces a uniform value in `[0, 2^64 - 1]`.

When a consumer reduces this to a smaller range (e.g., `result % 1000`), **modulo bias** occurs: `(2^64 mod 1000) / 2^64 ≈ 5.4 × 10⁻¹⁷` — negligible for most applications.

For high-stakes applications requiring provably uniform distribution, consumers should implement **rejection sampling** or use the full `BytesN<32>` from `get_proof().beta_output`.

### 12.4 Dual Key Management & Infrastructure Isolation

The oracle operates two distinct keypairs:

| Key | Curve | Purpose |
|---|---|---|
| Stellar auth key | Ed25519 | Transaction signing, `require_auth()` |
| VRF key | secp256k1 | ECVRF proof generation (Γ = x·H) |

**Production requirements:**
- Ed25519 transaction signing is isolated from the secp256k1 VRF signing environment
- The secp256k1 VRF key is managed in an isolated signing environment operationally separated from relay nodes
- Relay nodes never possess private key material

---

## 13. Soroban-Specific Constraints

### 13.1 Instruction Budget

The full `fulfill()` pipeline executes efficiently within Soroban's constraints, consuming ~134M instructions (successfully validated on Testnet at a cost of ~0.021 XLM).

> **Mainnet Consideration:** Before mainnet deployment, the `txMaxInstructions` network parameter on mainnet must be verified to support ≥134M instructions.

### 13.2 State Expiration (TTL) and Unfulfilled Requests

The contract implements auto-extend logic to maintain liveness against Soroban's TTL expiration mechanics. `extend_ttl()` is called for all storage entries on every interaction.

**TTL Constants:**
- `PERSISTENT_TTL_THRESHOLD`: 17,280 ledgers
- `PERSISTENT_TTL_EXTEND`: 518,400 ledgers
- `INSTANCE_TTL_THRESHOLD`: 17,280 ledgers
- `INSTANCE_TTL_EXTEND`: 518,400 ledgers
