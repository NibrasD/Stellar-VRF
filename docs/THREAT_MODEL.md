# Threat Model

This document covers the security assumptions and known risks for the Stellar VRF Oracle.
It is a living document updated as the protocol evolves.

## Architecture

```
Consumer Contract  ──request()──▶  VRF Oracle Contract  ◀──fulfill()──  Oracle Worker (off-chain)
                                         │                                      │
                                         │                             drand quicknet (BLS beacon)
                                         │
                                   on_vrf() callback
```

The system has three principals: the consumer (any Soroban contract), the VRF oracle contract
(on-chain), and the oracle worker — a **single logical oracle identity** (one BLS keypair and
one Ed25519 keypair) that is operated by **multiple worker instances in HA mode**. Exactly one
instance holds the leader lease at a time and submits transactions; the others stand by.

## Trust assumptions

**drand quicknet.** We rely on the drand distributed randomness beacon for unpredictability.
The quicknet chain uses a BLS threshold scheme across a geographically distributed committee.
Historical uptime is >99.9%. If the chain rotates its group key, the oracle account must call
`rotate_drand_pk()` to update the on-chain verification key. This covers key rotation within the
same chain only. Switching to a drand chain with a different genesis, period or signature scheme
needs a new contract deployment (see *Known limitations*).

We do **not** trust the drand *HTTP relay* that serves beacons. Verification happens twice:

1. **On-chain (authoritative).** `verify_drand_signature()` runs a BLS pairing check
   `e(sig, G2_gen) == e(H(sha256(round_be)), drand_pk)` against the `DrandPK` stored in
   instance storage. A forged beacon therefore can **never** produce accepted randomness —
   the transaction reverts.
2. **Off-chain (resource protection).** The worker re-runs the *same* check locally in
   `verifyDrandBeacon()` (`oracle-worker/src/drand.ts`) before building a proof, using the
   compressed group key in `DRAND_PUBLIC_KEY`. Without this step a compromised or simply
   buggy relay could feed the worker garbage and the worker would spend CPU on a BLS-VRF
   proof and pay to submit a transaction guaranteed to be rejected — a **fee-drain / DoS**
   vector, not an integrity break. Beacons served under the wrong round are rejected too.
   Controlled by `DRAND_VERIFY_BEACONS` (default on). The worker **refuses to start** with it
   disabled on Mainnet or with `NODE_ENV=production` (set in the Docker image), so it can only be
   turned off for local testnet debugging.

**Single oracle identity.** This is the most important trust boundary to understand. The design
uses **one oracle key** (a single logical oracle), even though it is run by a primary plus a
hot-standby worker instance for liveness. HA removes the *availability* single-point-of-failure,
but it does **not** distribute *trust* — all instances share the same oracle key. This means:

- *Bias resistance holds only while the registered keys are fixed.* For a **fixed** oracle BLS
  key and a **fixed** drand key, the oracle cannot choose the output: the input is bound to a
  future drand round, the VRF is deterministic, and both pairing checks run on-chain.
  **That premise is not enforced by the contract.** `fulfill()` checks the keys that are
  registered *at fulfillment time*, not the ones registered when the request was made. And the
  oracle account alone can change both keys, with no delay:
  - `rotate_drand_pk()` → the holder installs a "drand" key it controls. It can then sign any
    beacon it likes, so it chooses alpha, and therefore **chooses the output** (and can
    predict it).
  - `rotate_oracle_keys()` → once the drand round is public, the holder can try many BLS keys
    offline and rotate to the one that gives a favourable output before fulfilling
    (**grinding / bias**).

  So the integrity of the randomness depends on **whoever controls the oracle account**.
  That includes the legitimate operator, not only an attacker who steals the key. The oracle
  is a **trusted party for unpredictability and bias resistance**, not just for liveness.
  **Detection:** every rotation emits an on-chain event (`rotate_ok` / `rotate_dk`).
  Integrators should alert on these events, and treat any request fulfilled after a rotation
  whose round was already public at rotation time as suspect.
  **Structural fix (needs a contract change and redeployment):** snapshot the oracle and drand
  keys into each request at `request()` time and verify against the snapshot. Also put
  rotations behind a timelock longer than `TIMEOUT_ROUNDS` and/or under an admin authority
  separate from the fulfilling key.

- *Liveness is NOT guaranteed.* If the oracle goes down, requests won't get fulfilled. We handle
  this with a timeout mechanism: after `TIMEOUT_ROUNDS` (20 drand rounds, ~60s), the requester
  can call `timeout_refund()` to reclaim their escrowed fee. The fee is held in the VRF contract
  itself (not sent to the oracle) until fulfillment, so the requester is always protected
  financially. A multi-oracle threshold scheme is a future improvement under consideration.

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
This is blocked by **three independent layers of defense**:

1. **Soroban VM host-level guard.** The Soroban runtime itself prevents a contract from being
   re-entered during its execution. Any cross-contract call that would re-enter the same
   contract panics with `"Contract re-entry is not allowed"`. This was confirmed by our
   cross-contract re-entrancy test using a `MaliciousConsumer` contract.
2. **CEI pattern (application layer).** The `Fulfilled` flag is set *before* the callback is
   invoked (Effects before Interactions), so even without the VM guard, re-entering `fulfill()`
   would fail the "already fulfilled" check.
3. **Fulfilling transient key (belt-and-suspenders).** A transient `Fulfilling(request_id)` key
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

After rotation, pending requests are **not** locked to the old oracle PK. The contract checks
the **currently configured** oracle key at fulfillment time. This means:
- The **new** oracle node can fulfill requests that were created before rotation.
- The attacker (with old/compromised keys) **cannot** fulfill any request after rotation,
  because `fulfill()` compares `proof.public_key` against the updated `OraclePK` in instance storage.

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

## Known limitations

- **Single oracle identity** — liveness is addressed by HA (primary + hot-standby sharing one
  oracle key via a Redis leader lease), but *trust* is not distributed. A future improvement is a
  multi-oracle threshold committee so that no single key can withhold service.
- **Fee economics / request spam** — the `fee_amount` parameter and escrow mechanism are fully
  implemented and tested (fees are escrowed in the VRF contract on request, released to oracle on
  fulfill, refunded to requester on timeout). The Mainnet instance is deployed with
  `fee_amount = 0` (verified from instance storage), and `fee_amount` is immutable after `init()`.
  Consequence: a requester pays only the Stellar network fee per `request()`, while the oracle
  pays ~0.14 XLM per `fulfill()`. Unchecked, an attacker could **drain the oracle's XLM
  balance**. That's an availability/cost attack, not an integrity one. **Mitigation in the
  worker (fee guard, `src/feeGuard.ts`):** before any drand wait or proof work, each request is
  checked:
  1. The oracle never submits below `MIN_ORACLE_BALANCE_XLM`, and fails closed if the balance
     is unreadable. This is re-checked with a fresh balance before every send.
  2. A request counts as "paid" only if `FeeToken` is the **native XLM SAC** and
     `FeeAmount ≥ FULFILL_COST_STROOPS`. A fee in any other token counts as unpaid, because
     the worker has no price for it.
  3. Requesters on `UNPAID_REQUESTER_ALLOWLIST` are served. They don't count against the
     budget.
  4. For everyone else, **immediately before every `sendTransaction()`** (including retries),
     the transaction's maximum fee is atomically reserved against `UNPAID_BUDGET_XLM_PER_HOUR`
     (default 1.5 XLM) in a rolling-hour **spend ledger**. If the reservation fails, the
     transaction is not sent.

  **What is guaranteed:** the total of transaction max-fees sent for unpaid, non-allowlisted
  requests is ≤ the budget per rolling hour. Stellar never charges more than a transaction's
  max fee, so this bounds real spend. It holds across retries, ambiguous timeouts and
  resubmissions, because each send reserves its own fee. With `REDIS_URL` set, the ledger is
  shared by all instances and survives restarts and failover. It uses Redis' clock and an
  atomic Lua script; see `spend_ledger_drill.mjs`, which runs in CI. Without Redis, it's a
  file, with the same single-host scope as the file lock. If the ledger is unavailable, the
  worker fails closed.
  **What is NOT guaranteed:** the balance floor bounds only how far the account can fall, not
  the rate. Allowlisted and paid requests aren't budget-limited. On a non-XLM fee token,
  "paid" is never assumed.
  **Residual risk: selective liveness denial.** Anyone can use up the shared unpaid budget
  with cheap `request()` calls. After that, legitimate non-allowlisted requesters wait and may
  only get `timeout_refund()`. The attack changes from *economic drain* into *denial of
  service for permissionless users*. The current Mainnet instance therefore **does not
  guarantee liveness to non-allowlisted requesters**. The structural fix is a deployment with
  `fee_amount` ≥ the fulfill cost, **in XLM**. `mainnet_deploy.mjs` enforces this.
- **Oracle key is a single point of failure for administration** — there is no separate admin
  role. The oracle Stellar account authorizes `fulfill()`, `rotate_oracle_keys()` and
  `rotate_drand_pk()`. Losing it makes the deployment unrotatable (requests can only time out
  and be refunded). **Compromising the *currently authorised* oracle account breaks the
  oracle trust assumption.** The attacker can withhold or censor service, and can also
  **bias or choose outputs** of pending and future requests through `rotate_drand_pk()` /
  `rotate_oracle_keys()` (see *Trust assumptions*). This lasts until it's detected, and on the
  current contract **there is no independent authority to recover**: only the same account
  can rotate. Compromise of an *old* key after a rotation is harmless: `fulfill()` rejects it.
  Treat Stellar multisig (signer weights/thresholds) and/or a hardware signer for the oracle
  account as a **security requirement**, not an operational nicety. The HA hosts should hold
  only the operational key material they need.
- **`rotate_drand_pk()` is not a chain migration** — it swaps the group key only. drand genesis,
  period and the signature DST (quicknet, G1, unchained) are fixed, and there is no upgrade
  entrypoint, so moving to a different drand chain requires a new deployment.
- **Results are not permanent in contract storage** — `cleanup_proof()` (requester or oracle)
  deletes proof/context/callback data, and all persistent entries are subject to Soroban TTL
  archival. The `fulfill` transaction and event remain the durable record.
- **No formal audit** — the contract has 60 unit tests and has been manually reviewed,
  but has not undergone a formal third-party audit.
