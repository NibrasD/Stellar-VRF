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
[`CBTCC5QL5T3JSLEZO4PH6LSJYEQF6GEFDCAO67OXI4DTM5NXMK6TSUHU`](https://stellar.expert/explorer/public/contract/CBTCC5QL5T3JSLEZO4PH6LSJYEQF6GEFDCAO67OXI4DTM5NXMK6TSUHU)

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
| Query state (`is_fulfilled`, `is_refunded`, `derive_random_in_range`) | ✅ |
| Read events (`get_request_events`, `get_fulfill_events`) | ✅ |
| Wait for fulfillment | ✅ |
| Client-side derivation (`derive_random_from_beta`) | ✅ |
| **Submitting transactions** (`request`, `fulfill`) | ❌ **not supported** |

**Why:** signed transaction submission needs a fully-formed, correctly serialized
`TransactionEnvelope`. The internal envelope builder here is sufficient only for
simulation, which does not validate signatures or sequence numbers. Rather than
imply otherwise, this SDK does not expose write operations.

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
        contract_id: "CBTCC5QL5T3JSLEZO4PH6LSJYEQF6GEFDCAO67OXI4DTM5NXMK6TSUHU".into(),
        network: Network::Mainnet,
        secret_key: std::env::var("STELLAR_SECRET")?,   // never hard-code secrets
    });

    // Check whether a request has been fulfilled
    let fulfilled = client.is_fulfilled(1).await?;
    println!("fulfilled: {fulfilled}");

    // Derive a number in the inclusive range [1, 100].
    // The last argument is the domain-separation context; pass &[] for the default.
    let roll = client.derive_random_in_range(1, 1, 100, &[]).await?;
    println!("roll: {roll}");

    Ok(())
}
```

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

- Secret keys are used **locally** for signing and are never transmitted.
- Binding to a future drand round prevents the oracle from choosing a favourable
  output.
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
