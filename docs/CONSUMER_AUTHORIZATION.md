# Consumer Authorization

This doc explains how authorization works when your contract receives a VRF callback,
and what you need to do to handle it safely.

## How callbacks work

When you call `request_with_callback()`, you're telling the VRF contract: "after the oracle
fulfills my request, call `on_vrf()` on my contract." The important thing to understand is
that the VRF contract itself is the one making that call — not the oracle, and not the user
who originally sent the request.

```
User  ───request_with_callback()───▶  VRF Contract
                                           │
Oracle  ───fulfill()───▶  VRF Contract     │
                               │           │
                               └─on_vrf()─▶  Your Contract
                                              (caller = VRF contract)
```

This matters because it determines how you should authorize the callback.

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
- **Call `derive_random()` during the callback** if you need additional derived values.
  After `cleanup_proof()` is called, the raw proof data is gone.

For a working example, see [`consumer-example/src/lib.rs`](../consumer-example/src/lib.rs) —
it implements a random sampling contract that demonstrates all of the above.
