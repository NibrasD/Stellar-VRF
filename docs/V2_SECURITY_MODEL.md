# Stellar-VRF V2: security model and operations

Status: **not deployed.** This describes the V2 contract on the
`v2/security-epochs-fixes` branch. The live Mainnet contract
(`CAW6KECQ…UPRX`) is V1 and keeps the V1 trust model described in the README.

## What changes for trust

| | V1 | V2 |
|---|---|---|
| Who can bias a pending request | the oracle account (rotate keys / drand key) | **nobody**: each request is bound to the key epoch active when it was created, and the drand key is fixed |
| What a stolen operator key can do | choose outputs | delay or withhold only |
| Key rotation | instant, by the oracle itself | admin only, 4 h minimum timelock, BLS proof of possession |
| drand key | rotatable by the oracle | fixed at construction |
| Consumer callback | runs inside `fulfill()` | separate `deliver()` after the result is final |
| Code upgrade | none | admin only, 12 h minimum timelock, new requests refused while pending |

The reasoning: BLS signatures are unique. Once the oracle's BLS key and the
drand key are fixed before the drand round is public, there is exactly one
valid `gamma` (and so one `beta`) per request. The operator can still refuse to
answer; it cannot pick an answer.

## Roles

- **Admin**: cold key or multisig Stellar account. Proposes/executes key
  rotations, revokes epochs, proposes/executes upgrades and admin transfers.
  Must differ from the operator (enforced). The admin is trusted for upgrades:
  new code can do anything. Watch `propose_upg` events; requests are paused
  while one is pending, and the timelock gives consumers time to react.
- **Operator**: hot key on the worker hosts. Can only `fulfill()` requests of
  its own epoch and receives the per-request fee.
- **drand quicknet**: the randomness beacon. Its group key does not change on
  reshares; a new key is a new chain, which needs a new deployment.

## Request lifecycle

1. `request()` / `request_with_callback()` — fee escrowed, request bound to
   the active epoch and to drand round `current + round_offset` (offset ≥ 4,
   so the beacon appears 9–12 s after the ledger closes).
2. `fulfill(id, proof)` — operator of the request's epoch; verifies the drand
   signature (fixed key), alpha (`request_id ‖ context ‖ round ‖ sha256(sig) ‖
   epoch_id`), the BLS-VRF pairing against the epoch key, and beta. Pays the fee
   to that epoch's operator. Runs no consumer code; its cost is fixed
   (58.28M CPU instructions simulated on Testnet, with or without a callback).
3. `deliver(id)` — anyone; calls `on_vrf(id, beta, alpha)` on the requester.
   If `on_vrf` fails, only the delivery reverts and can be retried. The result
   is always readable with `get_beta()`.
4. Unfulfilled requests: `timeout_refund(id)` by the requester after 20 rounds
   (60 s), by anyone after 28 800 rounds (24 h); `emergency_refund(id)` by
   anyone once the request's epoch is revoked. The fee always goes back to the
   requester.

## Rules for consumers

- **Never request new randomness for the same event after a refund.** Whoever
  withheld the first result would get a re-roll. Cancel or void the event.
- Store `beta` in your own contract from `on_vrf` (or read `get_beta`). After an
  upgrade the VRF contract's storage is only as trustworthy as the admin; the
  `fulfill` event in the ledger history is the permanent record.
- `on_vrf` must check `vrf_contract.require_auth()` and be idempotent.
- A consumer **contract** that pays the fee from its own balance must
  pre-authorize the fee transfer before calling `request_with_callback`:
  `env.authorize_as_current_contract(...)` for `transfer(self, vrf, fee)` on the
  fee token (read both with the VRF contract's `fee()`). The VRF contract makes
  that call, not the consumer, so without it every request fails.
  `consumer-example` shows the exact code.
- Domains passed to `derive_range_for_domain` must be fixed before `request()`.

## Key rotation runbook

1. Generate the new operator account and BLS key.
2. `NETWORK=… node oracle-worker/v2_rotate.mjs propose` (admin signs; the new
   operator signs its own authorization; the script computes the proof of
   possession).
3. Restart the worker with the **new** keys as `ORACLE_STELLAR_SECRET` /
   `ORACLE_BLS_SECRET_KEY` and the **old** keys as
   `ORACLE_PREVIOUS_STELLAR_SECRET` / `ORACLE_PREVIOUS_BLS_SECRET_KEY`. The
   startup check accepts either set matching the active epoch.
4. After the timelock: `v2_rotate.mjs execute`. New requests use the new epoch;
   requests made before keep using the old keys.
5. 24 h later (every old request is fulfilled or refundable by anyone), remove
   the `ORACLE_PREVIOUS_*` variables.

If an operator key is compromised: `v2_rotate.mjs revoke <epoch>` immediately
(no timelock). Its unfulfilled requests can be `emergency_refund`ed at once.
Revoking the active epoch stops new requests until a new rotation executes.

## Storage and TTL

Epoch records are never deleted (a deletion refunds no rent on Soroban, and a
pending request must always find its keys). The active epoch entry is extended
on every request and fulfillment, and `ttl_extend.mjs` keeps it alive together
with the instance and code entries when there is no traffic.

## Evidence

- `soroban-contract/src/test.rs`: 71 tests. Every success path uses a real
  drand quicknet beacon (round 32 427 720) and proofs generated with
  `@noble/curves`, recomputed on the Soroban host
  (`test_noble_vector_matches_host_computation`). Rotation keeps old requests
  on their epoch (`test_rotation_keeps_pending_requests_on_their_epoch`,
  `test_new_key_cannot_fulfill_old_epoch_request`); abandoned requests cannot
  block rotation (`test_many_rotations_with_abandoned_requests`); a failing
  callback cannot undo a result (`test_failing_callback_cannot_undo_result_and_stays_retryable`).
- `oracle-worker/src/vrf.test.ts`: the worker produces byte-identical proofs
  for the same fixtures.
- `test_pop_from_operator_tool_accepted`: the PoP produced by `v2_lib.mjs` is
  accepted by the contract.

## Testnet run (2026-11-13)

Contract `CDKQ3BGCJ3VRLYEHZB4QYE2RCLVQFPWALTXPC6N6VQIU2IG7NPPN7VGC`
(WASM `269f040c…1442d36`), deployed with `v2_deploy.mjs` by a separate admin
account; worker started with the chain-config check passing against V2 state.

| Step | Transaction | Result |
|---|---|---|
| Deploy (admin + operator auth) | `363202095b476899ab3a21710fcaf38aba1378ad58d10755a9d52d27de737f0f` | epoch 1 active |
| Request #1 via JS SDK | — | bound to epoch 1 |
| Fulfill #1 | `2a8b9944b647bc8ecf439530f35968d4e7358ed6e39137d588db31bcc71d560d` | 20 s after request; on-chain `derive_random_in_range` = SDK offline value |
| Consumer request #2 (callback, fee paid by the consumer contract) | `c7bbc88d3728b4ffad6f2f16bb0a326d39e86e87e8df8c7e00ae0c7135fc97ae` | |
| Fulfill #2 (no consumer code) | `68b5ac7df0e8e5606dff62429c9e11d6894c0bc617f6ecd32d07698f90cd1271` | 58.28M CPU, same as #1 |
| Deliver #2 (worker, separate tx) | `edb3ed848877f9ff615bd57d60b57e7d427f9e7039352e0621f9b6dddf638a1f` | consumer stored sample 38 |
| Request #3, worker stopped; early refund | — | rejected (window not reached) |
| Refund #3 after the window | `8b5e22db077ca87567d0cf729b71aab3aa95df44db787878bda7c2812722fdfc` | fee returned to requester |
| Propose rotation to epoch 2 (PoP from `v2_rotate.mjs`) | `721d0a5c11131a11a14676c32e9e340afc23413a70def123c1a0ccec321f974c` | accepted; execute before the timelock rejected |

Issues the run found (fixed on this branch): `@stellar/stellar-sdk` 17.1.0
cannot parse protocol-30 ledger headers (now ^17.4.0); the constructor's
operator authorization is non-root and must be simulated with
`record_allow_nonroot`; `consumer-example` could not pay a non-zero fee.

Not yet done: executing the rotation after its timelock (old-epoch request
fulfilled with the previous keys), and an external audit.
