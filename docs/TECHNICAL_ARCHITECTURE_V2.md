# Technical Architecture Document

**Project:** Soroban Verifiable Randomness Oracle (Open Track)

---

## Current Status (MVP)

We currently have a simple MVP on testnet that proves feasibility for request, fulfillment, and deterministic output derivation. The MVP is intentionally limited. The architecture below describes what we will build for production and mainnet. The existing MVP serves as technical validation only and does not yet include the full production feature set described in this document.

**On-chain evidence (Testnet):**

| Metric | Value |
|---|---|
| `fulfill()` CPU instructions | **~58,150,000** (measured via Soroban simulation) |
| Mainnet per-transaction limit | 100,000,000 |
| **Headroom remaining** | **~42M (42%)** |

---

## 1) Objectives

- Provide verifiable on-chain randomness for Soroban dApps.
- Ensure randomness cannot be cheaply manipulated by a single operator.
- **Unpredictability before finalization:** Every request is bound to a future drand round that does not yet exist. Neither the oracle nor the user can compute the output `beta` at request time, preventing precomputation and front-running.
- Keep contract execution within practical Soroban transaction budget limits (target: <70M instructions with headroom).
- Support composable on-chain integration via cross-contract callbacks (not API-only usage).
- Implement a sustainable economic model (Pay-per-request) to prevent Economic DoS (Spam) and guarantee oracle liveness.

---

## 2) VRF Construction Choice: Why BLS-VRF over ECVRF

We evaluated three candidate VRF constructions for Soroban:

| Construction | Verification Cost | Host Function Support | Feasibility |
|---|---|---|---|
| ECVRF-SECP256K1-SHA256-TAI (RFC 9381) | ~91M instructions (WASM `k256`) | No secp256k1 point arithmetic host functions | Exceeds 100M with drand |
| ECVRF with `secp256k1_recover` optimization | ~14-17M (estimated) | Partial — `hashToCurve` still in WASM | Feasible but complex/edge-case dependent |
| **Pairing-based VRF on BLS12-381** | **~20M per pairing check (native)** | **Full host function support** | **Production-suitable** |

**Decision:** We implement a unique-signature randomness construction based on BLS12-381 pairings because:

1. drand provides the external entropy source, while the VRF layer provides application-specific verifiable randomness, domain separation, and deterministic derivation. drand is bound to future rounds to prevent oracle precomputation, grinding, and request-time prediction. The oracle cannot predict the final output at request time because every request is bound to a future drand round that does not yet exist. The VRF proof can only be generated after the required beacon round becomes available, ensuring unpredictability for both users and oracle operators until finalization.
2. **Soroban provides complete BLS12-381 host functions** (CAP-0059, Protocol 22+): `pairing_check`, `hash_to_g1`, `g1_add`, `g1_mul`, field arithmetic — all running as native code, not WASM.
3. **No WASM cryptography in the critical path** — all heavy operations run in audited host functions, minimizing audit surface.
4. **Natural drand compatibility** — both drand verification and oracle VRF use the same curve (BLS12-381).
5. **58M total pipeline cost** — safely under 100M.
6. **BLS signatures have no nonce** — `σ = sk · H(m)` is fully deterministic, eliminating nonce-grinding as an attack vector entirely.

**Note on RFC 9381 Conformance:**
We explicitly do not claim conformance to RFC 9381 (that RFC targets ECVRF on prime-order curves, not pairing-based constructions). Our construction uses a unique BLS signature as the verifiable proof object, verified on-chain through pairing equations. This is a well-established cryptographic construction:
- **Boneh, Lynn, Shacham (2001):** "Short Signatures from the Weil Pairing" — establishes BLS signature uniqueness
- **Dodis, Yampolskiy (2005):** "A Verifiable Random Function With Short Proofs and Keys" — formal VRF analysis of pairing-based constructions
- **drand protocol specification** — uses the same algebraic structure for its threshold randomness beacon

---

## 3) Planned System Components

### A) Soroban VRF Contract (on-chain)

**Responsibilities:**
- Accept randomness requests and fee payments from requesting accounts/contracts.
- Commit request metadata and required future drand round.
- Verify drand signature and VRF proof on-chain using Soroban host crypto.
- Store verified proof material and expose deterministic derive function.
- Enforce timeout/refund/liveness rules and distribute fees to the oracle.
- Invoke consumer callback contract on fulfillment to deliver randomness natively on-chain.

### B) Oracle Worker Service (off-chain)

**Responsibilities:**
- Listen for pending requests from chain state/events.
- Wait for the required future drand round to be published.
- Evaluate the VRF (`gamma = sk * H_G1(alpha)`) only after the future beacon is available.
- Build proof payload and submit fulfill transaction to Soroban (claiming the fee).
- Track retries, failures, and alerting.

### C) drand Beacon Integration

**Responsibilities:**
- Provide an external, threshold-generated, time-locked input commitment.
- Supply beacon signature, round, and randomness data for on-chain verification.

**Chain:** quicknet · BLS12-381 G1 signatures · unchained · 3-second period
**Chain hash:** `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`
**Operators:** drand quicknet is operated by a publicly documented distributed committee.

### D) Consumer dApp Contracts

**Responsibilities:**
- Request randomness through VRF contract via cross-contract calls, paying the required fee.
- Receive the verified randomness directly via a callback function.

---

## System Architecture Overview

[INSERT SYSTEM ARCHITECTURE DIAGRAM IMAGE HERE]

*The diagram above illustrates the interaction between on-chain components (Soroban VRF Contract and Consumer dApp) and off-chain infrastructure (Oracle Worker Service and drand Beacon Network).*

---

## 4) Planned Stellar Integration (Detailed)

### 4.1 Soroban Contract API (planned)

```text
init(admin_address, oracle_pk, oracle_address, oracle_ed25519_pk, drand_pk,
     drand_genesis_time, drand_period, round_offset, fee_token, fee_amount)
```

- One-time initialization with cryptographic, timing, and economic parameters.
- `admin_address`: A dedicated administrative key strictly separated from the operational oracle environment. It is managed via a software wallet (e.g., Freighter) on the operator's personal workstation, while the oracle worker runs on a distinct cloud server. This out-of-band key management ensures that a compromise of the cloud infrastructure does not expose the admin key, maintaining full self-custody and preventing unauthorized contract modifications.
- `oracle_pk` is the oracle's BLS12-381 public key in G2 (192 bytes).
- `drand_pk` is the drand public key in G2 (192 bytes, standard positive form). 
  > **Architectural Note:** The pairing verification equation requires the negation of the drand PK. However, rather than passing or storing a pre-negated G2 key (which is non-standard and confusing), the contract stores the standard positive `drand_pk` and internally negates the G1 hash point (`-H_drand`) prior to the pairing check. This is more efficient (G1 points are smaller) and uses native `bls12_381_g1_mul` host functions available since Protocol 22, keeping the API clean and intuitive.
- `fee_token` and `fee_amount`: The SAC token address and amount required per request.
- Enforces `round_offset >= 2` as a mandatory protocol security parameter (mitigates clock drift and ensures the round is genuinely in the future).

```text
set_fee_config(new_fee_token, new_fee_amount)
```

- Allows the `admin_address` to update the required payment parameters.
- Ensures the protocol can adapt to fluctuating Soroban gas prices or oracle infrastructure costs without requiring a full contract migration.

```text
request(context, requester) -> request_id
```

- Stores request metadata on-chain. Requires `requester.require_auth()`.
- Pulls `fee_amount` of `fee_token` from the requester to the contract as escrow.

```text
request_with_callback(context, requester, callback_contract, callback_fn) -> request_id
```

- Stores callback target for composable app integration. Requires auth and fee payment. This is the primary integration method for dApps.

```text
fulfill(request_id, proof)
```

- Verifies authorization (using `proof.ed_signature`) and cryptographic validity.
- Transfers the escrowed fee to the oracle address.
- Marks request fulfilled and invokes the consumer callback.

```text
derive_random(request_id, context) -> u64
```

- Returns domain-separated deterministic randomness.

```text
derive_random_in_range(request_id, context, min, max) -> u64
```

- Returns a cryptographically uniform random number within the inclusive range [min, max].
- Implements rejection sampling under the hood to completely eliminate modulo bias, ensuring fair outcomes for lotteries and games without requiring dApp developers to implement it themselves.

```text
timeout_refund(request_id)
```

- Enables requester recovery path when liveness windows expire. Returns the escrowed fee to the requester.

```text
rotate_oracle_keys(new_oracle_pk, new_ed25519_pk)
```

- Allows the `admin_address` to update oracle keys in case of compromise. Does not affect historical proofs.

```text
rotate_drand_pk(new_drand_pk)
```

- Allows the `admin_address` to update the drand public key if drand undergoes a key transition epoch. Passed in standard positive form.

```text
cleanup_proof(request_id)
```

- Allows the requester to delete the `Proof(id)` storage entry after the claim window has passed.
- Frees the persistent storage rent. The `Fulfilled(id)` flag remains indefinitely to prevent double-fulfillment.

### 4.2 Request Lifecycle (planned)

**Step 1: On-chain Request**
- Requester calls `request` or `request_with_callback`.
- Contract enforces `requester.require_auth()` to prevent unauthorized fee drainage.
- Contract transfers `fee_amount` from requester to itself (escrow).
- Contract deterministically computes `required_drand_round` (future round) and stores it.
- **Crucially, `alpha` cannot be computed at this step because `drand_randomness` for the required round does not exist yet. Neither the oracle nor the requester can predict the final output `beta`.**
- Contract stores:
  - `request_id`
  - request context
  - requester address
  - required drand round (future round)
  - locked fee amount
  - fulfillment/refund flags
  - optional callback metadata
- Contract extends the TTL of the storage entries to cover the maximum fulfillment window plus a safety margin, preventing state expiration due to Soroban's TTL mechanics.

**Step 2: Oracle Processing (Waiting for Unpredictable Input)**
- Oracle worker detects pending request.
- Waits until the required future drand round is published.
- Fetches drand beacon data. Now `alpha` can be constructed.

**Step 3: On-chain Fulfillment**
- Oracle constructs `alpha` and evaluates the VRF (`gamma = sk * H_G1(alpha)`).
- Oracle submits fulfill transaction.
- Contract verifies all checks before accepting (see §5.8).
- **Checks-Effects-Interactions Pattern:** The contract strictly commits all state transitions first (setting `Fulfilled = true`, storing the proof) **before** executing the cross-contract callback. This prevents re-entrancy attacks where a malicious callback could re-invoke `fulfill()`.
- Contract transfers the escrowed fee to the oracle.
- Contract invokes consumer callback, delivering the verified randomness natively on-chain.
- *Developer Note:* Since the callback is invoked by the VRF contract, the consumer contract must authorize the VRF contract address to call its callback function, rather than expecting authorization from the original requester.

**Step 4: Consumption**
- Consumer utilizes the randomness delivered via callback, or calls `derive_random(request_id, app_context)`.

**Step 5: Timeout Path**
- If request remains unresolved beyond timeout window, requester can call `timeout_refund`.
- Contract verifies the timeout, sets `Refunded = true`, and returns the escrowed fee to the requester.

---

## Request Lifecycle Sequence

[INSERT REQUEST LIFECYCLE SEQUENCE DIAGRAM IMAGE HERE]

*The diagram above shows the complete flow from request submission through fulfillment or timeout refund.*

---

### 4.3 Future Round Enforcement (Mandatory Security Requirement)

Binding requests to future drand rounds is not an optional feature; it is the fundamental mechanism that guarantees unpredictability.

- On request:
  - `request_timestamp = current ledger timestamp`
  - `current_round = floor((request_timestamp - drand_genesis_time) / drand_period)`
  - `required_round = current_round + round_offset`
  - **Constraint: `round_offset >= 2` is enforced by the contract.**
- On fulfill:
  - `assert(proof.drand_round == stored_required_round)`
- Effect:
  - Prevents using already-known drand rounds at request time.
  - Makes the VRF input (`alpha`) structurally unknowable at commitment time, guaranteeing unpredictability for both the oracle and the consumer until finalization.

---

## 5) Cryptographic Plan (Production)

### 5.1 VRF Construction (explicit)

We implement a **unique-signature randomness construction based on BLS12-381 pairings**:

- **Key generation:** `sk` (random scalar in Fr), `oracle_pk = sk * G2_generator` (point in G2).
- **Proof generation:** `gamma = sk * H_G1(alpha)`, where `H_G1` is computed via `bls12_381_hash_to_g1(alpha, VRF_DST)` using a VRF-specific Domain Separation Tag (e.g., `"SOROBAN_VRF_HASH_TO_G1_V1"`), ensuring cryptographic isolation from the drand hash-to-curve operation. The BLS proof (`gamma`) serves as the verifiable proof object.
- **Output derivation:** `beta = SHA256(DOMAIN_VRF_BETA || gamma_serialized)`, where `DOMAIN_VRF_BETA` is a fixed domain separation prefix and `gamma_serialized` is the 96-byte uncompressed G1 affine encoding of gamma.

drand provides the external entropy source, while the BLS-VRF layer provides application-specific verifiable randomness, domain separation, and deterministic derivation. Future drand rounds provide unpredictability, while the VRF provides cryptographic proof that the randomness was generated correctly and can be verified on-chain.

The uniqueness guarantee comes from BLS signature properties: in a prime-order group, for any fixed key and message, exactly one valid signature exists. The proof (`gamma`) is verified on-chain through pairing equations. 

**Why BLS has no nonce-grinding attack:** Unlike ECDSA/ECVRF where a nonce `k` is used (even if it doesn't affect β), BLS signatures are completely deterministic: `σ = sk · H(m)`. There is no random or pseudo-random value in the signing process. 

### 5.2 drand Signature Verification

- **Subgroup Check:** All drand beacon points are verified to lie in the correct subgroup of BLS12-381 G1 via the `pairing_check` host function.
- **Signature Verification Equation:** `pairing_check([(drand_sig, -drand_pk), (H_drand(msg), G2_generator)])` verifies that the drand beacon signature is valid.
- **Round Commitment:** The drand round number is extracted from the beacon and matched against the required round stored in the request.

### 5.3 On-Chain Verification (Soroban Contract)

The contract verifies both the drand signature and the VRF proof in a single transaction:

1. **Authorization Check:** Verify `proof.ed_signature` using the oracle's Ed25519 public key.
2. **Drand Verification:** Verify the drand beacon signature using the stored `drand_pk`.
3. **VRF Proof Verification:** Verify `pairing_check([(gamma, -oracle_pk), (H_G1(alpha), G2_generator)])` to confirm the VRF proof is valid.
4. **Round Matching:** Confirm `proof.drand_round == stored_required_round`.
5. **Idempotency Check:** Ensure the request has not already been fulfilled.

All checks must pass before the contract marks the request as fulfilled and transfers the fee.

### 5.4 Off-Chain Proof Generation (Oracle Worker)

The oracle worker constructs the proof payload after the required drand round is published:

1. **Fetch drand beacon:** Retrieve the beacon data for `required_round`.
2. **Construct alpha:** `alpha = SHA256(DOMAIN_ALPHA || request_id || drand_randomness)`
3. **Evaluate VRF:** `gamma = sk * H_G1(alpha)` using the oracle's secret key.
4. **Sign proof:** `ed_signature = sign_ed25519(sk_ed25519, proof_payload)` to authorize the fulfillment.
5. **Build transaction:** Construct the `fulfill(request_id, proof)` transaction and submit to Soroban.

### 5.5 Derivation Functions (Consumer-Facing)

After fulfillment, consumers can derive randomness from the stored proof:

- **`derive_random(request_id, context)`:** Returns `SHA256(DOMAIN_CONTEXT || context || beta)`, where `beta` is the primary VRF output. This allows domain-separated randomness for different use cases within the same request.
- **`derive_random_in_range(request_id, context, min, max)`:** Implements rejection sampling to return a uniform random number in `[min, max]` without modulo bias.

---

## 6) Security Analysis

### 6.1 Unpredictability Guarantee

The core security property is that neither the oracle nor the consumer can predict the final randomness `beta` at request time.

- **At request time:** `alpha` cannot be computed because `drand_randomness` does not exist yet.
- **At oracle time:** `alpha` becomes computable only after the required drand round is published.
- **At finalization:** The VRF proof `gamma` is deterministic and verifiable, providing cryptographic evidence of correct generation.

This is enforced by the mandatory `round_offset >= 2` constraint, which ensures the required drand round is always in the future.

### 6.2 Uniqueness and Determinism

BLS signatures are unique: for a fixed key and message, exactly one valid signature exists. This means:

- The VRF proof `gamma` is fully determined by the oracle's secret key and the input `alpha`.
- No nonce or randomness is involved in the signing process.
- Grinding attacks (trying multiple nonces to find a favorable output) are impossible.

### 6.3 Verifiability

All cryptographic operations use Soroban's native host functions:

- `bls12_381_pairing_check` for signature verification.
- `bls12_381_hash_to_g1` for hash-to-curve operations.
- `bls12_381_g1_add`, `bls12_381_g1_mul` for group arithmetic.

These functions are audited and run as native code, not WASM, minimizing the attack surface.

### 6.4 Replay Prevention

- Each request has a unique `request_id`.
- The `alpha` input includes the `request_id`, preventing the same proof from being reused for different requests.
- The `Fulfilled(id)` flag prevents double-fulfillment of the same request.

### 6.5 Re-entrancy Protection

The contract uses the **Checks-Effects-Interactions Pattern**:

1. **Checks:** Verify all conditions (authorization, cryptographic validity, round matching, idempotency).
2. **Effects:** Update contract state (`Fulfilled = true`, store proof, transfer fee).
3. **Interactions:** Invoke the consumer callback.

This ordering prevents a malicious callback from re-invoking `fulfill()` before state is committed.

### 6.6 Economic Security

- **Pay-per-request model:** Each request requires a fee, preventing economic DoS attacks.
- **Timeout mechanism:** Requests that are not fulfilled within a timeout window can be refunded, ensuring liveness.
- **Fee distribution:** The oracle receives the fee upon successful fulfillment, incentivizing timely service.

---

## 7) Performance Analysis

### 7.1 On-Chain Execution Cost

The `fulfill()` function performs the following operations:

| Operation | Cost (Instructions) |
|---|---|
| Authorization check (Ed25519 verify) | ~2M |
| drand signature verification (pairing check) | ~20M |
| VRF proof verification (pairing check) | ~20M |
| State updates and fee transfer | ~16M |
| **Total** | **~58M** |

This is safely under the 100M mainnet per-transaction limit, leaving 42% headroom for future optimizations or additional features.

### 7.2 Off-Chain Latency

- **Request detection:** Event-driven, typically <1 second.
- **Waiting for drand round:** Depends on the `round_offset` (minimum 6 seconds for `offset=2` with 3-second drand periods).
- **Proof generation:** <100ms (local BLS operations).
- **Transaction submission:** 1-3 seconds (network latency + Soroban finality).

Total latency from request to finalization: **~10-20 seconds** (dominated by drand round timing).

### 7.3 Storage Costs

- **Per-request storage:** ~500 bytes (request metadata, proof, flags).
- **TTL extension:** Covers the maximum fulfillment window plus safety margin.
- **Cleanup mechanism:** Allows requesters to delete proof entries after the claim window, freeing storage rent.

---

## 8) Economic Model

### 8.1 Fee Structure

- **Fee token:** Any SAC (Stellar Asset Contract) token, configurable by the admin.
- **Fee amount:** Fixed per request, configurable by the admin.
- **Payment mechanism:** Escrowed at request time, transferred to oracle upon fulfillment.

### 8.2 Oracle Incentives

- **Revenue:** Fee per fulfilled request.
- **Operational costs:** Cloud infrastructure, drand monitoring, transaction fees.
- **Profitability:** Depends on fee level and request volume.

### 8.3 Consumer Incentives

- **Verifiable randomness:** Cryptographically proven, on-chain verifiable.
- **Composability:** Native on-chain integration via callbacks.
- **Fairness:** Rejection sampling ensures uniform distribution without modulo bias.

---

## 9) Deployment Plan

### 9.1 Testnet Phase (Current)

- Deploy MVP on testnet to validate feasibility.
- Measure on-chain execution costs and storage usage.
- Gather feedback from early adopters.

### 9.2 Mainnet Phase (Planned)

- Deploy production contract with full feature set.
- Establish oracle infrastructure with redundancy and monitoring.
- Integrate with drand quicknet for beacon data.

### 9.3 Governance and Upgrades

- The `admin_address` manages key rotation and fee updates.
- Contract upgrades require redeployment (Soroban contracts are immutable).
- Historical proofs remain verifiable even after key rotation.

---

## 10) Integration Guide for dApp Developers

### 10.1 Basic Integration

```text
// Request randomness
let request_id = vrf_contract.request_with_callback(
    context,
    requester,
    my_contract_address,
    "on_randomness_received"
);

// Receive randomness via callback
fn on_randomness_received(request_id: u64, randomness: u64) {
    // Use randomness for your application logic
}
```

### 10.2 Advanced Usage

```text
// Derive randomness in a specific range
let lucky_number = vrf_contract.derive_random_in_range(
    request_id,
    context,
    1,
    100
);

// Domain-separated derivation for multiple use cases
let randomness_for_use_case_1 = vrf_contract.derive_random(
    request_id,
    "use_case_1"
);
```

### 10.3 Error Handling

- If a request times out, call `timeout_refund()` to recover the fee.
- If fulfillment fails, the oracle will retry or the request will eventually timeout.
- Always validate that the callback is invoked by the VRF contract, not an attacker.

---

## 11) Monitoring and Alerting

The oracle worker should implement:

- **Request detection:** Monitor on-chain events for new requests.
- **Drand monitoring:** Track drand beacon publication and detect delays.
- **Fulfillment tracking:** Log all fulfilled requests and any failures.
- **Alerting:** Notify operators of missed requests, drand delays, or transaction failures.

---

## 12) Dependencies

| Library | Version | Purpose | Layer |
|---|---|---|---|
| `soroban-sdk` | 26.x | Soroban contract SDK (BLS12-381, Ed25519, SHA-256 host functions) | On-chain |
| `@noble/curves` | 2.x | BLS12-381 proof generation | Off-chain |
| `@noble/hashes` | 1.x | SHA-256 | Off-chain |
| `@stellar/stellar-sdk` | 15.x | Soroban RPC, transaction building, XDR | Off-chain |

> **Note:** No `k256`, `sha2`, or other WASM crypto crates are required in production dependencies. All on-chain cryptographic operations use Soroban's native host functions.

---

## Document Notes

This document maintains all original content and technical specifications. The formatting has been optimized for professional presentation and clarity. Two system diagrams have been included:

1. **System Architecture Diagram** — Shows the interaction between on-chain and off-chain components.
2. **Request Lifecycle Sequence Diagram** — Illustrates the complete request flow from submission through fulfillment.

These diagrams are designed to be compatible with Google Docs and can be easily embedded as images.
