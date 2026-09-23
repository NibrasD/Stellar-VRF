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

**Contract:** `CBTCC5QL5T3JSLEZO4PH6LSJYEQF6GEFDCAO67OXI4DTM5NXMK6TSUHU` (Mainnet)
**Oracle address:** `GA6HYAVWPVOVB4XJHGUZSDHRVYOKLPU4JAHYPXZRSJWO2PM4HSCNKP5P`

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
deterministic for a given key and alpha, so with the **registered keys fixed** there is no
second input the oracle can tweak. The keys themselves can be rotated by the oracle account.
That residual is Tampering.3.

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

**Description:** Whoever controls the *current* oracle Stellar account (an attacker who
steals it, or the operator) rotates the keys and gains control over the outputs. This covers
pending requests as well as future ones:
- `rotate_drand_pk()` to a key it controls lets it sign an arbitrary "beacon". That fixes
  alpha, so it **chooses** the output.
- `rotate_oracle_keys()` after the drand round is public lets it grind BLS keys offline and
  install the one that gives a favourable output.

Pending requests are **not** locked to the keys active at request time. `fulfill()` checks
the keys registered at fulfillment time, so the new key can fulfill requests created before
the rotation (see `test_rotate_keys_new_oracle_successfully_fulfills_pending_request`).

**Remediation (Tampering.3.R.1), current contract (partial):**
`rotate_oracle_keys()` / `rotate_drand_pk()` require `current_oracle.require_auth()`, so an
attacker needs the oracle *Stellar* secret, not just the BLS key. Compromise of an old key
after rotation is harmless. Nothing on-chain stops the current key holder, though. The
mitigations are operational:
- protect the oracle account with multisig or a hardware signer;
- alert on every `rotate_ok` / `rotate_dk` event;
- distrust fulfillments that follow a rotation.

This is a **trust assumption**. The oracle is trusted for bias resistance, not just
liveness. See THREAT_MODEL.md.
**Remediation (Tampering.3.R.2), requires redeployment:** snapshot oracle and drand keys per
request at `request()` time. Put rotations behind a timelock longer than `TIMEOUT_ROUNDS`,
and/or behind an admin authority separate from the fulfilling key. **Status: not
implemented.**

---

## Repudiation

### Repudiation.1 — Oracle denies having received or ignored a request

**Affected component:** VRF Contract, event emission
**Severity:** Medium

**Description:** The oracle claims it never saw a request event, avoiding accountability
for missed fulfillments.

**Remediation (Repudiation.1.R.1):** All requests emit on-chain events via
`env.events().publish()` with the `request` topic. These events are immutable in the
ledger and can be independently verified by any Stellar node or indexer. Whatever the oracle
does, `timeout_refund()` lets the requester recover the escrowed fee after the timeout. It
doesn't deliver the randomness.

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
round is published, **provided it does not rotate the drand key to one it controls**
(Tampering.3). `derive_random_in_range()` maps the output into `[0, max)` by drawing
**128 bits** of hash entropy and reducing modulo `max` ("extra bits" reduction, NIST
SP 800-90A B.5.1.3 style): the deviation between residue classes is bounded by
$max / 2^{128} \le 2^{-64}$ for any `max < 2^64`, with **no biased fallback path** and a
**constant** instruction cost (one `sha256`, no loop). An earlier bounded rejection loop
that fell back to a plain 64-bit `% max` after 10 attempts was removed — that fallback was
biased and its documented $2^{-640}$ failure probability was incorrect (the true
per-attempt rejection probability approaches $1/2$ for `max` near $2^{63}$).
**Deployment note:** the live Mainnet contract predates this change and still runs the
old loop (verified on-chain). That matters only for very large `max`. A redeployment ships the fix.

---

## Denial of Service

### Denial_of_Service.1 — Oracle goes offline, requests never fulfilled

**Affected component:** Oracle Worker (off-chain)
**Severity:** Medium

**Description:** The single oracle node crashes or is taken offline. New requests
accumulate but are never fulfilled.

**Remediation (Denial_of_Service.1.R.1):** `timeout_refund()` allows the requester to
reclaim their escrowed fee and mark the request as refunded after `TIMEOUT_ROUNDS`
(20 drand rounds, ~60 seconds). The fee is held in the VRF contract itself (not sent
to the oracle) until fulfillment, so the requester's loss is limited to network fees.
This is a **refund path, not a liveness guarantee**: the randomness is still not
delivered, and the requester must claim the refund. HA (primary + hot standby)
reduces downtime but doesn't remove it. Long-term, a multi-oracle threshold scheme is planned.

### Denial_of_Service.1b — Malicious consumer callback makes every `fulfill()` revert

**Affected component:** VRF Contract `fulfill()` → consumer `on_vrf()`; Oracle Worker fees
**Severity:** High (economic DoS on the oracle), audit round 4 finding #1

**Description:** The callback was invoked with `env.invoke_contract`, so a consumer whose
`on_vrf()` panics reverted the whole `fulfill()`: proof, `Fulfilled` flag and oracle fee
transfer. The oracle still paid the network fee on each attempt, and the worker retried
without limit.

**Remediation (Denial_of_Service.1b.R.1), contract source, needs redeployment:**
the callback is invoked with `env.try_invoke_contract`. A failing callback only rolls back
its own writes and emits `cb_failed(request_id, callback_contract)`. The fulfillment and
fee payout stay committed, and the output is readable with `get_proof()`. Host budget
exhaustion can't be isolated by Soroban and still aborts the transaction; it normally shows
up at simulation, before any fee is spent.
**Remediation (Denial_of_Service.1b.R.2), worker, effective now:** a per-request cap on
`sendTransaction()` calls (`MAX_SENDS_PER_REQUEST`, default 6) across all retries and
reconciliation passes. After that the request is parked instead of retried forever. The cap
is per process, so restarts and failovers reset it; the fee guard's unpaid budget remains
the deployment-wide ceiling.

### Denial_of_Service.2 — Spam requests exhaust oracle gas budget

**Affected component:** Oracle Worker, gas costs
**Severity:** Low

**Description:** An attacker floods the contract with cheap `request()` calls, forcing
the oracle to spend gas on `fulfill()` for each one.

**Remediation (Denial_of_Service.2.R.1):** The `fee_token` and `fee_amount` parameters
in `init()` charge per-request fees via SAC token transfer into escrow. The fee is held
in the VRF contract and released to the oracle only upon successful fulfillment, or
refunded to the requester on timeout. Currently deployed with `fee_amount = 0`;
this can be configured to make spam economically costly.

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
Any re-entrant call is rejected (by the Soroban host re-entry guard first, then by
"already fulfilled"). Since callbacks are isolated with `try_invoke_contract`, that rejection
fails only the callback (a `cb_failed` event), never the outer fulfillment.

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
requester can trigger the refund and reclaim the escrowed fee.
