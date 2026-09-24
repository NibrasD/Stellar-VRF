# Consumer Authorization

This doc explains how authorization works when your contract receives a VRF callback,
and what you need to do to handle it safely.

## How callbacks work

When your consumer contract calls `request_with_callback()`, it registers itself to receive
the verifiable randomness callback. The VRF contract enforces strict confused-deputy protection:
- **Binding to Requester**: `callback_contract` must equal `requester`. A third party cannot
  designate your contract as a callback target.
- **Requester Authorization**: `callback_contract.require_auth()` is enforced by the VRF contract.
- **Fixed Callback Method**: The callback method is strictly restricted to `on_vrf`.

```
Consumer Contract ───request_with_callback(on_vrf)───▶ VRF Contract
                                                              │
Oracle Worker ──────────fulfill()───────────────────▶ VRF Contract
                                                              │
                                                              └─on_vrf()─▶ Consumer Contract
                                                                           (caller = VRF contract)
```

This guarantees that callbacks are only ever delivered to the contract that initiated the request.

## Authorizing the callback

The right approach is to store the VRF contract's address when you initialize your consumer
contract, then check it inside the callback:

```rust
pub fn on_vrf(env: Env, request_id: u64, beta_output: BytesN<32>, alpha_seed: BytesN<32>) {
    let vrf_contract: Address = env.storage().instance()
        .get(&ConsumerKey::VrfContract).unwrap();
    vrf_contract.require_auth();

    // beta_output is your random value — use it here
}
```

A common mistake is to try `require_auth()` on the original user or the oracle. Neither of
those are the caller in this context, so it will always fail. Another mistake is to skip auth
entirely — that means anyone could call `on_vrf()` with fake randomness and your contract
would accept it.

## If your callback fails

The VRF contract calls `on_vrf()` with `try_invoke_contract`. If your callback panics or
returns an error:

- **your callback's state changes are rolled back**, but the request is still marked
  fulfilled, the oracle is still paid, and the VRF contract emits
  `cb_failed(request_id, your_contract)`;
- **you will not be called again** for that request. Read the output yourself with
  `get_proof(request_id)` (or `is_fulfilled` + `get_proof`) and process it in a normal
  function you control.

So a callback that reverts can't block the oracle, and it can't get the randomness
re-delivered to you either. In particular, never revert in `on_vrf()` because you don't
like the result: the result is already final on-chain. Keep callbacks cheap. A callback
that exhausts the transaction's CPU/memory budget can't be isolated by Soroban, so it
makes the whole `fulfill()` fail. The oracle worker stops retrying such a request after
a few sends (`MAX_SENDS_PER_REQUEST`), and you'd have to use `timeout_refund()`.

> This behaviour is live on the current deployment (Mainnet `CAW6KECQ…UPRX`, Testnet
> `CBEDNSJ6…JTBR`). Only the legacy instance `CBTCC5QL…` reverted `fulfill()` when a callback
> panicked.

**What is isolated and what is not:**

| Callback behaviour | Effect |
|---|---|
| Ordinary failure (panic, error, trap, missing `on_vrf`) | **Isolated.** `fulfill()` commits and emits `cb_failed` |
| Expensive callback (over `MAX_FULFILL_INSTRUCTIONS` / fee caps in simulation) | **Guarded before sending.** The worker refuses to submit, and the request is parked |
| Exhausting the transaction's CPU/memory budget | **Not isolated.** Soroban meters the whole call tree under one budget, so the whole `fulfill()` fails. This is a residual limitation, not something the contract can fix |

## Refunds for contract requesters

`timeout_refund(request_id)` calls `requester.require_auth()`, and the fee goes back to
the requester. Nobody else can trigger it.

- **Account (G…) requester:** the account calls `timeout_refund` directly.
- **Contract (C…) requester** (every callback consumer, because `requester` must equal
  `callback_contract`): only that contract can authorize the refund. The VRF contract sees
  a direct call from the consumer contract as authorized. So **your consumer contract has
  to expose its own refund entrypoint** that calls `timeout_refund(request_id)` on the VRF
  contract, with whatever access control you need (e.g. admin-only). Without one, a
  timed-out fee stays escrowed in the VRF contract for good. Nobody else can recover it
  for you.

```rust
pub fn refund_sample(env: Env, caller: Address, request_id: u64) {
    caller.require_auth();
    // ... check caller is your admin ...
    let vrf: Address = env.storage().instance().get(&ConsumerKey::VrfContract).unwrap();
    env.invoke_contract::<()>(&vrf, &Symbol::new(&env, "timeout_refund"),
        soroban_sdk::vec![&env, request_id.into_val(&env)]);
    // The escrowed fee is now back in this contract's balance.
}
```

See `refund_sample` in [`consumer-example/src/lib.rs`](../consumer-example/src/lib.rs).

## Making callbacks idempotent

Your callback should be safe to call more than once for the same `request_id`. The simplest
way is to check whether you've already processed it:

```rust
let key = ConsumerKey::RandomResult(request_id);
if env.storage().persistent().has(&key) {
    return; // already handled
}
// ... process the result, then store it
env.storage().persistent().set(&key, &beta_output);
```

In practice the VRF contract's own re-entrancy guard makes double-invocation very unlikely,
but defensive programming is cheap insurance.

## Validating request ownership

If your callback function name is something generic like `on_vrf`, there's a theoretical risk
that someone calls it with a `request_id` that belongs to a different consumer. Guard against
this by tracking which request IDs your contract actually created:

```rust
let pending_key = ConsumerKey::PendingRequest(request_id);
if !env.storage().persistent().has(&pending_key) {
    panic!("not our request");
}
```

## Quick reference

- **Auth the VRF contract**, not the user or oracle. The VRF contract is the caller.
- **Use `beta_output`** as your random value. `alpha_seed` is the deterministic input —
  it's included for transparency but isn't random.
- **Don't assume timing.** The oracle might fulfill within seconds or it might take a minute.
  Your callback should work regardless.
- **Derive values from `beta_output` in the callback** (see `derive_in_range` in the example),
  or later via `get_beta()` / `derive_random()` / `derive_random_in_range()`. These keep working
  after `cleanup_proof()`, which removes only the bulky proof (the 32-byte `beta` is kept).
  They are still subject to Soroban storage TTL, so store what you need.

For a working example, see [`consumer-example/src/lib.rs`](../consumer-example/src/lib.rs) —
it implements a random sampling contract that demonstrates all of the above.
