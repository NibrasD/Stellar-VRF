# Consumer Authorization Model

## Overview

When a consumer contract calls `request_with_callback()`, it registers itself to receive
a callback from the VRF contract after the oracle fulfills the randomness request.

This document explains the **authorization model** for that callback and how to write
a safe consumer contract.

---

## Who is the Caller?

When `on_vrf(request_id, beta_output, alpha_seed)` is invoked on your consumer contract,
the **caller is the VRF Oracle Contract**, not the original user who initiated the request.

```
User/App ──request_with_callback()──▶ VRF Contract
                                           │
Oracle ──fulfill()──▶ VRF Contract         │
                           │               │
                           └──on_vrf()────▶ Consumer Contract
                                           (caller = VRF Contract)
```

This is by design:
- The oracle worker does not know about individual consumer contracts.
- The VRF contract is the authoritative source that a request was validly fulfilled.
- Requiring the oracle to auth the callback would create tight coupling and increase attack surface.

---

## How to Authorize Callbacks Correctly

### ✅ Correct Pattern

Store the VRF contract address at initialization and call `require_auth()` on it inside the callback:

```rust
pub fn on_vrf(env: Env, request_id: u64, beta_output: BytesN<32>, alpha_seed: BytesN<32>) {
    // The VRF contract must be the caller.
    let vrf_contract: Address = env.storage().instance()
        .get(&ConsumerKey::VrfContract).unwrap();
    vrf_contract.require_auth(); // ← This is the correct authorization check

    // Now safe to use beta_output as randomness.
    // ...
}
```

### ❌ Incorrect Pattern — Do NOT do this

```rust
pub fn on_vrf(env: Env, request_id: u64, ...) {
    // WRONG: requiring the original user's auth will ALWAYS fail
    // because the VRF contract is the caller, not the user.
    original_user.require_auth(); // ← This will panic every time
}
```

### ❌ Also Incorrect — No auth check

```rust
pub fn on_vrf(env: Env, request_id: u64, beta_output: BytesN<32>, ...) {
    // WRONG: anyone can call this function and inject fake randomness
    env.storage().set(&key, &beta_output); // ← Vulnerable
}
```

---

## Idempotency Requirement

Your callback MUST be idempotent — calling it twice with the same `request_id` should
be safe. Add a guard:

```rust
if env.storage().persistent().has(&ConsumerKey::RandomResult(request_id)) {
    panic!("already processed"); // or just return silently
}
```

This protects against edge cases where the VRF contract's re-entrancy guard is cleared
and a malicious contract attempts a second invocation.

---

## Validating request_id Ownership

Your contract should track which `request_id` values it initiated and reject callbacks
for unknown IDs:

```rust
if !env.storage().persistent().has(&ConsumerKey::PendingRequest(request_id)) {
    panic!("unknown request_id");
}
```

This prevents an attacker from calling `on_vrf` with a `request_id` from a different
consumer contract that happens to share your callback function name.

---

## Summary Checklist for Consumer Contracts

| Requirement | Implementation |
|---|---|
| ✅ Auth the VRF contract, not the user | `vrf_contract.require_auth()` inside callback |
| ✅ Idempotency guard | Check if `RandomResult(request_id)` already exists |
| ✅ Ownership validation | Check `PendingRequest(request_id)` was set by your contract |
| ✅ Use `beta_output` for randomness, not `alpha_seed` | `alpha_seed` is deterministic input; `beta_output` is the random output |
| ✅ Do not make assumptions about callback timing | The oracle may fulfill seconds or minutes after request |
| ✅ Handle the case where cleanup_proof was called | If you need the proof later, call `derive_random()` during the callback |

---

## Reference Implementation

See [`consumer-example/src/lib.rs`](../consumer-example/src/lib.rs) for a complete
working example that implements a dice-roll game using VRF randomness.
