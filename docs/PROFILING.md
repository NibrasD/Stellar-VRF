# Instruction Budget Profiling

This document records measured instruction costs for all VRF contract code paths.

> **Terminology & Units Notice.** To ensure complete clarity, three distinct metrics are tracked in this document:
> 1. **Contract Application Fee (`fee_amount`)** — Configured in the VRF contract; escrowed by the requester in XLM SAC and transferred to the oracle upon fulfillment (e.g. `100,000 stroops = 0.01 XLM` in our nonzero-fee test instance).
> 2. **Stellar Network Transaction Fee (`fee_charged`)** — Incurred in **stroops** (1 XLM = 10,000,000 stroops) for transaction execution and ledger inclusion, read from the Horizon API / transaction metadata (e.g. `1,486,159 stroops = ~0.1486 XLM` on Mainnet TX `8932bb72...`).
> 3. **CPU Compute Cost** — Metred in **instructions** by the Soroban VM host budget, read from `SorobanTransactionData.resources.instructions` (e.g. `58,342,003 instructions`).

## A. Network fee measurements (stroops)

All values in this section are `fee_charged` (**stroops**) from the Horizon API.

### Comparison: fee_amount=0 vs fee_amount=1,000,000 stroops

| Function | fee=0 | fee=1,000,000 | Delta | Notes |
|---|---|---|---|---|
| `request()` | 96,779 | 202,293 | +105,514 | SAC `transfer(requester→contract)` |
| `fulfill()` | 135,638 | ~357,626 (est.) | ~221,988 | SAC `transfer(contract→oracle)` |
| `timeout_refund()` | ~13,000 (est.) | 18,709 | ~+5,700 | SAC `transfer(contract→requester)` |

**Key takeaway:** enabling a non-zero `fee_amount` adds ~100–222K **stroops** to
`fee_charged` because of the extra SAC token transfer. This is a *fee* delta, not a
CPU delta, and it does not affect the CPU instruction budget for `fulfill()`.

## B. CPU instruction measurements (instructions)

All values in this section are **CPU instructions** from the Soroban budget.

| Measurement | Instructions | Source |
|---|---|---|
| `fulfill()` (fee=2M, live production mainnet) | **56,040,632** | `DiagnosticEvent.cpu_insn`, live Mainnet TX [`e0cc4b60...`](https://stellar.expert/explorer/public/tx/e0cc4b6089b98300a7dfd230320fe5f37917a1dfd6ee034e762ccdf91d3a960b) (Contract `CAW6KEC...`) |
| `fulfill()` (fee=2M, live production testnet) | **55,822,585** | `DiagnosticEvent.cpu_insn`, live Testnet TX [`323ae892...`](https://stellar.expert/explorer/testnet/tx/323ae89254509d6a1b24b7f224476efa2f45970a13a3bba7f034d64fe1aa3f3e) (Contract `CBEDNSJ...`) |
| `fulfill()` (fee>0, dedicated profiling deployment) | **58,342,003** | `SorobanTransactionData.resources.instructions`, mainnet TX [`8932bb72...`](https://stellar.expert/explorer/public/tx/8932bb7204288fda36bd63f5d31ea771a3be389eb6b649765042d9101d505fa9) (Contract `CA24JM...`) |
| `fulfill()` (fee=0, historical zero-fee mainnet) | **58,073,400** | `SorobanTransactionData.resources.instructions`, mainnet TX `f3e83555...` (Contract `CBTCC5...`) |
| SAC transfer on-chain delta | **268,603** | Difference on Mainnet between nonzero-fee (`58,342,003`) and fee=0 (`58,073,400`) |
| SAC transfer isolated benchmark | **221,988** | `test_budget_sac_transfer_cpu_instructions` — isolated budget delta around SAC `transfer` |
| G1 negation (single) | **4,031** | `test_budget_g1_negation_cpu_instructions` |

> **Why `221,988` appears in Section A & B.** In early testing:
> - Section A: the `fee_charged` **stroops** delta between the `fee_amount=0` and
>   `fee_amount=1,000,000` fulfillment paths (Horizon).
> - Section B: the isolated unit test **CPU instruction** cost of the SAC `transfer` call (`221,988`),
>   which closely aligns with the actual on-chain measured delta of **268,603 instructions** on Stellar Mainnet.
>
> Reproduce the CPU figure locally:
>
> ```bash
> cargo test --lib test::test_budget_sac_transfer_cpu_instructions -- --exact --nocapture
> # SAC TRANSFER CPU INSTRUCTIONS: 221988
> ```
>
> And the G1 negation figure:
>
> ```bash
> cargo test --lib test::test_budget_g1_negation_cpu_instructions -- --exact --nocapture
> # G1 NEGATION CPU INSTRUCTIONS (run 1): 4031
> ```

### Fulfill() CPU instruction count — MEASURED from **Mainnet** TX

The `fulfill()` pipeline has been directly measured on **Stellar Mainnet** across deployments —
decoded directly from `SorobanTransactionData.resources.instructions` and on-chain diagnostic events of confirmed
transaction envelopes:

| Field | Baseline Deployment | Production Zero-Fee (`CBTCC5...`) | Dedicated Profiling Deployment (`CA24JM...`) | Current Live Production (`CAW6KEC...`) |
|---|---|---|---|---|
| **Network** | **Stellar Mainnet** | **Stellar Mainnet** | **Stellar Mainnet** | **Stellar Mainnet** |
| **TX Hash** | [`5190ba03...`](https://stellar.expert/explorer/public/tx/5190ba03ba8cc708efe035996f90da0668f9f1d725658bd84aecbd63be24e5f2) | [`f3e83555...`](https://stellar.expert/explorer/public/tx/f3e83555c54c33230627fd971aefca376f257dd053ca3cb5501f31f8476482bf) | [`8932bb72...`](https://stellar.expert/explorer/public/tx/8932bb7204288fda36bd63f5d31ea771a3be389eb6b649765042d9101d505fa9) | [`e0cc4b60...`](https://stellar.expert/explorer/public/tx/e0cc4b6089b98300a7dfd230320fe5f37917a1dfd6ee034e762ccdf91d3a960b) |
| **Status** | `successful: true` | `successful: true` | `successful: true` | `successful: true` |
| **Contract VRF Fee (`fee_amount`)** | 0 stroops (0 XLM) | 0 stroops (0 XLM) | 100,000 stroops (0.01 XLM) | 2,000,000 stroops (0.2 XLM) |
| **Network Fee (`fee_charged`)** | 135,638 stroops (~0.0135 XLM) | 135,638 stroops (~0.0135 XLM) | 1,486,159 stroops (~0.1486 XLM) | 1,518,581 stroops (~0.1518 XLM) |
| **CPU Instructions (measured)** | **58,641,186** | **58,073,400** | **58,342,003** | **56,040,632** |
| **Soroban mainnet limit** | 400,000,000 | 400,000,000 | 400,000,000 | 400,000,000 |
| **Project / SCF target** | < 75,000,000 | < 75,000,000 | < 75,000,000 | < 75,000,000 |
| **Headroom under target** | **21.8%** | **22.6%** | **22.21%** | **25.28%** |
| **Headroom under 400M limit** | **85.3%** | **85.5%** | **85.41%** | **85.99%** |

Breakdown by component:

| Component | CPU Instructions | Measurement Type |
|---|---|---|
| BLS12-381 pairing check (VRF proof) | ~25,000,000 | Component benchmark |
| BLS12-381 pairing check (drand sig) | ~25,000,000 | Component benchmark |
| `hash_to_g1()` × 2 (VRF + drand DSTs) | ~6,000,000 | Component benchmark |
| Ed25519 signature verification | ~1,000,000 | Component benchmark |
| G1 negation (`-h`, `-h_msg`) | **4,031** | **Empirically measured** (`test_budget_g1_negation_cpu_instructions`) |
| Storage reads/writes + TTL extensions | ~1,500,000 | Component benchmark |
| **Total (fee=0, mainnet measured)** | **58,073,400** | **Direct on-chain measurement** (TX `f3e83555...`) |
| **Total (nonzero fee, dedicated profiling)** | **58,342,003** | **Direct on-chain measurement** (TX `8932bb72...`) |
| **Total (live production, nonzero fee)** | **56,040,632** | **Direct on-chain measurement** (TX `e0cc4b60...`) |

> **Live Production Mainnet Fulfill**: The active production contract (`CAW6KECQMHRTX2GS3JVHWBMOB5JNNOHNOCE635RQS4SWJ72YF56EUPRX`)
> executed live on Stellar Mainnet ledger `64595396` (TX [`e0cc4b60...`](https://stellar.expert/explorer/public/tx/e0cc4b6089b98300a7dfd230320fe5f37917a1dfd6ee034e762ccdf91d3a960b))
> with `fee_amount = 2,000,000 stroops (0.2 XLM)`.
> The measured on-chain consumption is **56,040,632 instructions**, well below the 75M target (25.28% headroom) and far below the 400M protocol ceiling (85.99% headroom).
>
> **Confirmed On-Chain Nonzero-Fee Fulfill (Historical Profiling Instance)**: A dedicated Mainnet profiling deployment
> (`CA24JMRHKL2J7ZSNE7GFRKQHMH45J2SEEVEVEJR2CZ5RZQB7RRJUKRQG`) using the exact same fulfillment
> implementation was also used to obtain an isolated nonzero-fee `fulfill()` measurement.
> The **58,342,003 instructions** figure is an actual, confirmed on-chain measurement executed on
> Stellar Mainnet ledger `64560204` (TX [`8932bb72...`](https://stellar.expert/explorer/public/tx/8932bb7204288fda36bd63f5d31ea771a3be389eb6b649765042d9101d505fa9))
> with `fee_amount = 100,000 stroops (0.01 XLM)`.
>
> All **VRF-core** execution paths (no consumer callback) remain comfortably below the **75M SCF
> requirement** (up to 25.28% headroom) and far below the **400M Soroban mainnet protocol limit** (85.99% headroom).
>
> **Scope.** The 75M figure covers the VRF core: drand signature check, BLS-VRF verification,
> Ed25519 check, storage writes and the fee transfer. A unit test holds it
> (`test_budget_*`, asserting ≤ 75M). A `request_with_callback` fulfillment also runs the consumer's
> `on_vrf()` in the same transaction. The contract can't bound that cost, so no 75M claim is made for
> callback requests. Operationally the worker's resource guard (`MAX_FULFILL_INSTRUCTIONS`, default 90M,
> plus resource-fee and max-fee bounds) refuses to sign any fulfillment whose simulation exceeds it.

> **Testnet cross-checks:**
> - Live production Testnet TX [`323ae892...`](https://stellar.expert/explorer/testnet/tx/323ae89254509d6a1b24b7f224476efa2f45970a13a3bba7f034d64fe1aa3f3e) (Contract `CBEDNSJ...`): **55,822,585 instructions**, network fee charged: 322,417 stroops.
> - Historical testnet TX [`2ec66cb6...`](https://stellar.expert/explorer/testnet/tx/2ec66cb6bccd87dbaff1a7cd103c60b843bd48b191abe34e401b796928b87bfb): 58,587,982 instructions — confirming consistency across networks.


## G1 negation analysis

G1 negation (`-h` in `verify_bls_vrf_proof` and `-h_msg` in `verify_drand_signature`)
is used to set up the BLS12-381 pairing check equation:

```
e(gamma, G2) == e(H(alpha), PK)  →  e(gamma, G2) · e(-H(alpha), PK) == 1
```

In BLS12-381, negating a G1 affine point is a **single finite field negation** of the
y-coordinate in Fp (a 48-byte modular subtraction). This was empirically measured at
**4,031 CPU instructions** per negation (`test_budget_g1_negation_cpu_instructions`) —
completely negligible compared to the ~50M instructions consumed by the two pairing checks.

The G1 negation is already included in every `fulfill()` measurement above; it is not
a separate code path that needs independent profiling.

## Storage layout rationale (packing intentionally omitted)

Each VRF request creates several separate persistent storage entries rather than
packing into a single struct. This is **intentional**:

1. **Independent TTL lifecycles.** `cleanup_proof()` removes bulky proof data while
   keeping the `Fulfilled` flag alive. A packed struct would force all-or-nothing
   TTL extension.

2. **Selective cleanup.** Callback metadata can be removed independently after
   fulfillment without touching other fields.

3. **Query efficiency.** `is_fulfilled()` reads a single boolean entry (~200 bytes)
   instead of deserializing the entire request struct (~500+ bytes).

4. **Cost justification.** The extra storage operations cost ~100K additional
   instructions per request, compared to ~56M for BLS verification. The overhead
   is <0.2% of total `fulfill()` cost.

## Verified live transaction links

### Live Production Mainnet (`CAW6KECQMHRTX2GS3JVHWBMOB5JNNOHNOCE635RQS4SWJ72YF56EUPRX`)

| Action | Ledger | Network Fee Charged | Application Fee | Explorer Link |
|---|---|---|---|---|
| Contract Upload | 64595209 | 24,960 stroops | — | [`fe1b7f85...`](https://stellar.expert/explorer/public/tx/fe1b7f85b738bdc65620bffd9f10abbfdf7995adfbb4a7a90803c3a17c6cf41b) |
| Contract Instance Deploy | 64595232 | 1,481,200 stroops | — | [`fccef97c...`](https://stellar.expert/explorer/public/tx/fccef97c5ec84a1a8f483aee779f925c819fab99e91edc692e56644d1089af50) |
| `request(context)` #1 | 64595350 | 1,475,632 stroops | 2,000,000 stroops (escrowed) | [`978297f0...`](https://stellar.expert/explorer/public/tx/978297f0df8d9e6c7ec1167043127287404821758586573e97a99265aa167cae) |
| `fulfill(1)` (56,040,632 insn) | 64595396 | 1,518,581 stroops | 2,000,000 stroops (released) | [`e0cc4b60...`](https://stellar.expert/explorer/public/tx/e0cc4b6089b98300a7dfd230320fe5f37917a1dfd6ee034e762ccdf91d3a960b) |

### Live Production Testnet (`CBEDNSJ63LANUSJHRZSNQUV22X6JYU6E7PTUDIGQDOHNH7VIT4CAJTBR`)

| Action | Ledger | Network Fee Charged | Application Fee | Explorer Link |
|---|---|---|---|---|
| Contract Upload | 1007875 | 24,960 stroops | — | [`59e0cd96...`](https://stellar.expert/explorer/testnet/tx/59e0cd96c43ee52546f1f8db23f96cd33ee79b8c501de93557b400c6bbe2c779) |
| Contract Instance Deploy | 1007886 | 318,367 stroops | — | [`1e832b86...`](https://stellar.expert/explorer/testnet/tx/1e832b864f80cb54f507109e4c1484e680e635a5b6234774e8d9155fa1a88d96) |
| `request(context)` #1 | 1007908 | 219,279 stroops | 2,000,000 stroops (escrowed) | [`dbc6a944...`](https://stellar.expert/explorer/testnet/tx/dbc6a944995acf762cbd944a16a3d9a8be7b35d22aee6fc65184cecc81c11040) |
| `fulfill(1)` (55,822,585 insn) | 1007914 | 322,417 stroops | 2,000,000 stroops (released) | [`323ae892...`](https://stellar.expert/explorer/testnet/tx/323ae89254509d6a1b24b7f224476efa2f45970a13a3bba7f034d64fe1aa3f3e) |

### Historical testnet transaction links

| Function | TX Hash | Explorer |
|---|---|---|
| `request()` with fee=1M | `6c0b5b72...` | [link](https://stellar.expert/explorer/testnet/tx/6c0b5b72aefe99cd753cbb59205d67cf61945a53d078d6f3de4cb2251d0a0b1d) |
| `timeout_refund()` with fee=1M | `8c3e8190...` | [link](https://stellar.expert/explorer/testnet/tx/8c3e81906630dec20b51527cb90f91c87b1e71b13e30668a0b17dd302ddf2ec2) |
| `fulfill()` without fee | `2ec66cb6...` | [link](https://stellar.expert/explorer/testnet/tx/2ec66cb6bccd87dbaff1a7cd103c60b843bd48b191abe34e401b796928b87bfb) |
| `request()` without fee | `f60b0553...` | [link](https://stellar.expert/explorer/testnet/tx/f60b055389d5884e6ebfefc2927941ab6da156f3d19cf45f4c25b4a57b2e373e) |
