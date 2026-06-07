# SCF Grant Application — Soroban-VRF

---

## Products & Services

**Soroban-VRF** is the first Verifiable Random Function (VRF) oracle with full on-chain cryptographic proof verification on Stellar. It provides tamper-proof, provable randomness as a plug-and-play service for any Soroban smart contract — enabling use cases like fair lotteries, NFT trait generation, on-chain gaming, and unbiased governance selection.

### Core Features:

**1. On-Chain VRF Verification**
Full ECVRF (RFC 9381) proof verification executes directly inside the Soroban smart contract using the `k256` Rust crate, removing the need for off-chain trust assumptions about the proof's validity.
- **Stellar usage:** Utilizes Soroban's WASM runtime for deterministic EC arithmetic and host functions (SHA-256, Ed25519) to verify proofs entirely on-chain.
- **Impact on project:** Establishes Soroban-VRF as the first *verifiable* randomness oracle on Stellar. This shifts our product from a "trusted API" to "verifiable infrastructure," which is a strict prerequisite for high-stakes DeFi and Gaming protocols to integrate with our service.

**2. Commit-Reveal with Deterministic Entropy Binding**
The contract dictates exactly which drand beacon round must be used, computed deterministically from the ledger timestamp, removing the oracle's freedom to choose or grind inputs.
- **Stellar usage:** Binds requests to `env.ledger().timestamp()` and `sequence()` to mathematically enforce the use of a future, unpredictable drand round.
- **Impact on project:** Secures our project against manipulation claims. By cryptographically guaranteeing that neither the oracle nor the user can predict the outcome, we eliminate the front-running vulnerabilities that have plagued competing VRFs, protecting our reputation and driving enterprise adoption.

**3. Censorship Mitigations & Capital Safety**
The MVP uses a single-operator architecture. Censorship is mitigated through fulfillment deadlines with automatic refunds and redundant relay infrastructure. Full cryptographic censorship resistance requires Threshold VRF / DKG and is a post-mainnet milestone.
- **Stellar usage:** Leverages Soroban's deterministic `ledger_sequence` for immutable deadline enforcement and on-chain request state (fulfilled/expired) for transparent, publicly queryable performance data.
- **Impact on project:** Builds trust through honesty. By transparently acknowledging the known limitation of single-operator systems (shared by Chainlink VRF v1 and all single-key oracles) and providing verifiable uptime metrics, we establish credibility with sophisticated users who value engineering maturity over overclaiming.

**4. Ultra-Low-Cost WASM Optimization**
Through Shamir's Trick (`lincomb`) and deterministic hashToCurve hints, ECVRF verification runs at 91.7M instructions (under the 100M limit) for ~$0.004 per tx.
- **Stellar usage:** Fits entirely within Soroban's strict WASM instruction budget and 64KB binary size limits, using optimized WASM compilation (`opt-level = "z"`, LTO).
- **Impact on project:** Makes our project economically viable. Without this optimization, VRF on Stellar would exceed gas limits or cost dollars per call. Achieving a $0.004 cost basis unlocks high-frequency use cases (e.g., real-time gaming) and makes our service the most cost-effective VRF in the industry.

**5. Domain-Separated Developer SDK**
dApps request randomness once and derive multiple independent random values via `derive_random(request_id, context)`, using standard contract invocations.
- **Stellar usage:** Integrates natively via `@stellar/stellar-sdk` and Soroban cross-contract calls, requiring no custom tooling.
- **Impact on project:** Drastically reduces integration friction and cost for developers. The ability to generate multiple independent random outputs from a single on-chain proof makes our service highly attractive to complex dApps (e.g., generating multiple NFT traits from one request), accelerating our user acquisition.

---

## Open Track Deliverables & Budget

**Total Budget Request: $75,000 in XLM**

> Note: We are requesting $75K (50% of the maximum) because the core cryptographic engine is already built and proven on Testnet. The remaining work is hardening for production, implementing the liveness and capital-safety guarantees, and launching on Mainnet.

---

### Tranche #0 (Upon Approval) — 10% = $7,500

Foundation setup: finalize development environment, and set up CI/CD pipeline for automated WASM builds and Testnet deployments.

---

### Tranche #1 Deliverables — 20% = $15,000

**Milestone: Commit-Reveal with Deterministic drand Rounds + Timeout Refunds**

**[Deliverable 1.1] Deterministic drand Round Selection (Anti-Front-Running)**
Implement the on-chain drand round computation: `required_round = floor((ledger_timestamp - DRAND_GENESIS) / DRAND_PERIOD) + 2`. The contract stores the required round at `request()` time and rejects any proof that uses a different round.
- **Measurement:** Unit tests proving the contract rejects proofs with wrong drand rounds. Integration test on Testnet showing end-to-end commit-reveal flow with real drand beacon data.
- **Budget:** $5,000

**[Deliverable 1.2] Fulfillment Deadline & Refund Mechanism**
Implement a ledger-sequence-based fulfillment deadline (`deadline = ledger_sequence + FULFILL_WINDOW`). If the oracle fulfills in time, it receives the fee. If the deadline passes, the request is marked expired, and the user can claim a refund via `timeout_refund()`. Includes auto-extend TTL logic for unfulfilled requests to prevent state garbage-collection.
- **Measurement:** Test suite covering: successful fulfillment (fee paid to oracle), timeout (user refunded), and TTL persistence (unfulfilled request survives past standard TTL due to auto-extend).
- **Budget:** $5,000

**[Deliverable 1.3] Oracle Service Hardening**
Update the TypeScript oracle service to: fetch exactly the contract-specified drand round, include `ctr_hint` and `drand_round` in proof submission, handle fulfillment deadlines with automatic retry logic.
- **Measurement:** Oracle successfully fulfills 100 consecutive requests on Testnet with correct drand rounds, no timeouts, and no rejected proofs.
- **Budget:** $5,000

**Tranche #1 Completion Date:** 15/08/2026

---

### Tranche #2 Deliverables — 30% = $22,500

**Milestone: High-Availability Oracle Network + Developer SDK + Testnet Stress Test**

**[Deliverable 2.1] High-Availability Decoupled Oracle Infrastructure**
Transition from a single-node oracle to a fault-tolerant, high-availability infrastructure. Multiple independent relay nodes monitor the contract and fetch drand entropy, but cryptographic signing is strictly offloaded to an isolated signing service. Relay nodes never possess private key material; they request signatures via secure, authenticated internal RPCs. This eliminates single-point-of-failure at the relay layer, ensuring system liveness even if individual relay nodes go offline.
- **Measurement:** 3+ independent relay nodes running on Testnet. Network maintains 100% fulfillment rate even when 1 of 3 relay nodes is intentionally taken offline. Verification that relay nodes cannot generate valid proofs without the isolated signing service.
- **Budget:** $8,000

**[Deliverable 2.2] Developer SDK & Documentation**
Publish an npm package (`@soroban-vrf/sdk`) that wraps contract invocation into simple TypeScript functions: `requestRandomness()`, `getResult()`, `verifyProof()`. Includes comprehensive documentation with code examples for common use cases (lottery, NFT, gaming).
- **Measurement:** Published npm package with >90% test coverage. Documentation site with at least 3 integration tutorials. One reference dApp (e.g., a fair on-chain coin flip) deployed on Testnet.
- **Budget:** $7,500

**[Deliverable 2.3] Testnet Stress Test & Gas Optimization Report**
Run 1,000+ randomness requests through the full pipeline (request → drand fetch → ECVRF prove → fulfill → verify) on Testnet. Measure and document: average fulfillment latency, gas cost distribution, failure rate, and HA failover dynamics.
- **Measurement:** Published benchmark report with statistical analysis. All 1,000+ requests fulfilled successfully with <30s average latency and zero cryptographic failures.
- **Budget:** $7,000

**Tranche #2 Completion Date:** 15/10/2026

---

### Tranche #3 Deliverables — 40% = $30,000

**Milestone: Security Audit Remediation & Mainnet Launch**

**[Deliverable 3.1] Audit Remediation & Mainnet Deployment**
Submit code for the SCF-provided security audit. Remediate all critical/high findings. Deploy the optimized, audited WASM contract to Stellar Mainnet. Initialize with production oracle keys stored in an isolated signing service (HSM or equivalent). Fund the oracle gas account and configure production drand endpoints.
- **Measurement:** Zero high/critical audit findings remaining. Contract deployed and operational on Mainnet. First 10 real external randomness requests fulfilled successfully with on-chain proof verification.
- **Budget:** $8,000

**[Deliverable 3.2] Production Oracle Infrastructure**
Deploy 3+ geographically distributed relay nodes with automated monitoring, alerting, and failover. Implement key management best practices: VRF key (secp256k1) in HSM, Stellar key (Ed25519) via remote signer, both isolated from application runtime.
- **Measurement:** 99.5%+ uptime over a 2-week monitoring period. Automated alerts trigger within 60 seconds of any fulfillment failure. Relay failover completes within one ledger close (~6 seconds).
- **Budget:** $10,000

**[Deliverable 3.3] Professional User Testing & Integration Support**
Onboard 3+ Stellar ecosystem dApps as early adopters. Provide hands-on integration support, collect feedback, and iterate on the SDK and documentation based on real developer experience.
- **Measurement:** 3+ independent dApps successfully integrated and making real randomness requests on Mainnet. Developer feedback documented and incorporated into SDK v1.1.
- **Budget:** $7,000

**[Deliverable 3.4] Research Publication & Open-Source Handoff**
Finalize all repositories as fully open-source (MIT license). Publish the Gas Optimization Research (documenting the journey from 115M to 91M instructions), the Threat Model, and the Technical Architecture Document as public educational resources for the Stellar developer community — enabling future projects to build on our findings without repeating the same engineering effort.
- **Measurement:** All repositories public on GitHub with comprehensive README and contributing guidelines. Research papers published and shared with Stellar developer channels. Architecture document linked from Stellar developer resources.
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

> **Why $75K and not $150K:** The hardest engineering challenge — fitting full ECVRF verification inside Soroban's WASM instruction budget — is already solved and proven on Testnet (91.7M instructions, 0.014 XLM per verification). This de-risks the project significantly and allows us to focus the budget entirely on production hardening, economic security, and ecosystem integration.
