# Stellar-VRF V2 — internal security review

Date: 2026-11-13. Scope: `soroban-contract/` (V2), `oracle-worker/`, the SDKs'
on-chain interface, `consumer-example/`, and the `v2_*.mjs` operator tools, at
the head of `v2/security-epochs`.

**This is not an independent audit.** It was carried out by the same AI
assistant (Claude) that wrote a large part of the V2 changes, so it cannot give
the assurance of a third-party review. It was done adversarially: every
function was read asking "who can call this, when, and what do they gain", and
each finding below is backed by a test or by a quoted line of the Soroban host
source. Not covered: the web pages, the HA/Redis infrastructure configuration,
operational key management, and formal verification.

## Summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| H-1 | High | Requester could veto an output: a late `fulfill()` raced `timeout_refund()` | **Fixed** |
| M-1 | Medium | Worker handled requests one at a time; a few cheap requests delayed everyone else's | **Fixed** (capacity limit remains, see below) |
| M-3 | Medium (availability) | Only one `request()` can succeed per ledger | **Open** — needs a design decision |
| M-2 | Medium (integration) | The output is public between `fulfill()` and `deliver()` | By design; **consumer rule documented** |
| L-1 | Low | `alpha` was not bound to the contract or network | **Fixed** |
| L-2 | Low | Admin ≠ operator was not re-checked when a rotation executes | **Fixed** |
| L-3 | Low | Worker's automatic `deliver()` could cost more than the request fee | **Fixed** |
| L-4 | Low | Timelocks are counted in ledgers | Accepted, documented |
| L-5 | Low | Pending proposals never expire | Accepted, documented |
| I-1 … I-7 | Info | See below | Documented |

No finding allows forging an output, and none was found that lets the operator
choose between outputs. One availability finding (M-3) is still open.

## Findings

### H-1 — Requester veto through the fulfill / refund race (fixed)

Before: `timeout_refund()` became available to the requester 20 rounds after
the bound round, but `fulfill()` was still accepted after that. Transactions
are gossiped across the Stellar overlay before they are applied, and the
arguments of `fulfill()` contain the output. A requester running a node could
therefore watch a late fulfill transaction and, if it disliked the output,
submit `timeout_refund()` for the same ledger. Soroban's apply order inside a
ledger is pseudo-random, so the refund wins about half the time, at no cost
when it loses. Making the oracle late was cheap (see M-1). For a lottery whose
contract is the requester, this is the operator of the lottery biasing its own
draw.

Fix: the two windows are now disjoint. `fulfill()` is rejected once the
current drand round is past `required_round + TIMEOUT_ROUNDS`, which is exactly
the complement of the refund condition, so in any ledger at most one of the two
can succeed. `TIMEOUT_ROUNDS` was raised from 20 to 100 (5 minutes) to leave
room for an HA failover. A request that is not fulfilled in time can only be
refunded.

Tests: `test_fulfill_and_refund_windows_are_disjoint`,
`test_fulfill_after_window_rejected`, `test_late_valid_proof_cannot_beat_refund`.
Testnet drill: `oracle-worker/late_fulfill_check.ts`.

### M-1 — Serial request handling in the worker (fixed)

The listener awaited each request before starting the next. Every request waits
9–12 s for its drand round and then a ledger for its transaction, so throughput
was about 3–4 requests per minute and everything behind a burst was late. With
H-1 fixed, "late" means "expired", so an attacker could have made other users'
requests expire by sending a handful of its own (which are then refunded to it).

Fix: requests are handled concurrently (`WORKER_CONCURRENCY`, default 16).
Only the on-chain submission is serialized, per signing account, because an
account's transactions need consecutive sequence numbers. The worker also skips
requests whose window has closed instead of paying for a doomed transaction.

Remaining limit: one operator account submits about one `fulfill()` per ledger
(~10 per minute). A sustained flood beyond that still expires requests (each
flooding request pays the fee if fulfilled). Raising the limit needs several
fulfillments per ledger (channel accounts); not implemented.

### M-3 — One request per ledger (open)

Request ids come from a global counter, and each request's storage keys
contain its id. A Soroban transaction must declare the storage keys it touches
when it is simulated. Two `request()` transactions simulated against the same
state both declare the keys of id `n + 1`; whichever is applied second is
assigned `n + 2`, touches keys it did not declare, and fails. So at most one
`request()` succeeds per ledger (~5 s), and everyone else in that ledger pays
a transaction fee for nothing and has to retry. V1 behaves the same way.

Measured on Testnet: 6 accounts requesting at the same time needed 15 failed
transactions and 28 s before all six requests were on-chain.

Consequences: a hard ceiling of about 12 requests per minute for the whole
contract, and a cheap way to keep other users out: one request per ledger
(0.2 XLM each, about 144 XLM per hour) makes most competing requests fail.

Options:
1. **Ids that do not depend on global order** (the real fix): for example
   `id = first 8 bytes of sha256(requester ‖ per-requester nonce)`, with a
   collision check. Requests by different requesters then never conflict. Ids
   stop being 1, 2, 3…; the worker's recovery would list recent `request`
   events instead of walking the counter (enough now that a request is only
   fulfillable for 5 minutes). Touches the contract, the test fixtures, the
   worker's reconciliation and anything that assumes sequential ids.
2. **Client-side padding** (mitigation): the SDK declares the keys of the next
   few ids as well, so a request survives a few others landing first. No
   contract change, slightly higher fees, does not stop a deliberate flood.
3. Accept and document the limit.

### M-2 — The output is public before the consumer processes it (by design)

`fulfill()` stores and emits the output; `deliver()` runs `on_vrf` in a later
transaction. In between, everyone knows the output while the consumer's state
has not changed. A consumer that still accepts bets, entries or withdrawals
after it called `request()` can be exploited in that gap (also atomically, by a
contract that acts and then calls `deliver()` itself).

This is the price of keeping consumer code out of `fulfill()`, which is what
stops a callback from blocking or undoing a result. The operator always knew
the output before anyone else, so consumers already had to do this; V2 makes it
mandatory against everyone. Rule (now in `V2_SECURITY_MODEL.md`): **freeze
everything the outcome depends on before calling `request()`**.

### L-1 — `alpha` not bound to the deployment (fixed)

`alpha` was `sha256(request_id ‖ context ‖ round ‖ sha256(sig) ‖ epoch_id)`.
Two deployments sharing an oracle BLS key (testnet and mainnet, or two mainnet
instances) would produce the same output for the same tuple, so a result on one
could be read off the other. `alpha` now starts with a domain tag and the XDR
of the contract address, which also commits to the network.

Tests: `test_proof_for_another_deployment_rejected`; worker
`a different contract changes alpha`. Operational rule stays: one BLS key per
deployment.

### L-2 — Role separation after an admin transfer (fixed)

A rotation to operator X could be proposed, the admin role then transferred to
X, and the rotation executed, leaving admin = operator. `execute_key_rotation`
now re-checks. (An admin can always hold both keys off-chain; the check guards
against mistakes, not against a malicious admin.)

Test: `test_rotation_cannot_make_operator_equal_admin_after_admin_transfer`.

### L-3 — Cost of automatic delivery (fixed)

The worker pays for `deliver()`, and what `on_vrf` costs is up to the consumer.
The cap was 0.2 XLM on the whole transaction fee, i.e. the entire request fee.
It is now a cap on the resource fee (`DELIVER_MAX_RESOURCE_FEE_STROOPS`,
default 0.03 XLM); a more expensive callback is left for the consumer to
deliver. Set `AUTO_DELIVER=false` to never pay for callbacks.

### L-4 — Timelocks in ledgers (accepted)

The rotation and upgrade timelocks are ledger counts (2 880 ≈ 4 h and
8 640 ≈ 12 h at ~5 s per ledger). If the network's ledger time drops, the same
counts mean less wall-clock time. They are constructor parameters with
compile-time floors: choose them with margin at deployment.

### L-5 — Proposals do not expire (accepted)

A pending rotation, upgrade or admin transfer can be executed any time after
its timelock, however old. All three are visible on-chain (`pending_*`
getters), and a pending upgrade pauses new requests for as long as it exists.
Monitor them; cancel what is not going to be executed.

### Informational

- **I-1 Untyped errors.** The contract panics with strings, which the release
  WASM does not carry: on-chain every failure is `Error(WasmVm, InvalidAction)`.
  Clients cannot tell "already fulfilled" from "window closed". Recommended:
  a `#[contracterror]` enum with `panic_with_error!`.
- **I-2 No re-entry.** Soroban prohibits contract re-entry, so `on_vrf` cannot
  call back into the VRF contract (for example to request the next draw or to
  call `derive_random_in_range`). Derive locally (see `consumer-example`) and
  request again in a separate transaction.
- **I-3 Proof cleanup.** The operator may remove the stored proof of a
  fulfilled request (after delivery). The proof stays in the fulfill
  transaction; `get_beta` keeps working.
- **I-4 Admin powers.** The admin can upgrade the code (12 h notice, requests
  paused) and can cancel pending results of an epoch by revoking it (visible,
  stops the service until a rotation executes). The admin is a trusted role;
  use a multisig and monitor `propose_upg`, `propose_rot`, `epoch_revkd`.
- **I-5 Ledger close time.** The bound round is 9–12 s after the request
  ledger's close time. Validators choose close times; a stalled network plus a
  malicious nomination leader could close a ledger with an old timestamp and
  bind a request to an already published round. Not exploitable without
  controlling consensus leadership.
- **I-6 Withholding.** The operator can decline to fulfill. It cannot choose an
  output, but a consumer that re-requests after a refund gives it a re-roll.
  Consumers must cancel the event instead.
- **I-7 Fee token.** The constructor accepts any token address. The worker
  refuses anything but native XLM on Mainnet.

## Verified properties

- **Unique output per request.** `pairing_check` deserializes every point with
  on-curve and subgroup checks (`soroban-env-host` 26.1.3,
  `checked_g1_vec_from_vecobj` / `checked_g2_vec_from_vecobj`) and rejects
  non-canonical encodings (flag bits, field elements ≥ p:
  `validate_point_encoding`). So `gamma` and the drand signature each have one
  accepted byte string, and `beta` and `alpha` are functions of those bytes.
- **Unambiguous `alpha` pre-image.** `context` is the only variable-length
  field and lies between fixed-length fields.
- **Domain separation.** drand, VRF and proof-of-possession use different
  hash-to-curve DSTs; the PoP message binds contract, epoch and key.
- **Authorization.** `fulfill` requires the operator of the request's epoch;
  governance requires the stored admin; `request` requires the requester, and
  callbacks can only target the requester's own `on_vrf`.
- **State machine.** A request ends in exactly one of fulfilled / refunded.
  `Fulfilled` and `Refunded` are persistent entries, which Soroban archives
  rather than deletes, so an expired flag cannot read as "absent".
- **Key epochs.** A request is verified against the key that was active when it
  was created; rotation and revocation cannot change the output of a pending
  request (`test_new_key_cannot_fulfill_old_epoch_request`, Testnet rotation).
- **Re-entrancy.** Prohibited by the host; effects precede the callback in
  `deliver` regardless.
- **Arithmetic.** Counters use checked arithmetic; round arithmetic saturates.

## Testnet check of the fixes

Contract `CBECNOM3XBHSSXT6WD42BIR3TNGHPM75TQAMO7O4NRBHVUNWIBPALTEO`
(WASM `74b054dd…2462f5`), 2026-11-13.

- **H-1:** request #1 was left unfulfilled. The same valid proof simulated
  `fulfill()` successfully inside the window (current round 33935268, window
  end 33935364) and was rejected after it (round 33935371). The refund then
  went through: `6620b72007b105e0e4baecc57c881c4bab23f7990ef653afe9604254a7b8f4d7`.
  The restarted worker skipped the request ("past its fulfillment window").
- **L-1:** all fulfillments below use the contract-bound `alpha`.
- **M-1:** eight requests (#2–#9), six of them submitted at once, were all
  fulfilled, each 7–18 s after it reached the chain, with the worker handling
  them concurrently and no sequence-number errors.
- **M-3** was found by this run (see above).

Not re-run on this build: key rotation (its logic is unchanged; the earlier
run is in `V2_SECURITY_MODEL.md`) and the consumer callback path.

## What would still be worth an outside look

An independent review of the same code, a decision on M-3, typed contract
errors (I-1), and higher worker throughput (M-1) before high-volume use.
