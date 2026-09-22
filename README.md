# Stellar VRF Oracle

A production-grade **Verifiable Random Function (VRF)** oracle for the Stellar/Soroban blockchain. Uses BLS12-381 cryptography with the [drand](https://drand.love) distributed randomness beacon to deliver tamper-proof, publicly auditable on-chain randomness.

## How It Works

```
Your dApp  ──request()──▶  VRF Contract  ◀──fulfill()──  Oracle
                                │                          │
                                │                    drand beacon
                                │                    BLS-VRF proof
                                ▼
                      ✓ Pairing check verified on-chain
                      ✓ Random output recorded on-chain
                                │
Your dApp  ◀─derive_random_in_range()──┘
```

1. Your dApp calls `request()` on the VRF smart contract
2. The oracle fetches a **future** drand quicknet beacon (`round_offset ≥ 2` — prevents prediction)
3. Oracle generates a BLS12-381 VRF proof bound to your context + drand randomness
4. The contract verifies the proof with **on-chain BLS12-381 pairing checks** (~58M CPU instructions)
5. The verified random output is written to contract storage and emitted in the `fulfill` event. The `Fulfilled` flag is retained, but the proof data can later be removed by `cleanup_proof()` (requester or oracle), and all entries are subject to Soroban storage TTL. Read or cache your result after fulfillment (see [Storage TTL Management](docs/OPERATIONS.md#storage-ttl-management)).
6. Anyone can independently re-verify — no trust required

## Live

| | |
|---|---|
| **Contract** | [`CBTCC5QL5T3JSLEZO4PH6LSJYEQF6GEFDCAO67OXI4DTM5NXMK6TSUHU`](https://stellar.expert/explorer/public/contract/CBTCC5QL5T3JSLEZO4PH6LSJYEQF6GEFDCAO67OXI4DTM5NXMK6TSUHU) |
| **Oracle** | [`GA6HYAVWPVOVB4XJHGUZSDHRVYOKLPU4JAHYPXZRSJWO2PM4HSCNKP5P`](https://stellar.expert/explorer/public/account/GA6HYAVWPVOVB4XJHGUZSDHRVYOKLPU4JAHYPXZRSJWO2PM4HSCNKP5P) |
| **Network** | Stellar Mainnet |
| **Dashboard** | [Live ↗](https://nibrasd.github.io/Stellar-VRF/dashboard/) |
| **Playground** | [Live ↗](https://nibrasd.github.io/Stellar-VRF/playground/) |
| **Integration Guide** | [Live ↗](https://nibrasd.github.io/Stellar-VRF/example-dapp/) |

## Quick Start — JavaScript SDK

Published on npm as
[`stellar-vrf-sdk`](https://www.npmjs.com/package/stellar-vrf-sdk). Requires
**Node.js ≥ 22.12.0** (`@stellar/stellar-sdk` v17 `engines.node`).

```bash
npm install stellar-vrf-sdk @stellar/stellar-sdk
```

> **Note for npm v1.0.0:** use `Networks.PUBLIC` instead of `Networks.MAINNET`
> (the `MAINNET` alias lands in v1.0.1). See
> [docs/SDK_RELEASE.md](docs/SDK_RELEASE.md).

```typescript
import { VrfClient, Networks } from "stellar-vrf-sdk";
import { Keypair } from "@stellar/stellar-sdk";

const client = new VrfClient({
  contractId: "CBTCC5QL5T3JSLEZO4PH6LSJYEQF6GEFDCAO67OXI4DTM5NXMK6TSUHU",
  rpcUrl:     "https://mainnet.sorobanrpc.com",
  networkPassphrase: Networks.PUBLIC,   // Networks.MAINNET also works from v1.0.1
  keypair:    Keypair.fromSecret("S..."),
});

// Request verifiable randomness
const context = new TextEncoder().encode("audit-round-42");
const requestId = await client.request(context);

// Wait for oracle fulfillment (~10-30s)
const proof = await client.waitForFulfillment(requestId, 120_000);

// Derive a random number in range [1, 1000]
const result = await client.deriveRandomInRange(requestId, 1n, 1000n);
```

## Quick Start — Rust SDK

Published on crates.io as
[`stellar-vrf-sdk`](https://crates.io/crates/stellar-vrf-sdk):

```bash
cargo add stellar-vrf-sdk
```

## Quick Start — Soroban Consumer Contract (Rust)

Your Soroban contract can request randomness and receive results via callback:

```rust
// Request: your contract calls the VRF contract
let request_id: u64 = env.invoke_contract(
    &vrf_contract,
    &Symbol::new(&env, "request_with_callback"),
    vec![&env, context, self_addr.clone(), self_addr, Symbol::new(&env, "on_vrf")],
);

// Callback: VRF contract calls your on_vrf() after fulfillment
pub fn on_vrf(env: Env, request_id: u64, beta_output: BytesN<32>, _alpha_seed: BytesN<32>) {
    let vrf_contract: Address = /* stored at init */;
    vrf_contract.require_auth(); // CRITICAL: verify caller is the VRF contract
    // Use beta_output as your random value
}
```

See [`consumer-example/`](consumer-example/) for a complete working example.

## Repository Structure

```
soroban-contract/   — On-chain VRF Oracle smart contract (Rust/Soroban)
oracle-worker/      — Off-chain Oracle Node (TypeScript)
consumer-example/   — Example consumer contract with callback (Rust/Soroban)
sdk/js/             — JavaScript/TypeScript SDK (stellar-vrf-sdk)
sdk/rust/           — Rust SDK (stellar-vrf-sdk)
dashboard/          — Real-time oracle activity dashboard
playground/         — Interactive VRF testing interface
example-dapp/       — Integration guide with live demo
docs/               — Operational and security documentation
```

## Key Features

- **On-chain BLS12-381 verification** via Soroban host functions (CAP-0059)
- **drand quicknet binding** with future-round enforcement — oracle cannot predict input
- **Callback support** — `request_with_callback()` for fully on-chain composability
- **Oracle key rotation** — atomic BLS + Stellar + Ed25519 key rotation
- **High availability** — primary + hot-standby on separate hosts with Redis leader election, validated by a live failover drill on Mainnet ([evidence](docs/HA_FAILOVER_EVIDENCE.md))
- **Re-entrancy protection** — transient lock per request ID
- **Storage TTL extension** — automatic TTL renewal on all persistent entries

## Trust Assumptions & Known Limitations

Please read these before integrating on Mainnet. Details are in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).

- **Single oracle identity.** One oracle key (Stellar account + BLS + Ed25519) controls `fulfill()`, `rotate_oracle_keys()` and `rotate_drand_pk()`. HA removes the *availability* single point of failure, but not the *key* single point of failure. If that key is lost, the oracle can't be rotated and requests can only be refunded. If it's stolen, the attacker can rotate the oracle to themselves and withhold service. The attacker still can't bias outputs, because the VRF output is deterministic and verified on-chain. Keep the oracle account under a multisig / hardware signer.
- **Request fee is currently 0 on Mainnet.** The deployed instance was initialised with `fee_amount = 0`, and `fee_amount` is immutable (no setter, no upgrade entrypoint). Anyone can create requests for the cost of the network fee alone, and the oracle pays about 0.14 XLM per `fulfill()`. Unchecked, **spam requests could drain the oracle account.** The worker's **fee guard** ([details](docs/OPERATIONS.md#economic-guard-zero-fee-contract)) bounds this. It always keeps a minimum balance. It serves an optional requester allowlist without limit. It fulfils at most `UNPAID_FULFILL_MAX_PER_HOUR` (default 10, about 1.5 XLM/hour) unpaid requests from anyone else. Deferred requests stay pending, and requesters are always protected by `timeout_refund()`. **What this means for integrators:** under spam, a non-allowlisted request on the current instance may not be fulfilled before its timeout. The structural fix is a redeployment with `fee_amount` ≥ the fulfill cost. `mainnet_deploy.mjs` now refuses to deploy without one.
- **drand chain is fixed.** `rotate_drand_pk()` rotates the key of the *configured* drand chain. It can't migrate the contract to a different drand chain (genesis/period/scheme are fixed). See [OPERATIONS.md](docs/OPERATIONS.md#rotate-drand-public-key).
- **Results are not stored forever.** See step 5 above.
- **The Mainnet WASM predates the latest range-derivation fix.** The deployed contract still uses the earlier `derive_random_in_range` rejection loop, which has a biased fallback. That fallback is reachable only for very large `max` values, approaching 2^63. Everyday ranges are unaffected. The 128-bit fix is in the source and ships with the next deployment ([details](docs/AUDIT_REPORT.md)).
- **SDK scope.** The Rust SDK is a read/verify client. It doesn't submit transactions ([details](sdk/rust/README.md#scope--read-this-first)).

## Performance

`fulfill()` measured at **58,073,400 CPU instructions** (fee=0) and **58,342,003 CPU instructions** (nonzero-fee) on Stellar Mainnet — well within the 75M target with 22.2% headroom and 85.4% headroom under the 400M protocol limit. See [`docs/PROFILING.md`](docs/PROFILING.md).

## Running the Oracle

```bash
cd oracle-worker
cp .env.example .env   # configure your keys
npx tsc --outDir dist
node dist/index.js
```

## Running Contract Tests

```bash
cd soroban-contract
cargo test
```

## Documentation

| Document | Description |
|---|---|
| [Integration Guide](https://nibrasd.github.io/Stellar-VRF/example-dapp/) | How to integrate VRF into your dApp |
| [`sdk/js/README.md`](sdk/js/README.md) | JavaScript SDK API reference |
| [`docs/CONSUMER_AUTHORIZATION.md`](docs/CONSUMER_AUTHORIZATION.md) | Consumer contract authorization model |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Day-to-day operational procedures |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | Step-by-step runbook for common tasks |
| [`docs/HA_DEPLOYMENT.md`](docs/HA_DEPLOYMENT.md) | High-availability deployment guide |
| [`docs/HA_FAILOVER_EVIDENCE.md`](docs/HA_FAILOVER_EVIDENCE.md) | Failover drill evidence (mechanism + two-host Mainnet) |
| [`docs/SDK_RELEASE.md`](docs/SDK_RELEASE.md) | SDK publishing procedure and release status |
| [`docs/INCIDENT_RESPONSE.md`](docs/INCIDENT_RESPONSE.md) | Incident response playbook |
| [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) | Security threat model |
| [`docs/PROFILING.md`](docs/PROFILING.md) | Instruction budget measurements |

## License

MIT
