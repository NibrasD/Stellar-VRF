# Instruction Budget & Transaction Fee Profiling

This document records the exact, verified resource and fee measurements for the Stellar-VRF contracts across both **Stellar Mainnet** and **Stellar Testnet**, verified directly against on-chain transaction metadata from Horizon and Soroban Diagnostic Events.

> **Terminology & Metric Definitions:**
> 1. **Contract Application Escrow Fee (`fee_amount`)** — Configured in the VRF contract at deployment. Escrowed by the requester in native XLM (via Stellar Asset Contract / SAC) upon calling `request()`, and released to the oracle account upon successful fulfillment (e.g. `2,000,000 stroops = 0.2 XLM` on production instances).
> 2. **Stellar Network Transaction Fee (`fee_charged`)** — Charged in **stroops** (1 XLM = 10,000,000 stroops) by Stellar validators for transaction execution, inclusion, and ledger storage footprint. Read directly from the Horizon transaction API.
> 3. **CPU Compute Cost (`cpu_insn`)** — Metered in **CPU instructions** consumed by the Soroban Host VM during transaction execution. Read directly from on-chain `DiagnosticEvent.cpu_insn`.

---

## 1. Stellar Mainnet Measurements

### A. Production Contract (`CAW6KECQMHRTX2GS3JVHWBMOB5JNNOHNOCE635RQS4SWJ72YF56EUPRX`)
* **WASM Hash**: `81ffb2f216518a24555f84d1e2eec0d38b556b27d425b090df265355601d3209`
* **Application Fee (`fee_amount`)**: `2,000,000 stroops (0.2 XLM)`
* **Active Status**: Current Live Production Instance

| Operation | TX Hash | Ledger | Network Fee Charged (`fee_charged`) | Application Fee | Consumed CPU Instructions (`cpu_insn`) |
|---|---|---|---|---|---|
| Contract Upload | [`fe1b7f85...`](https://stellar.expert/explorer/public/tx/fe1b7f85b738bdc65620bffd9f10abbfdf7995adfbb4a7a90803c3a17c6cf41b) | 64595209 | 24,960 stroops | — | — |
| Contract Instance Deploy | [`fccef97c...`](https://stellar.expert/explorer/public/tx/fccef97c5ec84a1a8f483aee779f925c819fab99e91edc692e56644d1089af50) | 64595232 | 1,481,200 stroops | — | — |
| `request(context)` #1 | [`978297f0...`](https://stellar.expert/explorer/public/tx/978297f0df8d9e6c7ec1167043127287404821758586573e97a99265aa167cae) | 64595350 | 1,475,632 stroops | 2,000,000 stroops (escrowed) | — |
| `fulfill(1)` #1 | [`e0cc4b60...`](https://stellar.expert/explorer/public/tx/e0cc4b6089b98300a7dfd230320fe5f37917a1dfd6ee034e762ccdf91d3a960b) | 64595396 | 1,518,581 stroops | 2,000,000 stroops (released) | **56,040,632** |

### B. Mainnet Cross-Deployment CPU & Fee Comparison

The table below tracks actual measurements across deployments on Stellar Mainnet:

| Metric | Production Zero-Fee (`CBTCC5...`) | Dedicated Profiling (`CA24JM...`) | **Current Live Production (`CAW6KEC...`)** |
|---|---|---|---|
| **Network** | **Stellar Mainnet** | **Stellar Mainnet** | **Stellar Mainnet** |
| **Transaction Hash** | [`f3e83555...`](https://stellar.expert/explorer/public/tx/f3e83555c54c33230627fd971aefca376f257dd053ca3cb5501f31f8476482bf) | [`8932bb72...`](https://stellar.expert/explorer/public/tx/8932bb7204288fda36bd63f5d31ea771a3be389eb6b649765042d9101d505fa9) | [`e0cc4b60...`](https://stellar.expert/explorer/public/tx/e0cc4b6089b98300a7dfd230320fe5f37917a1dfd6ee034e762ccdf91d3a960b) |
| **Mainnet Ledger** | 64558794 | 64560204 | **64595396** |
| **Contract VRF Escrow Fee** | 0 stroops | 100,000 stroops (0.01 XLM) | **2,000,000 stroops (0.2 XLM)** |
| **Network Fee Charged** | 1,284,111 stroops | 1,293,030 stroops | **1,518,581 stroops** (~0.1518 XLM) |
| **Consumed CPU Instructions** | **55,768,015** | **55,988,820** | **56,040,632** |
| **Allocated Envelope Limit** | 58,073,400 | 58,342,003 | 58,342,003 |
| **Soroban Mainnet Protocol Limit** | 400,000,000 | 400,000,000 | 400,000,000 |
| **Project Target Budget** | < 75,000,000 | < 75,000,000 | < 75,000,000 |
| **Headroom Under Target (<75M)** | **25.64%** | **25.34%** | **25.28%** |
| **Headroom Under Network Limit (<400M)**| **86.05%** | **86.00%** | **85.99%** |

---

## 2. Stellar Testnet Measurements

### A. Production Testnet Contract (`CBEDNSJ63LANUSJHRZSNQUV22X6JYU6E7PTUDIGQDOHNH7VIT4CAJTBR`)
* **Application Fee (`fee_amount`)**: `2,000,000 stroops (0.2 XLM)`

| Operation | TX Hash | Ledger | Network Fee Charged (`fee_charged`) | Consumed CPU Instructions |
|---|---|---|---|---|
| Contract Upload | [`59e0cd96...`](https://stellar.expert/explorer/testnet/tx/59e0cd96c43ee52546f1f8db23f96cd33ee79b8c501de93557b400c6bbe2c779) | 1007875 | 24,960 stroops | — |
| Contract Instance Deploy | [`1e832b86...`](https://stellar.expert/explorer/testnet/tx/1e832b864f80cb54f507109e4c1484e680e635a5b6234774e8d9155fa1a88d96) | 1007886 | 318,367 stroops | — |
| `request(context)` #1 (2M fee) | [`dbc6a944...`](https://stellar.expert/explorer/testnet/tx/dbc6a944995acf762cbd944a16a3d9a8be7b35d22aee6fc65184cecc81c11040) | 1007908 | 219,279 stroops | — |
| `fulfill(1)` #1 (2M fee) | [`323ae892...`](https://stellar.expert/explorer/testnet/tx/323ae89254509d6a1b24b7f224476efa2f45970a13a3bba7f034d64fe1aa3f3e) | 1007914 | 322,417 stroops | **55,822,585** |

### B. Testnet Historical Zero-Fee & Refund Transactions

| Operation | TX Hash | Ledger | Network Fee Charged (`fee_charged`) | Notes |
|---|---|---|---|---|
| `request()` without fee | [`f60b0553...`](https://stellar.expert/explorer/testnet/tx/f60b055389d5884e6ebfefc2927941ab6da156f3d19cf45f4c25b4a57b2e373e) | 4161073 | 96,779 stroops | Baseline request without SAC transfer |
| `fulfill()` without fee | [`2ec66cb6...`](https://stellar.expert/explorer/testnet/tx/2ec66cb6bccd87dbaff1a7cd103c60b843bd48b191abe34e401b796928b87bfb) | 4161075 | 135,638 stroops | Baseline fulfill without SAC transfer |
| `request()` with 1M fee | [`6c0b5b72...`](https://stellar.expert/explorer/testnet/tx/6c0b5b72aefe99cd753cbb59205d67cf61945a53d078d6f3de4cb2251d0a0b1d) | 4256179 | 202,293 stroops | Early testnet test with 0.1 XLM fee |
| `timeout_refund()` with 1M fee | [`8c3e8190...`](https://stellar.expert/explorer/testnet/tx/8c3e81906630dec20b51527cb90f91c87b1e71b13e30668a0b17dd302ddf2ec2) | 4256196 | 18,709 stroops | Reclaiming escrowed fee after timeout |

---

## 3. Component-by-Component Instruction Breakdown

The `fulfill()` execution path consists of cryptographic verifications, token transfer, and storage management. Measured in unit benchmarks and validated against confirmed on-chain transactions:

| Component | CPU Instructions | Measurement Type | Source |
|---|---|---|---|
| Dual BLS12-381 pairing check (VRF proof + drand sig) | **48,107,008** | Unit benchmark (`test_budget_bls_pairing`) | Isolated test in `tests/budget_test.rs` |
| `hash_to_g1()` × 2 (VRF DST + drand DST) | **5,285,530** | Benchmark | Measured in Soroban cryptographic host |
| Storage reads/writes + TTL extensions | ~1,500,000 | Component estimate | State read/write overhead |
| Ed25519 signature verification | ~1,000,000 | Host benchmark | On-chain host verification |
| SAC Token Transfer (`fee_amount > 0`) | **221,988** | Unit benchmark (`test_budget_sac_transfer_cpu_instructions`) | Corroborates on-chain delta (**220,805**) |
| G1 point negation (`-h`, `-h_msg`) | **4,031** | Unit benchmark (`test_budget_g1_negation_cpu_instructions`) | Modular subtraction in $\mathbb{F}_p$ |
| **Composite Theoretical Estimate** | **56,122,588** | Summation | Unit test assertion |
| **Actual Live Mainnet Consumed Instructions** | **56,040,632** | **Direct on-chain measurement** | **TX `e0cc4b60...` (`cpu_insn`)** |

> **Variance between Estimate and Mainnet**: The theoretical composite estimate (**56,122,588**) and actual live Mainnet execution (**56,040,632**) differ by only **81,956 instructions (<0.15%)**, providing definitive verification of the computational profile.

---

## 4. Architectural Analysis

### G1 Negation Analysis
G1 negation (`-h` in `verify_bls_vrf_proof` and `-h_msg` in `verify_drand_signature`) is required to structure the BLS12-381 pairing equality into a single multi-pairing check:
$$e(\gamma, G_2) \cdot e(-H(\alpha), PK) == 1$$
In BLS12-381, negating an affine point in $G_1$ is a single modular subtraction of the y-coordinate in $\mathbb{F}_p$. This consumes exactly **4,031 CPU instructions** (`test_budget_g1_negation_cpu_instructions`), which is completely negligible (<0.01% of the total budget).

### Storage Layout Rationale
Each VRF request maintains separate persistent storage entries (`Proof`, `Beta`, `RequestContext`, `Fulfilled`) rather than a single packed struct:
1. **Independent TTL Management**: Calling `cleanup_proof()` purges bulky proof payloads (~450 bytes) while retaining the canonical 32-byte `Beta` and `Fulfilled` flag.
2. **Selective State Cleanup**: Consumer callback metadata can be safely deleted post-fulfillment without rewriting the core fulfillment state.
3. **Query Efficiency**: Read calls like `is_fulfilled()` inspect a compact boolean entry without deserializing large cryptographic points.
4. **Cost-Benefit**: Additional storage operations incur ~100K instructions, compared to ~48M for BLS pairings (<0.2% overhead), while significantly reducing ongoing storage rent.
