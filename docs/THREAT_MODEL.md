# Stellar VRF — Threat Model

## Overview

The Soroban VRF Oracle provides verifiable randomness for on-chain applications on the
Stellar network. This document describes the trust assumptions, known risks, and
mitigations in place for the Tranche 2 (Testnet) milestone.

---

## System Components

```
┌──────────────┐    request_with_callback()    ┌─────────────────────┐
│   Consumer   │ ─────────────────────────────▶│  VRF Oracle Contract │
│   Contract   │                               │  (Soroban/on-chain)  │
└──────────────┘                               └─────────┬────────────┘
                                                         │ fulfill(proof, sig)
                                                         │
                                               ┌─────────▼────────────┐
                                               │   Oracle Worker Node  │
                                               │   (off-chain, TS)     │
                                               └─────────┬────────────┘
                                                         │ getPublicRandomness()
                                                         │
                                               ┌─────────▼────────────┐
                                               │   drand Network       │
                                               │   (distributed BLS)   │
                                               └──────────────────────┘
```

---

## Trust Boundaries

### 1. Single-Oracle Trust Boundary (Liveness vs. Bias)

| Property | Status | Details |
|---|---|---|
| **Bias resistance** | ✅ Cryptographic | Oracle cannot bias output: gamma is computed off-chain using the oracle's BLS SK, and verified on-chain via pairing check. Changing gamma would fail verification. |
| **Liveness** | ⚠️ Single point of failure | If the oracle node goes offline, requests time out after `TIMEOUT_ROUNDS` (20 drand rounds ≈ 60 seconds). Requester can reclaim via `timeout_refund()`. |
| **Frontrunning** | ✅ Mitigated | `round_offset ≥ 2` binds each request to a future drand round. The beacon is not yet published when the request is created, preventing pre-image knowledge. |
| **Replay** | ✅ Prevented | `request_id` is unique and monotonically incremented. `alpha_seed` is deterministically derived from `request_id + context + drand_round + sha256(drand_sig)`. |

### 2. drand Network Assumptions

The system trusts the drand quicknet BLS threshold signature chain for the following properties:

- **Unpredictability**: Future round outputs are unpredictable before the round timestamp.
- **Unbiasability**: drand uses a distributed BLS threshold scheme. No single node can bias the output.
- **Availability**: drand has operated at >99.9% uptime historically. Even if drand is briefly unavailable, the oracle worker will wait and retry for the correct round.

**Risk**: If the drand network is compromised or the chain key is rotated unexpectedly, the oracle owner must call `rotate_drand_pk()` to update the on-chain verification key.

### 3. Oracle Key Compromise

| Scenario | Impact | Mitigation |
|---|---|---|
| Oracle BLS SK leaked | Attacker can forge VRF proofs, biasing output | `rotate_oracle_keys()` allows immediate key rotation without redeployment |
| Oracle Ed25519 SK leaked | Attacker can craft valid `signature` parameter | `rotate_oracle_keys()` rotates all three key fields atomically |
| Oracle Stellar address compromised | Attacker controls `oracle_addr.require_auth()` | `rotate_oracle_keys()` — current oracle must sign rotation |

> **Note on rotation**: After key rotation, any unfulfilled requests locked to the old oracle PK will fail `fulfill()` verification (oracle key mismatch). These must be timeout-refunded by their requesters. This is an acceptable trade-off for security hardening.

---

## Attack Scenarios & Mitigations

### A. Duplicate Fulfillment (Replay Attack)
- **Attack**: Oracle submits `fulfill()` twice for the same request.
- **Mitigation**: `DataKey::Fulfilled(request_id)` is checked and set atomically in the
  **Effects** phase (before callback). Second call panics with `"already fulfilled"`.

### B. Malicious Callback Re-entrancy
- **Attack**: Consumer callback calls `fulfill()` again for the same or different request.
- **Mitigation**: `DataKey::Fulfilling(request_id)` is set before the callback. Any
  re-entrant `fulfill()` call will see `Fulfilled = true` and panic. This is the CEI
  (Checks-Effects-Interactions) pattern.

### C. Invalid Signature Forgery
- **Attack**: Malicious fulfiller tries to forge an Ed25519 or BLS signature.
- **Mitigation**: On-chain `ed25519_verify()` and `bls12_381_pairing_check()` host functions
  provide cryptographic guarantees. Forgery is computationally infeasible.

### D. Alpha Seed Manipulation
- **Attack**: Oracle provides a crafted `alpha_seed` to bias the VRF output.
- **Mitigation**: `alpha_seed` is re-derived on-chain from `request_id + context + drand_round + sha256(drand_sig)` and compared to the proof. Any manipulation fails.

### E. Timeout Griefing
- **Attack**: Requester calls `timeout_refund()` prematurely to invalidate a valid request.
- **Mitigation**: `timeout_refund()` checks `current_round > required_round + TIMEOUT_ROUNDS`. Ledger timestamp is consensus-determined and cannot be manipulated by the requester.

### F. Double Refund
- **Attack**: Requester calls `timeout_refund()` twice.
- **Mitigation**: `DataKey::Refunded(request_id)` is checked; second call panics with `"already refunded"`.

### G. Storage Expiration During Fulfillment Window
- **Attack**: Persistent storage entries expire before the oracle can fulfill.
- **Mitigation**: `request_internal()` extends TTL for all entries by `PERSISTENT_TTL_EXTEND` (518,400 ledgers ≈ 30 days). `fulfill()` extends again on completion.

---

## Out of Scope (Deferred to Mainnet / Tranche 3)

| Item | Reason |
|---|---|
| Multi-oracle threshold scheme | Architecture change; not needed for testnet validation |
| Fee payment / SAC token transfer | Payment rail design is separate work item |
| drand chain migration automation | Operational concern, handled by `rotate_drand_pk()` |
| Consumer contract formal verification | Future audit scope |

---

## Summary Risk Rating

| Risk | Likelihood | Impact | Residual Risk |
|---|---|---|---|
| Oracle liveness failure | Low | Medium | Acceptable (timeout exists) |
| Oracle key compromise | Very Low | High | Mitigated (rotation support) |
| drand network failure | Very Low | Medium | Acceptable (retry + timeout) |
| Cryptographic break (BLS/Ed25519) | Negligible | Critical | N/A |
| Re-entrancy via callback | Low | High | Mitigated (CEI + Fulfilling guard) |
| Modulo bias in derive_random | N/A | Medium | Eliminated (rejection sampling) |
