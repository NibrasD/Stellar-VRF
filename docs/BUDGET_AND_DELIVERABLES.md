# Open Track Deliverables & Budget

**Current status (MVP):**
We currently have a basic MVP proving feasibility on testnet. The plan below defines the production build and mainnet launch scope for ~4–5 months.

**Total Budget Request:** $60,000 equivalent in XLM

---

## Tranche Structure (SCF standard)

| Tranche | Amount | Percentage |
|---|---|---|
| #0 (upon approval) | $6,000 | 10% |
| #1 | $12,000 | 20% |
| #2 | $18,000 | 30% |
| #3 (mainnet launch) | $24,000 | 40% |
| **Total** | **$60,000** | **100%** |

---

## [Deliverable 1] Production Soroban Core + Oracle Pipeline (Milestone 1)

**Timeline:** Month 1–2 (8 weeks)

**Brief description:**
Implement production-grade contract interfaces and oracle services beyond MVP, including future-round request locking, robust fulfillment flow, and developer-ready integration endpoints.

**How to measure completion:**
- Soroban contract interface finalized and deployed on testnet.
- End-to-end request → fulfill → derive flow runs reliably from oracle worker.
- Integration tests pass for success/failure paths.
- Public technical docs for integration and operation published.

**Budget: $12,000**

| Item | Cost |
|---|---|
| Production contract implementation & testing | $5,000 |
| Oracle worker service (event listener, drand client, tx submission, retry logic) | $4,000 |
| Integration tests & testnet deployment | $1,500 |
| Technical documentation | $1,500 |

---

## [Deliverable 2] Security Hardening + Composability (Milestone 2)

**Timeline:** Month 2–3 (6 weeks, overlapping with M1 testing)

**Brief description:**
Add complete on-chain safety controls and dApp composability: callback-capable request flow, timeout/refund handling, strict replay/freshness checks, and operational monitoring.

**How to measure completion:**
- Callback-enabled app integration demonstrated with at least one sample consumer contract.
- Timeout/refund and liveness controls validated by automated tests.
- Security test matrix and threat-model-driven test evidence published.
- Testnet performance and fee profile documented against target thresholds.

**Budget: $18,000**

| Item | Cost |
|---|---|
| Callback integration & consumer contract library | $4,500 |
| Timeout/refund state machine implementation | $4,000 |
| Security test matrix & threat model validation | $4,500 |
| Operational monitoring & alerting system | $3,000 |
| Performance optimization (batch pairing, etc.) | $2,000 |

---

## [Deliverable 3] Mainnet Launch (Milestone 3)

**Timeline:** Month 3–5 (8 weeks)

**Brief description:**
Launch on Stellar mainnet with production runbooks, observability, incident procedures, and staged adoption support for first integrators.

**How to measure completion:**
- Mainnet contract and oracle service deployed and publicly verifiable.
- First mainnet randomness requests executed successfully with verifiable outputs.
- Final mainnet architecture and operations documentation published.

**Budget: $24,000**

| Item | Cost |
|---|---|
| Mainnet deployment & validation | $4,000 |
| Production relay infrastructure (3+ nodes) | $8,000 |
| SDK & developer documentation site | $6,000 |
| Operational runbooks & incident procedures | $2,000 |
| Post-launch monitoring & support (2 months) | $4,000 |

---

## Budget Summary

| Component | Amount | Timeline |
|---|---|---|
| Tranche #0 kickoff allocation | $6,000 | Upon approval |
| Deliverable 1: Core + Pipeline | $12,000 | Month 1–2 |
| Deliverable 2: Security + Composability | $18,000 | Month 2–3 |
| Deliverable 3: Mainnet Launch | $24,000 | Month 3–5 |
| **Total** | **$60,000** | **~5 months** |
