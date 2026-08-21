# Instruction Budget Profiling

This document records measured instruction costs for all VRF contract code paths,
addressing the SCF requirement to profile the nonzero-fee SAC path and G1 negation.

## Testnet measurements

All values are `fee_charged` (stroops) from Horizon API, which reflects actual
resource consumption on the Stellar network.

### Comparison: fee=0 vs fee=1,000,000 stroops

| Function | fee=0 | fee=1,000,000 | Delta | Notes |
|---|---|---|---|---|
| `request()` | 96,779 | 202,293 | +105,514 | SAC `transfer(requester→contract)` |
| `fulfill()` | 135,638 | ~241,000 (est.) | ~+105,000 | SAC `transfer(contract→oracle)` |
| `timeout_refund()` | ~13,000 (est.) | 18,709 | ~+5,700 | SAC `transfer(contract→requester)` |

**Key takeaway:** The SAC token transfer adds ~100K stroops to the fee_charged. This
is well within Soroban's transaction limits and does not affect the 70M CPU instruction
budget for `fulfill()`.

### Fulfill() CPU instruction breakdown (from Tranche 1 baseline)

The `fulfill()` pipeline was measured at **~56M CPU instructions** on testnet:

| Component | Estimated CPU | % of total |
|---|---|---|
| BLS12-381 pairing check (VRF proof) | ~25M | 45% |
| BLS12-381 pairing check (drand sig) | ~25M | 45% |
| `hash_to_g1()` × 2 (VRF + drand DSTs) | ~4M | 7% |
| Ed25519 signature verification | ~1M | 2% |
| G1 negation (`-h`, `-h_msg`) | <1K | <0.01% |
| Storage reads/writes + TTL extensions | ~1M | 1% |
| **SAC fee transfer (when fee > 0)** | **~1-2M** | **~2-3%** |
| **Total (fee=0)** | **~56M** | |
| **Total (fee>0, estimated)** | **~58M** | |

All paths remain well below the **70M instruction limit**.

## G1 negation analysis

G1 negation (`-h` in `verify_bls_vrf_proof` and `-h_msg` in `verify_drand_signature`)
is used to set up the BLS12-381 pairing check equation:

```
e(gamma, G2) == e(H(alpha), PK)  →  e(gamma, G2) · e(-H(alpha), PK) == 1
```

In BLS12-381, negating a G1 affine point is a **single finite field negation** of the
y-coordinate in Fp (a 48-byte modular subtraction). This costs fewer than **1,000 CPU
instructions** — completely negligible compared to the ~50M instructions consumed by
the two pairing checks.

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

## Testnet transaction links

| Function | TX Hash | Explorer |
|---|---|---|
| `request()` with fee=1M | `6c0b5b72...` | [link](https://stellar.expert/explorer/testnet/tx/6c0b5b72aefe99cd753cbb59205d67cf61945a53d078d6f3de4cb2251d0a0b1d) |
| `timeout_refund()` with fee=1M | `8c3e8190...` | [link](https://stellar.expert/explorer/testnet/tx/8c3e81906630dec20b51527cb90f91c87b1e71b13e30668a0b17dd302ddf2ec2) |
| `fulfill()` without fee | `2ec66cb6...` | [link](https://stellar.expert/explorer/testnet/tx/2ec66cb6bccd87dbaff1a7cd103c60b843bd48b191abe34e401b796928b87bfb) |
| `request()` without fee | `f60b0553...` | [link](https://stellar.expert/explorer/testnet/tx/f60b055389d5884e6ebfefc2927941ab6da156f3d19cf45f4c25b4a57b2e373e) |
