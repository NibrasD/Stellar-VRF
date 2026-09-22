# stellar-vrf-sdk

[![npm](https://img.shields.io/npm/v/stellar-vrf-sdk.svg)](https://www.npmjs.com/package/stellar-vrf-sdk)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/NibrasD/Stellar-VRF/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.12.0-brightgreen.svg)](https://nodejs.org)

JavaScript/TypeScript SDK for the **Stellar VRF Oracle** — verifiable, tamper-proof
on-chain randomness for Stellar/Soroban.

Randomness is produced from the [drand](https://drand.love) quicknet beacon and
proven with a **BLS12-381 pairing check executed on-chain**, so every result is
independently auditable. The oracle cannot bias or predict outputs: each request is
bound to a *future* drand round.

**Live on Stellar Mainnet:**
[`CBTCC5QL5T3JSLEZO4PH6LSJYEQF6GEFDCAO67OXI4DTM5NXMK6TSUHU`](https://stellar.expert/explorer/public/contract/CBTCC5QL5T3JSLEZO4PH6LSJYEQF6GEFDCAO67OXI4DTM5NXMK6TSUHU)

- 🔬 [Interactive Playground](https://nibrasd.github.io/Stellar-VRF/playground/)
- 📊 [Live Dashboard](https://nibrasd.github.io/Stellar-VRF/dashboard/)
- 📖 [Integration Guide](https://nibrasd.github.io/Stellar-VRF/example-dapp/)
- 🦀 Rust SDK: [`stellar-vrf-sdk`](https://crates.io/crates/stellar-vrf-sdk)

## Requirements

- **Node.js ≥ 22.12.0** (required by `@stellar/stellar-sdk` v17)
- A funded Stellar account to pay transaction fees (~0.13 XLM per fulfillment)

## Installation

```bash
npm install stellar-vrf-sdk @stellar/stellar-sdk
```

## How it works

```
Your dApp ──request()──▶ VRF Contract ◀──fulfill()── Oracle
                              │                        │
                              │                  drand beacon
                              ▼                  BLS-VRF proof
                   ✓ pairing check verified on-chain
                   ✓ random output stored permanently
```

1. You call `request()` with arbitrary context bytes.
2. The oracle waits for a **future** drand round, then builds a BLS12-381 VRF proof.
3. The contract verifies the proof on-chain and stores the output.
4. You read the result, or derive a number in any range.

## Quick Start

```typescript
import { VrfClient, Networks } from "stellar-vrf-sdk";
import { Keypair } from "@stellar/stellar-sdk";

const client = new VrfClient({
  contractId: "CBTCC5QL5T3JSLEZO4PH6LSJYEQF6GEFDCAO67OXI4DTM5NXMK6TSUHU",
  rpcUrl: "https://mainnet.sorobanrpc.com",
  networkPassphrase: Networks.PUBLIC,
  keypair: Keypair.fromSecret("S..."),
});

// Submit a randomness request
const context = new TextEncoder().encode("my-game-round-42");
const requestId = await client.request(context);
console.log("Request ID:", requestId);

// Wait for fulfillment (up to 120 seconds)
const proof = await client.waitForFulfillment(requestId, 120_000);
console.log("Random output:", Buffer.from(proof.betaOutput).toString("hex"));

// Derive a number in range [1, 100]
const roll = await client.deriveRandomInRange(requestId, 1n, 100n);
console.log("Random roll:", roll);
```

## API Reference

### `new VrfClient(config)`

| Field | Type | Description |
|---|---|---|
| `contractId` | `string` | VRF contract address (C...) |
| `rpcUrl` | `string` | Soroban RPC URL |
| `networkPassphrase` | `string` | Stellar network passphrase |
| `keypair` | `Keypair` | Keypair for signing transactions |
| `maxFee` | `string?` | Max fee in stroops (default: `"1000000"`) |

### Methods

| Method | Returns | Description |
|---|---|---|
| `request(context, options?)` | `Promise<bigint>` | Submit a randomness request |
| `isFulfilled(requestId)` | `Promise<boolean>` | Check if request is fulfilled |
| `getProof(requestId)` | `Promise<VrfProof \| null>` | Get the VRF proof |
| `waitForFulfillment(requestId, timeoutMs?, intervalMs?)` | `Promise<VrfProof>` | Wait for fulfillment |
| `deriveRandomInRange(requestId, min, max, context?)` | `Promise<bigint>` | Get random number in inclusive range `[min, max]`. `context` is optional domain-separation bytes. |

### `requestWithCallback`

```typescript
const requestId = await client.request(context, {
  callbackContract: "C...",  // your consumer contract
  callbackFn: "on_vrf",      // callback function name
});
```

### Utility Functions

```typescript
import { deriveRandomFromBeta } from "stellar-vrf-sdk";

// Client-side derivation without a contract call
const roll = deriveRandomFromBeta(betaHex, 1n, 6n);
```

## Networks

```typescript
import { Networks } from "stellar-vrf-sdk";

Networks.TESTNET  // "Test SDF Network ; September 2015"
Networks.PUBLIC   // "Public Global Stellar Network ; September 2015"
```

> **v1.0.0 note:** use `Networks.PUBLIC` for mainnet. A `Networks.MAINNET` alias is
> added in v1.0.1.

## Independently verifying a result

You never have to trust the oracle. Every fulfilled request keeps its proof on-chain:

```typescript
const proof = await client.getProof(requestId);

// alpha = sha256(request_id ‖ context ‖ drand_round ‖ sha256(drand_signature))
// beta  = sha256(BETA_DOMAIN ‖ gamma)
// The contract already checked e(gamma, G2) == e(H(alpha), PK) on-chain.
console.log(proof.drandRound);      // which drand beacon was used
console.log(proof.gammaPoint);      // G1 VRF output point
console.log(proof.publicKey);       // oracle's G2 public key
```

Cross-check the beacon yourself against the public drand API:

```
https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/<round>
```

## Error handling

```typescript
try {
  const requestId = await client.request(context);
  const proof = await client.waitForFulfillment(requestId, 120_000);
} catch (err) {
  // waitForFulfillment throws on timeout — the request stays valid on-chain and
  // can still be polled later with isFulfilled()/getProof().
  console.error(err.message);
}
```

Common contract-side rejections (surfaced as transaction failures):

| Message | Meaning |
|---|---|
| `already fulfilled` | This request ID was already answered |
| `oracle key mismatch` | Proof signed by a non-current oracle key |
| `drand round mismatch` | Proof round differs from the round locked at request time |
| `drand signature verification failed` | Beacon signature failed the BLS check |
| `context exceeds maximum length` | Context exceeded `MAX_CONTEXT_LEN` (1024 bytes) |

## Refunds

If the oracle never answers, the requester can reclaim escrowed fees after the
timeout window (`timeout_rounds`, currently 20 drand rounds) by calling
`timeout_refund()` on the contract.

## Security notes

- Your secret key is used **locally** to sign transactions; it is never transmitted.
- Randomness is bound to a *future* drand round, so the oracle cannot pick a
  favourable output.
- Fulfillment is idempotent — a request can only ever be fulfilled once.
- See the [threat model](https://github.com/NibrasD/Stellar-VRF/blob/main/docs/THREAT_MODEL.md).

## Links

- [Repository](https://github.com/NibrasD/Stellar-VRF)
- [Issues](https://github.com/NibrasD/Stellar-VRF/issues)
- [Operations guide](https://github.com/NibrasD/Stellar-VRF/blob/main/docs/OPERATIONS.md)

## License

MIT
