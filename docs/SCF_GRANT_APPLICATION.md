# SCF Grant Application — Soroban-VRF

---

## Products & Services

**Soroban-VRF** is one of the first Verifiable Random Function (VRF) oracle systems on Stellar with **fully on-chain cryptographic proof verification**. It provides cryptographically verifiable randomness with a single-operator liveness assumption, enabling use cases like fair lotteries, NFT trait generation, on-chain gaming, and unbiased governance selection.

Unlike traditional oracle designs that require off-chain trust assumptions for proof validity, Soroban-VRF performs its cryptographic verification on-chain: BLS12-381 pairing verification of drand signatures, ECVRF proof verification with secp256k1, and Ed25519 oracle signature binding. The oracle cannot forge proofs, fabricate drand data, or substitute keys. This reduces the trust model to two remaining assumptions: the drand network's threshold security (2/3 honest operators), and the oracle's liveness/round selection (to be addressed in Tranche 1).

### Core Features:

**1. On-Chain Cryptographic Verification**
The contract executes a complete cryptographic verification pipeline on-chain:
- **BLS12-381 pairing check** of drand (League of Entropy) signatures via native Soroban host functions.
- **ECVRF (RFC 9381) proof verification** via the `k256` Rust crate in WASM.
- **Ed25519 signature verification** via native Soroban host function to bind proof data to the oracle identity.
- **Typed `ContractError` diagnostics** (e.g., `Error(Contract, #7)` for `EcvrfBetaMismatch`) for precise on-chain failure identification.
- **Impact on project:** By shifting verification from trusted off-chain APIs to on-chain smart contracts, Soroban-VRF meets the strict verifiability prerequisites of high-stakes DeFi and Gaming protocols.

**2. Commit-Reveal with drand Entropy Binding**
The contract binds VRF inputs to drand beacon data. The alpha seed is derived on-chain, and the drand signature is verified via BLS pairing.
- **Stellar usage:** Verifies the hardcoded drand public key on-chain.
- **Impact on project:** The VRF cryptography mathematically prevents the oracle from changing the output for any given round. While the oracle currently retains the ability to select *when* to fulfill (round-grinding), the planned deterministic round selection (Tranche 1) will close this vector, establishing a robust commit-reveal architecture.

**3. Censorship Mitigations & Capital Safety**
The MVP uses a single-operator architecture. Censorship is mitigated through planned fulfillment deadlines with verifiable on-chain refund claims and redundant relay infrastructure.
- **Stellar usage:** Leverages Soroban's deterministic `ledger_sequence` for immutable deadline enforcement and on-chain request state for transparent performance data.
- **Impact on project:** Acknowledges the liveness limitations of single-operator systems and mitigates them with verifiable uptime metrics and capital-safe refund mechanics.

**4. Optimized WASM Execution**
Through algorithmic optimizations, the verification pipeline operates efficiently within Soroban's instruction constraints (validated on Testnet).
- **Stellar usage:** Uses Soroban's native host functions for BLS12-381 and Ed25519, while ECVRF secp256k1 arithmetic runs in optimized WASM.
- **Impact on project:** Makes on-chain VRF verification economically viable on Stellar at a cost comparable to standard DeFi interactions.

**5. Domain-Separated Developer SDK**
dApps request randomness once and derive multiple independent random values via `derive_random(request_id, context)`.
- **Stellar usage:** Integrates natively via `@stellar/stellar-sdk` and Soroban cross-contract calls.
- **Impact on project:** Reduces integration friction and cost. The ability to generate multiple independent random outputs from a single on-chain proof makes the service highly attractive to complex dApps.

---

## On-Chain Evidence (Stellar Testnet)

The core cryptographic pipeline is implemented and validated on Testnet with both positive and negative test evidence:

| Test | TX Hash | Status | Evidence |
|---|---|---|---|
| Valid proof (full pipeline) | [`7559ec1a...`](https://stellar.expert/explorer/testnet/tx/7559ec1af9f6de53f51e93f7d5fccddf0148610bcf34566bf9e5267749646be3) | ✅ SUCCESS | BLS + ECVRF + Ed25519 verified |
| Tampered `beta_output` | [`5a585a0a...`](https://stellar.expert/explorer/testnet/tx/5a585a0acd9c198a2329cdd49e07439f4e5c6411cbff14fec9f5be9a44b71bcc) | ❌ FAILED | `Error(Contract, #7)` — EcvrfBetaMismatch |
| Tampered `gamma_point` | [`0f458c00...`](https://stellar.expert/explorer/testnet/tx/0f458c00640d422ea894f2030be97bb2050c2ca3ca97bfee8cc8cdb5a90623ee) | ❌ FAILED | `Error(Contract, #8)` — EcvrfChallengeFail |

---

## Open Track Deliverables & Budget

**Total Budget Request: $75,000 in XLM**

> Note: The core cryptographic pipeline (BLS12-381 + ECVRF) is implemented and validated on Testnet. The remaining budget focuses on hardening for production, implementing economic security guarantees, and launching on Mainnet.

---

### Tranche #0 (Upon Approval) — 10% = $7,500

Foundation setup: finalize development environment, and set up CI/CD pipeline for automated WASM builds and Testnet deployments.

---

### Tranche #1 Deliverables — 20% = $15,000

**Milestone: Anti-Front-Running + Timeout Refunds**

**[Deliverable 1.1] Deterministic drand Round Selection (Anti-Front-Running)**
Implement the on-chain drand round computation: `required_round = floor((ledger_timestamp - DRAND_GENESIS) / DRAND_PERIOD) + 2`. The contract stores the required round at `request()` time and rejects any proof that uses a different round.
- **Measurement:** Unit tests proving the contract rejects proofs with wrong drand rounds. Integration test on Testnet showing end-to-end commit-reveal flow.
- **Budget:** $5,000

**[Deliverable 1.2] Fulfillment Deadline & Refund Mechanism**
Implement a ledger-sequence-based fulfillment deadline. If the oracle fulfills in time, it receives the fee. If the deadline passes, the request is marked expired, and the user can claim a refund via `timeout_refund()`.
- **Measurement:** Test suite covering successful fulfillment, timeouts, and TTL persistence.
- **Budget:** $5,000

**[Deliverable 1.3] Oracle Service Hardening**
Update the TypeScript oracle service to fetch exactly the contract-specified drand round, handle fulfillment deadlines with automatic retry logic, and include comprehensive error handling.
- **Measurement:** Oracle successfully fulfills 100 consecutive requests on Testnet with correct drand rounds and no timeouts.
- **Budget:** $5,000

**Tranche #1 Completion Date:** 15/08/2026

---

### Tranche #2 Deliverables — 30% = $22,500

**Milestone: High-Availability Oracle Network + Developer SDK + Testnet Stress Test**

**[Deliverable 2.1] High-Availability Decoupled Oracle Infrastructure**
Transition from a single-node oracle to a fault-tolerant, high-availability infrastructure. Multiple independent relay nodes monitor the contract and fetch drand entropy, offloading signing to an isolated service.
- **Measurement:** 3+ independent relay nodes running on Testnet maintaining 100% fulfillment rate during intentional node outages.
- **Budget:** $8,000

**[Deliverable 2.2] Developer SDK & Documentation**
Publish an npm package (`@soroban-vrf/sdk`) with TypeScript functions: `requestRandomness()`, `getResult()`, `verifyProof()`.
- **Measurement:** Published npm package with >90% test coverage. Documentation site with integration tutorials and a reference dApp.
- **Budget:** $7,500

**[Deliverable 2.3] Testnet Stress Test & Performance Report**
Run 1,000+ randomness requests through the full pipeline on Testnet. Measure and document average fulfillment latency, gas cost distribution, failure rate, and HA failover dynamics.
- **Measurement:** Published benchmark report. All 1,000+ requests fulfilled successfully.
- **Budget:** $7,000

**Tranche #2 Completion Date:** 15/10/2026

---

### Tranche #3 Deliverables — 40% = $30,000

**Milestone: Security Audit Remediation & Mainnet Launch**

**[Deliverable 3.1] Audit Remediation & Mainnet Deployment**
Submit code for the SCF-provided security audit. Remediate all critical/high findings. Deploy the optimized, audited WASM contract to Stellar Mainnet.
- **Measurement:** Zero high/critical audit findings remaining. Contract deployed and operational on Mainnet.
- **Budget:** $8,000

**[Deliverable 3.2] Production Oracle Infrastructure**
Deploy 3+ geographically distributed relay nodes with automated monitoring and failover. Implement isolated key management environments for Ed25519 and secp256k1 signing.
- **Measurement:** 99.5%+ uptime over a 2-week monitoring period. Automated alerts trigger within 60 seconds of failure.
- **Budget:** $10,000

**[Deliverable 3.3] Reusable Consumer Contract Library (On-Chain SDK)**
Develop and deploy a pre-audited Soroban smart contract library (e.g., VRFConsumer) to abstract the complexity of `request()`, handling callbacks, and consuming randomness.
- **Measurement:** Reusable crate published. A dApp can integrate verified randomness in under 30 minutes.
- **Budget:** $7,000

**[Deliverable 3.4] Research Publication & Open-Source Handoff**
Finalize all repositories as open-source. Publish Gas Optimization Research, Threat Model, and Technical Architecture Document.
- **Measurement:** Repositories public on GitHub. Research published and shared with the Stellar ecosystem.
- **Budget:** $5,000

**Tranche #3 Completion Date:** 15/12/2026

---

## Budget Summary

| Tranche | Amount | Timeline | Key Milestone |
|---|---|---|---|
| #0 (Approval) | $7,500 (10%) | June 2026 | Setup & CI/CD |
| #1 | $15,000 (20%) | Aug 15, 2026 | Anti-front-running + Timeout refund |
| #2 | $22,500 (30%) | Oct 15, 2026 | HA Oracle Network + SDK + Stress test |
| #3 | $30,000 (40%) | Dec 15, 2026 | **Mainnet launch** + Production ops |
| **Total** | **$75,000** | **~6 months** | |
