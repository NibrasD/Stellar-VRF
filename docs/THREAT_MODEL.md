# Threat Model

This document covers the security assumptions and known risks for the Stellar VRF Oracle
as deployed on testnet (Tranche 2). It is meant to be a living document — we'll update it
as the protocol matures toward mainnet.

## Architecture

```
Consumer Contract  ──request()──▶  VRF Oracle Contract  ◀──fulfill()──  Oracle Worker (off-chain)
                                         │                                      │
                                         │                             drand quicknet (BLS beacon)
                                         │
                                   on_vrf() callback
```

The system has three principals: the consumer (any Soroban contract), the VRF oracle contract
(on-chain), and a single oracle worker node that listens for events and submits proofs.

## Trust assumptions

**drand quicknet.** We rely on the drand distributed randomness beacon for unpredictability.
The quicknet chain uses a BLS threshold scheme across a geographically distributed committee.
Historical uptime is >99.9%. If the chain rotates its group key, the oracle admin must call
`rotate_drand_pk()` to update the on-chain verification key.

**Single oracle.** This is the most important trust boundary to understand. The current design
uses one oracle node. This means:

- *Bias resistance is cryptographic.* The oracle cannot choose which VRF output to produce —
  it must use its BLS secret key on a deterministic input. The pairing check on-chain enforces
  this. There is no way to "try different outputs" because the VRF is deterministic for a given
  key and input.

- *Liveness is NOT guaranteed.* If the oracle goes down, requests won't get fulfilled. We handle
  this with a timeout mechanism: after `TIMEOUT_ROUNDS` (20 drand rounds, ~60s), the requester
  can call `timeout_refund()` to reclaim their escrowed fee. The fee is held in the VRF contract
  itself (not sent to the oracle) until fulfillment, so the requester is always protected
  financially. This is an acceptable trade-off for testnet. A multi-oracle threshold scheme
  is planned for mainnet.

- *Censorship is possible.* The oracle could refuse to fulfill specific requests. Again, the
  timeout protects the requester from being stuck forever. A decentralized oracle committee
  would eliminate this risk.

**`round_offset >= 2`.** Every request is bound to a drand round that hasn't happened yet
(at least 2 rounds in the future). This prevents the oracle from knowing the beacon value
at request time, which would allow frontrunning.

## Attack surface

### Replay / duplicate fulfillment

The `Fulfilled(request_id)` flag is set in storage *before* any callback is invoked (CEI pattern).
A second `fulfill()` call for the same request will hit the "already fulfilled" check and revert.
We test this explicitly in `test_fulfill_duplicate_rejected`.

### Callback re-entrancy

A malicious consumer contract could try to call back into `fulfill()` from its `on_vrf` callback.
This is blocked by two mechanisms:

1. The `Fulfilled` flag is already set (Effects before Interactions), so re-entering `fulfill()`
   would fail the "already fulfilled" check.
2. We additionally set a transient `Fulfilling(request_id)` key as a belt-and-suspenders guard,
   which is cleared after the callback returns.

### Signature forgery

Both the Ed25519 oracle signature and the BLS pairing check are verified using Soroban host
functions (`ed25519_verify`, `bls12_381_pairing_check`). These are native implementations —
forging either would require breaking the underlying cryptographic primitives.

### Alpha seed manipulation

The alpha seed is re-derived on-chain from `(request_id, context, drand_round, sha256(drand_sig))`.
The oracle submits its claimed alpha in the proof struct, but the contract independently computes
the expected value and compares. If they don't match, the transaction reverts.

### Timeout griefing

A requester cannot call `timeout_refund()` early — the contract checks that the current drand round
exceeds `required_round + TIMEOUT_ROUNDS`. The ledger timestamp is consensus-determined, so a single
user can't manipulate it.

### Key compromise

If the oracle's BLS or Ed25519 key is compromised, the admin can call `rotate_oracle_keys()` to
atomically replace all three key fields (BLS PK, Stellar address, Ed25519 PK). The current oracle
must authorize the rotation — an attacker who only has the BLS key but not the Stellar account
cannot rotate keys.

After rotation, any pending requests that were locked to the old oracle PK will fail verification
when the (now-compromised) attacker tries to fulfill them. Requesters should call `timeout_refund()`
for these.

### Storage expiration

Persistent storage entries could theoretically expire before the oracle fulfills. We mitigate this
by extending TTL on all request-related entries at creation time (`PERSISTENT_TTL_EXTEND` = 518,400
ledgers, ~30 days). `fulfill()` extends again on completion.

`cleanup_proof()` is a separate concern: it removes the bulky proof data to save on rent, but
explicitly preserves the `Fulfilled` flag so that `is_fulfilled()` queries continue to work.

## Storage layout design

Each VRF request creates several separate persistent storage entries (`RequestContext`, `Requester`,
`RequestRound`, `Fulfilled`, `Refunded`, etc.) rather than a single packed struct. This is an
intentional design decision:

- **Independent TTL lifecycles.** `cleanup_proof()` removes bulky proof data while keeping the
  `Fulfilled` flag alive. A packed struct would require all-or-nothing TTL extension.
- **Selective cleanup.** Callback metadata can be removed independently after fulfillment.
- **Query efficiency.** `is_fulfilled()` reads a single boolean entry instead of deserializing
  an entire struct.

The trade-off is higher per-request gas for writes (~8 entries vs 1). This is acceptable because
VRF requests are infrequent (not high-throughput) and the gas cost is dominated by BLS pairing
verification (~56M instructions), not storage operations.

## Known limitations (deferred to mainnet)

- **Single oracle** — planned to be replaced with a threshold committee.
- **Fee economics** — the `fee_amount` parameter and escrow mechanism are fully implemented and
  tested (fees are escrowed in the VRF contract on request, released to oracle on fulfill,
  refunded to requester on timeout). Testnet deploys with `fee_amount = 0`; mainnet fee
  economics require separate design work.
- **No formal verification** — the contract has 33 unit tests and has been manually reviewed,
  but has not undergone a formal audit. This is expected before mainnet deployment.
