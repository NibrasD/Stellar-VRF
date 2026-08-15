# STRIDE Threat Model — Stellar VRF Oracle

## System overview

The Stellar VRF Oracle provides verifiable randomness to Soroban smart contracts.
It consists of an on-chain contract, an off-chain oracle worker, and the drand
distributed randomness beacon.

```
Consumer ──request()──▶ VRF Contract ◀──fulfill()── Oracle Worker ◀── drand quicknet
                              │
                        on_vrf() callback
```

**Contract:** `CAQFZI4IVZ35YODWSYWRKZE7WARBXKPQ3M5PA66R3PPR6M775K67FHQR` (Testnet)
**Oracle address:** `GARPMPBJ5H43UNYHLIC46MSYRDGF4ZNKUYTZYDYVW5S2TUORAMBZRAMI`

---

## Spoofing

### Spoofing.1 — Attacker impersonates the oracle to submit a forged proof

**Affected component:** VRF Contract, `fulfill()` function
**Severity:** Critical

**Description:** An attacker calls `fulfill()` with fabricated proof data, attempting
to inject a chosen randomness value.

**Remediation (Spoofing.1.R.1):** The contract enforces `oracle_address.require_auth()`.
Only the Stellar account that was registered during `init()` can invoke `fulfill()`.
The proof struct is additionally verified via on-chain `ed25519_verify()` (oracle signature)
and `bls12_381_pairing_check()` (VRF proof validity). Forging any of these is
computationally infeasible.

### Spoofing.2 — Attacker impersonates the VRF contract in a consumer callback

**Affected component:** Consumer contracts, `on_vrf()` callback
**Severity:** High

**Description:** An attacker calls `on_vrf()` directly on a consumer contract with
fake randomness, bypassing the VRF contract entirely.

**Remediation (Spoofing.2.R.1):** Consumer authorization documentation (`docs/CONSUMER_AUTHORIZATION.md`)
instructs developers to call `vrf_contract.require_auth()` inside their callback.
The example contract in `consumer-example/` demonstrates this pattern.

---

## Tampering

### Tampering.1 — Oracle biases VRF output by choosing a favorable input

**Affected component:** VRF Contract, alpha seed derivation
**Severity:** Critical

**Description:** The oracle crafts the `alpha_seed` to produce a desired `beta_output`,
biasing the randomness.

**Remediation (Tampering.1.R.1):** The contract re-derives `alpha_seed` on-chain from
`sha256(context || round || sha256(drand_signature))` and compares it to the proof's
claimed alpha. Any tampering causes a mismatch and the transaction reverts. The VRF is
deterministic for a given key and alpha — there is no second input the oracle can tweak.

### Tampering.2 — Oracle front-runs by using a known drand beacon

**Affected component:** VRF Contract, round binding
**Severity:** High

**Description:** The oracle knows the drand beacon value at request time, allowing it
to predict and potentially censor unfavorable results.

**Remediation (Tampering.2.R.1):** Every request is bound to a future drand round
(`round_offset >= 2`, enforced in `init()`). The beacon hasn't been published when the
request is created, so the oracle cannot know the VRF input in advance.

### Tampering.3 — Key rotation used to install a malicious oracle key

**Affected component:** VRF Contract, `rotate_oracle_keys()`, `rotate_drand_pk()`
**Severity:** High

**Description:** An attacker who compromises the oracle's Stellar account rotates the
keys to install their own BLS keypair, gaining full control over future proofs.

**Remediation (Tampering.3.R.1):** `rotate_oracle_keys()` requires `current_oracle.require_auth()`.
An attacker needs the Stellar secret key, not just the BLS key. After rotation, any pending
requests locked to the old oracle PK will fail verification, forcing timeout refunds.
Monitoring for unexpected key rotation events is critical (see monitoring plan).

---

## Repudiation

### Repudiation.1 — Oracle denies having received or ignored a request

**Affected component:** VRF Contract, event emission
**Severity:** Medium

**Description:** The oracle claims it never saw a request event, avoiding accountability
for missed fulfillments.

**Remediation (Repudiation.1.R.1):** All requests emit on-chain events via
`env.events().publish()` with the `request` topic. These events are immutable in the
ledger and can be independently verified by any Stellar node or indexer. The `timeout_refund()`
mechanism ensures requesters are not stuck regardless of oracle behavior.

---

## Information Disclosure

### Information_Disclosure.1 — Oracle secret key leaks, allowing proof forgery

**Affected component:** Oracle Worker (off-chain), BLS secret key
**Severity:** Critical

**Description:** If the oracle's BLS secret key is leaked, an attacker can generate
valid VRF proofs and control randomness output.

**Remediation (Information_Disclosure.1.R.1):** The BLS secret key is stored only in the
oracle worker's `.env` file and never transmitted on-chain. `rotate_oracle_keys()` enables
immediate key replacement without contract redeployment. The Ed25519 key and Stellar account
are rotated atomically in the same call.

### Information_Disclosure.2 — VRF output predictable before fulfillment

**Affected component:** VRF Contract, randomness derivation
**Severity:** Medium

**Description:** Someone predicts the VRF output before `fulfill()` is called, gaining
an unfair advantage in games or lotteries.

**Remediation (Information_Disclosure.2.R.1):** The VRF output depends on the oracle's
BLS secret key (known only to the oracle) and the drand beacon (unpublished at request time
due to `round_offset >= 2`). Even the oracle cannot predict the output until the drand
round is published. `derive_random()` uses rejection sampling to eliminate modulo bias,
bounded to 10 iterations for deterministic costs.

---

## Denial of Service

### Denial_of_Service.1 — Oracle goes offline, requests never fulfilled

**Affected component:** Oracle Worker (off-chain)
**Severity:** Medium

**Description:** The single oracle node crashes or is taken offline. New requests
accumulate but are never fulfilled.

**Remediation (Denial_of_Service.1.R.1):** `timeout_refund()` allows the requester to
reclaim their request after `TIMEOUT_ROUNDS` (20 drand rounds, ~60 seconds). This limits
the impact to temporary unavailability. Long-term, a multi-oracle threshold scheme is
planned for mainnet.

### Denial_of_Service.2 — Spam requests exhaust oracle gas budget

**Affected component:** Oracle Worker, gas costs
**Severity:** Low

**Description:** An attacker floods the contract with cheap `request()` calls, forcing
the oracle to spend gas on `fulfill()` for each one.

**Remediation (Denial_of_Service.2.R.1):** The `fee_token` and `fee_amount` parameters
in `init()` allow charging per-request fees via SAC token transfer. Currently set to 0
for testnet; will be configured for mainnet to make spam economically costly.

### Denial_of_Service.3 — Storage entries expire before oracle can fulfill

**Affected component:** VRF Contract, persistent storage TTL
**Severity:** Low

**Description:** Soroban persistent storage entries expire, causing `fulfill()` to fail
because the request data no longer exists.

**Remediation (Denial_of_Service.3.R.1):** `request_internal()` extends TTL on all entries
by `PERSISTENT_TTL_EXTEND` (518,400 ledgers, ~30 days). `fulfill()` extends again on
completion. `cleanup_proof()` removes only proof data but preserves the `Fulfilled` flag
with an extended TTL.

---

## Elevation of Privilege

### Elevation.1 — Callback re-entrancy to double-fulfill a request

**Affected component:** VRF Contract, `fulfill()` + consumer callback
**Severity:** High

**Description:** A malicious consumer callback re-enters `fulfill()` to trigger a second
fulfillment for the same or different request, potentially causing inconsistent state.

**Remediation (Elevation.1.R.1):** The contract follows CEI (Checks-Effects-Interactions):
`Fulfilled(request_id)` is set to `true` before the callback is invoked. Additionally,
a transient `Fulfilling(request_id)` guard is set before and cleared after the callback.
Any re-entrant call hits the "already fulfilled" check and reverts.

### Elevation.2 — Replay of a valid fulfill transaction

**Affected component:** VRF Contract, `fulfill()` idempotency
**Severity:** High

**Description:** An attacker replays a previously valid `fulfill()` transaction to
re-trigger the callback or corrupt state.

**Remediation (Elevation.2.R.1):** The `Fulfilled(request_id)` flag is permanent and
checked at the start of `fulfill()`. A second call for the same `request_id` always
panics with "already fulfilled". Soroban's built-in transaction deduplication provides
an additional layer of protection.

### Elevation.3 — Unauthorized timeout refund

**Affected component:** VRF Contract, `timeout_refund()`
**Severity:** Medium

**Description:** Someone other than the original requester calls `timeout_refund()` to
mark requests as refunded, denying the legitimate requester their refund.

**Remediation (Elevation.3.R.1):** `timeout_refund()` calls `requester.require_auth()`
where `requester` is the original address that created the request. Only the original
requester can trigger the refund state transition.
