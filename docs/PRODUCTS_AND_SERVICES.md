# Products & Services

Current status (MVP):
We currently have a simple MVP that proves feasibility on testnet (basic request, fulfillment, and deterministic derive flow).
- **Testnet Contract (Deployed June 12, 2026):** [CAUL2Y45FMGRSELVIO2QVNNJ4GQ4SQADY2QYTZCRW7K6YINU5QWLD2UT](https://stellar.expert/explorer/testnet/contract/CAUL2Y45FMGRSELVIO2QVNNJ4GQ4SQADY2QYTZCRW7K6YINU5QWLD2UT)
- **API Endpoint:** [https://soroban-vrf-api.onrender.com/api/vrf-requests](https://soroban-vrf-api.onrender.com/api/vrf-requests)

The plan below describes what we will build for production/mainnet.

## 1) Verifiable Randomness Oracle Contract (Soroban)

- **What we will build:**
  A production Soroban contract that accepts randomness requests from dApps, verifies cryptographic proofs on-chain, and exposes deterministic randomness outputs.

- **How Stellar is used:**
  Soroban smart contract execution, Soroban state storage for request lifecycle, and Stellar transactions for request/fulfill/finalization.

- **Impact on the project:**
  Moves randomness trust from backend logic to on-chain verification, enabling transparent and auditable outcomes.

## 2) On-Chain Consumer Callback Integration

- **What we will build:**
  A callback-compatible request path so application contracts can receive randomness via contract-to-contract invocation.

- **How Stellar is used:**
  Soroban contract invocation model and cross-contract calls will be used for app integration.

- **Impact on the project:**
  Makes the protocol composable for games, NFT mint logic, and DAO workflows without relying on HTTP-only flows.

## 3) drand-Backed Unbiasable Input Pipeline

- **What we will build:**
  Future-round drand binding so each request is linked to a deterministic upcoming drand round before fulfillment.

- **How Stellar is used:**
  Request metadata (context, requester, required round) is committed on-chain; fulfillment is accepted only when on-chain checks pass.

- **Impact on the project:**
  Reduces oracle manipulation risk and improves unpredictability before finalization.

## 4) Cryptographic Verification Layer (Native Host Function Verification)

- **What we will build:**
  On-chain verification of drand signatures and the oracle randomness proof using a unique-signature construction on BLS12-381 (gamma = sk * H_G1(alpha), verified via bilinear pairing equations), plus strict domain-separated derivation.

- **How Stellar is used:**
  Soroban BLS12-381 host cryptographic functions and transaction-level validation in contract logic.

- **Impact on the project:**
  Preserves security while staying within practical Soroban transaction budgets. The current MVP already executes the full on-chain verification pipeline (drand BLS12-381 pairing check + VRF BLS12-381 pairing check + Ed25519 binding + SHA-256 alpha reconstruction) at ~58M instructions on testnet — safely under the per-transaction limit with significant headroom. The production version extends this with callback dispatch, timeout/refund logic, and operational hardening.

## 5) Reliability and Safety Controls (Timeout/Refund + Monitoring)

- **What we will build:**
  Timeout/refund state transitions, fulfillment liveness controls, and operational monitoring for oracle workers.

- **How Stellar is used:**
  Timeout/refund conditions enforced by on-chain state and ledger time/round constraints.

- **Impact on the project:**
  Prevents stalled requests from becoming dead state and improves user trust in failure scenarios.
