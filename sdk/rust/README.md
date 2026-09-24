# stellar-vrf-sdk

[![crates.io](https://img.shields.io/crates/v/stellar-vrf-sdk.svg)](https://crates.io/crates/stellar-vrf-sdk)
[![docs.rs](https://docs.rs/stellar-vrf-sdk/badge.svg)](https://docs.rs/stellar-vrf-sdk)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/NibrasD/Stellar-VRF/blob/main/LICENSE)

Rust SDK for the **Stellar VRF Oracle** — verifiable, tamper-proof on-chain
randomness for Stellar/Soroban.

Randomness comes from the [drand](https://drand.love) quicknet beacon and is proven
with a **BLS12-381 pairing check executed on-chain**, so every result is publicly
auditable. Each request is bound to a *future* drand round, so with the registered
keys unchanged the oracle can neither predict nor bias the outcome.

> **Trust assumption:** the oracle account can rotate the oracle and drand keys
> (`rotate_oracle_keys` / `rotate_drand_pk`), and `fulfill()` verifies against the
> keys registered *at fulfillment time*. Whoever controls that account can therefore
> bias outputs. Watch for `rotate_ok` / `rotate_dk` events. See
> [THREAT_MODEL.md](https://github.com/NibrasD/Stellar-VRF/blob/main/docs/THREAT_MODEL.md).

**Live on Stellar Mainnet:**
[`CAW6KECQMHRTX2GS3JVHWBMOB5JNNOHNOCE635RQS4SWJ72YF56EUPRX`](https://stellar.expert/explorer/public/contract/CAW6KECQMHRTX2GS3JVHWBMOB5JNNOHNOCE635RQS4SWJ72YF56EUPRX)

## Installation

```bash
cargo add stellar-vrf-sdk
```

## Scope — read this first

This crate is a **read-only client**. It is intentionally dependency-light: it does
not pull in `stellar-xdr`, and instead talks to Soroban JSON-RPC
`simulateTransaction` using compact hand-rolled XDR builders.

| Capability | Supported |
|---|---|
| Query state (`is_fulfilled`, `is_refunded`, `get_beta`, `derive_random_in_range`, `derive_range_for_domain`) | ✅ |
| Read events (`get_request_events`, `get_fulfill_events`) | ✅ |
| Wait for fulfillment | ✅ |
| Offline derivation identical to the contract (`derive_range_from_beta`, `derive_range_for_domain_from_beta`, `derive_u64_from_beta`) | ✅ |
| **Submitting transactions** (`request`, `fulfill`) | ❌ **not supported** |

**Why:** a signed submission needs a real source account and sequence number, a
Soroban resource footprint and fee from simulation, auth entries, and a signature.
The internal builder produces only the **unsigned simulation envelope**: a v1
`TransactionEnvelope` with an all-zero source account, sequence 1, fee 100, no
auth and no signatures. That is what RPC `simulateTransaction` accepts for
read-only calls, and it is byte-identical to what `@stellar/stellar-sdk`'s
`TransactionBuilder` produces for the same call (checked by
`test_simulation_envelope_matches_stellar_sdk`). It would be rejected if
submitted, so this SDK doesn't expose write operations, and `secret_key` in
`VrfClientConfig` is currently unused (an empty string is fine).

**Wire format.** The encoders and the XDR decoder are tested against vectors from
the official `@stellar/stellar-sdk` encoder, against the contract's real event XDR,
and against live Mainnet `getEvents` output. Event values are decoded strictly:
an unexpected shape is an error, never a silent default.

> **Upgrade note:** releases before this fix used wrong `ScVal` discriminants
> (e.g. `Symbol = 10`, which is `I128`). As a result, `get_request_events` /
> `get_fulfill_events` never returned events, and the simulation envelope was
> rejected by the RPC ("Could not unmarshal transaction"). Upgrade if you
> depend on either.

**To submit transactions**, use the
[JavaScript SDK](https://www.npmjs.com/package/stellar-vrf-sdk) or the
[Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli),
both of which use audited XDR serialization.

## Quick Start

```rust
use stellar_vrf_sdk::{VrfClient, VrfClientConfig, Network};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = VrfClient::new(VrfClientConfig {
        contract_id: "CAW6KECQMHRTX2GS3JVHWBMOB5JNNOHNOCE635RQS4SWJ72YF56EUPRX".into(),
        network: Network::Mainnet,
        secret_key: String::new(), // unused: this client is read-only
    });

    // Check whether a request has been fulfilled
    let fulfilled = client.is_fulfilled(1).await?;
    println!("fulfilled: {fulfilled}");

    // Derive a number in the inclusive range [1, 100].
    // Exactly uniform in [1, 100]. SDK 2.x: no derivation-time context (it allowed grinding).
    let roll = client.derive_random_in_range(1, 1, 100).await?;
    println!("roll: {roll}");

    Ok(())
}
```

> ⚠ **Domains must be committed before fulfillment.** `derive_range_for_domain` /
> `derive_range_for_domain_from_beta` work after the result is public, so a domain chosen
> afterwards can be ground (try `A`, `B`, `C`, keep the best). If the value must be fair,
> the domain has to be a constant or a value stored before `request()`.

### Waiting for fulfillment

```rust
// Polls every 3s until fulfilled; returns VrfError::Timeout after timeout_secs.
client.wait_for_fulfillment(1, 120).await?;
```

### Reading oracle activity

```rust
let latest = client.get_latest_ledger().await?;

// (start_ledger, limit)
let requests = client.get_request_events(latest.saturating_sub(1000), 20).await?;
let fulfills = client.get_fulfill_events(latest.saturating_sub(1000), 20).await?;
```

### Error type

All fallible calls return `Result<_, VrfError>`, covering RPC failures, a
not-yet-fulfilled request (`NotFulfilled`) and polling timeouts (`Timeout`).

## How it works

```
Your dApp ──request()──▶ VRF Contract ◀──fulfill()── Oracle
                              │                        │
                              │                  drand beacon
                              ▼                  BLS-VRF proof
                   ✓ pairing check verified on-chain
                   ✓ random output recorded on-chain
```

1. Call `request()` with arbitrary context bytes.
2. The oracle waits for a **future** drand round and builds a BLS12-381 VRF proof.
3. The contract verifies `e(gamma, G2) == e(H(alpha), PK)` on-chain and stores it.
4. Read the result, or derive a number in any range.

## Independently verifying a result

You do not have to trust the oracle. The proof is stored in contract storage after
fulfillment (until it is removed via `cleanup_proof()` or archived by storage TTL)
and is always recoverable from the `fulfill` transaction itself:

```text
alpha = sha256(request_id ‖ context ‖ drand_round ‖ sha256(drand_signature))
beta  = sha256(BETA_DOMAIN ‖ gamma)
```

Cross-check the beacon against the public drand API:

```text
https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/<round>
```

## Security notes

- This client never signs anything. `secret_key` is not used or transmitted,
  so don't give it a real key.
- Binding to a future drand round (published 3–6 s after the request ledger under
  normal ledger-clock alignment) prevents the oracle from choosing a favourable
  output while the registered keys are unchanged.
- Fulfillment is idempotent: a request can only be fulfilled once.
- If the oracle never answers, the requester can call `timeout_refund()` after the
  timeout window (currently 20 drand rounds).
- Full [threat model](https://github.com/NibrasD/Stellar-VRF/blob/main/docs/THREAT_MODEL.md).

## Related

- JavaScript/TypeScript SDK: [`stellar-vrf-sdk` on npm](https://www.npmjs.com/package/stellar-vrf-sdk)
- [Interactive Playground](https://nibrasd.github.io/Stellar-VRF/playground/)
- [Live Dashboard](https://nibrasd.github.io/Stellar-VRF/dashboard/)
- [Integration Guide](https://nibrasd.github.io/Stellar-VRF/example-dapp/)
- [Repository](https://github.com/NibrasD/Stellar-VRF)

## License

MIT
