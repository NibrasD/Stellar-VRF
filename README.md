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
                      ✓ Random output stored permanently
                                │
Your dApp  ◀─derive_random_in_range()──┘
```

1. Your dApp calls `request()` on the VRF smart contract
2. The oracle fetches a **future** drand quicknet beacon (`round_offset ≥ 2` — prevents prediction)
3. Oracle generates a BLS12-381 VRF proof bound to your context + drand randomness
4. The contract verifies the proof with **on-chain BLS12-381 pairing checks** (~58M CPU instructions)
5. The verified random output is stored permanently on-chain
6. Anyone can independently re-verify — no trust required

## Live

| | |
|---|---|
| **Contract** | [`CCN75KEGLETGRTVJJDMXB2ZRQD6PC2S56VUOEKVLQPVEIJYGSOV55G57`](https://stellar.expert/explorer/public/contract/CCN75KEGLETGRTVJJDMXB2ZRQD6PC2S56VUOEKVLQPVEIJYGSOV55G57) |
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
  contractId: "CCN75KEGLETGRTVJJDMXB2ZRQD6PC2S56VUOEKVLQPVEIJYGSOV55G57",
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

## Performance

`fulfill()` measured at **58,641,186 CPU instructions** on mainnet — well within the 75M Soroban limit with 21.8% headroom. See [`docs/PROFILING.md`](docs/PROFILING.md).

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
