# @stellar-vrf/sdk

JavaScript/TypeScript SDK for the Stellar VRF Oracle.

## Installation

```bash
npm install @stellar-vrf/sdk
```

## Quick Start

```typescript
import { VrfClient, Networks } from "@stellar-vrf/sdk";
import { Keypair } from "@stellar/stellar-sdk";

const client = new VrfClient({
  contractId: "CCOX44NFMB3G4TDOLG5EKCXBP3EZ5PCEC3SQNMWP24WG6BA6HCSU2CBE",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
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
| `deriveRandomInRange(requestId, min, max)` | `Promise<bigint>` | Get random number in range |

### `requestWithCallback`

```typescript
const requestId = await client.request(context, {
  callbackContract: "C...",  // your consumer contract
  callbackFn: "on_vrf",      // callback function name
});
```

### Utility Functions

```typescript
import { deriveRandomFromBeta } from "@stellar-vrf/sdk";

// Client-side derivation without a contract call
const roll = deriveRandomFromBeta(betaHex, 1n, 6n);
```

## Networks

```typescript
import { Networks } from "@stellar-vrf/sdk";

Networks.TESTNET  // "Test SDF Network ; September 2015"
Networks.MAINNET  // "Public Global Stellar Network ; September 2015"
```

## License

MIT
