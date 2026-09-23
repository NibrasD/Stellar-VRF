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
2. The oracle fetches a **future** drand quicknet beacon (`round_offset ≥ 2` rounds after the current one, i.e. published 3–6 s after the request — prevents prediction)
3. Oracle generates a BLS12-381 VRF proof bound to your context + drand randomness
4. The contract verifies the proof with **on-chain BLS12-381 pairing checks** (~58M CPU instructions)
5. The verified random output (`beta`) is written to contract storage and emitted in the `fulfill` event. `cleanup_proof()` (requester or oracle) removes only the bulky proof: the `Fulfilled` flag and the 32-byte `beta` are kept, so `get_beta()` and the `derive_*()` functions keep working. All entries are still subject to Soroban storage TTL. Read or cache your result after fulfillment (see [Storage TTL Management](docs/OPERATIONS.md#storage-ttl-management)).
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

// Derive a random number in range [1, 1000] (exactly uniform, no modulo bias)
const result = await client.deriveRandomInRange(requestId, 1n, 1000n);
```

> **SDK 2.x requires the next contract deployment.** SDK 2.0 calls the new
> derivation signatures (`derive_random_in_range(request_id, max)`, no
> `context`). The Mainnet instance above still runs the older WASM, whose
> `derive_random_in_range` also takes a `context` argument. Use SDK 1.0.1
> against it until the redeployment is live. See
> [Deriving values](#deriving-values-from-a-result).

### Deriving values from a result

| Function | Output |
|---|---|
| `get_beta(id)` | the raw verified 32-byte output |
| `derive_random(id)` | a uniform `u64` |
| `derive_random_in_range(id, max)` | a value in `[0, max)`, **exactly** uniform |
| `derive_range_for_domain(id, domain, max)` | same, plus a short domain separator for several independent draws per request |

The inputs are the request id, `max` and `beta`, all fixed before anyone can
see the result. Earlier versions also took a free-form `context` argument at
derivation time. That let a caller who had already seen `beta` try many
contexts and keep the output they liked (grinding). It has been removed. Put
application data into `request(context)` instead: that value is committed
before the drand round is public.

> ⚠ **`derive_range_for_domain`: the domain must be fixed before fulfillment.**
> Use constants in your code (`b"card-1"`, `b"card-2"`) or values stored before
> `request()`. Never forward a user-chosen value there. The contract can't
> tell when a domain was chosen.

The SDKs reproduce all of these offline from `beta`
(`deriveRangeFromBeta` / `derive_range_from_beta`, …), byte-for-byte, using
shared test vectors.

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
    // Use beta_output as your random value. Keep on_vrf() cheap: the oracle
    // refuses to send a fulfill() whose simulated cost exceeds its resource
    // bounds (see "Consumer callbacks" below).
    // If this panics, fulfill() still succeeds and you are NOT called again:
    // read the result later with get_beta(request_id).
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

- **Single oracle identity.** One oracle key (Stellar account + BLS + Ed25519) controls `fulfill()`, `rotate_oracle_keys()` and `rotate_drand_pk()`. HA removes the *availability* single point of failure, but not the *key* single point of failure. If that key is lost, the oracle can't be rotated and requests can only be refunded. **If it's stolen, or its holder misbehaves, outputs can be biased, not just withheld.** `fulfill()` verifies against the keys registered *at fulfillment time*, and the same account can switch the drand key to one it controls (`rotate_drand_pk`), which lets it choose alpha. It can also grind BLS keys once a round is public (`rotate_oracle_keys`). This affects pending requests too. **The oracle is therefore a trusted party for bias resistance and unpredictability.** Monitor `rotate_ok` / `rotate_dk` events, and treat multisig / a hardware signer for the oracle account as a requirement. Per-request key snapshots and a rotation timelock would remove this. They need a redeployment and are not implemented ([details](docs/THREAT_MODEL.md#trust-assumptions)).
- **Request fee is currently 0 on Mainnet.** The deployed instance was initialised with `fee_amount = 0`, and `fee_amount` is immutable (no setter, no upgrade entrypoint). Anyone can create requests for the cost of the network fee alone, and the oracle pays about 0.14 XLM per `fulfill()`. Unchecked, **spam requests could drain the oracle account.** The worker's **fee guard** ([details](docs/OPERATIONS.md#economic-guard-zero-fee-contract)) bounds this:
  - It always keeps a minimum balance.
  - It serves an optional requester allowlist without limit.
  - For anyone else, it caps the **total transaction fees** at `UNPAID_BUDGET_XLM_PER_HOUR` (default 1.5 XLM) per rolling hour. The fee is reserved before *every* send, including retries. With Redis HA, the budget is shared across primary and standby and survives restarts.
  - Only a fee paid in native XLM counts as "paid".

  Deferred requests stay pending. After the timeout, requesters can recover their escrowed fee with `timeout_refund()`, but that doesn't deliver the randomness. **What this means for integrators:** anyone can use up the shared unpaid budget with spam. The current instance therefore **does not guarantee liveness** to non-allowlisted requesters, whose requests may time out and be refunded. The structural fix is a redeployment with `fee_amount` ≥ the fulfill cost. `mainnet_deploy.mjs` now refuses to deploy without one.
- **Fulfillment is best-effort, not guaranteed.** HA, the fee guard and reconciliation make fulfillment likely, but no component guarantees it. The contract guarantees only that a result, *if* delivered, is correct and final, and that an unfulfilled request can be refunded after `TIMEOUT_ROUNDS`.
- **Consumer callbacks are isolated from panics, not from cost (source; next deployment).** If your `on_vrf()` panics, `fulfill()` still succeeds, your callback's writes are rolled back, and a `cb_failed` event is emitted. Read the result with `get_beta()`. Soroban can't cap a sub-call's resources, though: `on_vrf()` runs inside the oracle's transaction and the oracle pays for it. An expensive callback can push `fulfill()` past network limits, and then **no** result is delivered. The worker therefore:
  - simulates every `fulfill()` and refuses to sign it if CPU, resource fee or max fee exceed `MAX_FULFILL_INSTRUCTIONS` (default 90M), `MAX_FULFILL_RESOURCE_FEE_STROOPS` or `MAX_FULFILL_TX_FEE_STROOPS`;
  - treats deterministic failures (contract panic, trapped / resource-limit-exceeded callback, refusal above) as **terminal**: the request is parked instead of retried, and the requester can `timeout_refund()`;
  - caps sends per request (`MAX_SENDS_PER_REQUEST`) for everything else.

  The deployed Mainnet instance still reverts `fulfill()` on a callback panic ([details](docs/THREAT_MODEL.md#callback-griefing-economic-dos-on-the-oracle)). **Keep `on_vrf()` small.** Store `beta` and do the heavy work in a later transaction.
- **drand chain is fixed.** `rotate_drand_pk()` rotates the key of the *configured* drand chain. It can't migrate the contract to a different drand chain (genesis/period/scheme are fixed). See [OPERATIONS.md](docs/OPERATIONS.md#rotate-drand-public-key).
- **Results are not stored forever.** See step 5 above.
- **The Mainnet WASM predates the current derivation and deployment fixes.** The deployed contract:
  - still uses the earlier `derive_random_in_range` rejection loop, which has a biased fallback (reachable only for `max` approaching 2^63; everyday ranges are unaffected);
  - still accepts a caller-chosen `context` at derivation time, which can be ground (see [Deriving values](#deriving-values-from-a-result));
  - was configured by a separate `init()` call;
  - numbers drand rounds one behind drand's own numbering (round 1 is at genesis), so the round a request is bound to is only **one** round ahead of the published beacon (0–3 s lead, sometimes already public at request time) instead of two (3–6 s). The requester still can't predict the output, but "even the oracle can't know the beacon at request time" does not hold on this instance ([details](docs/THREAT_MODEL.md#trust-assumptions)).

  The source replaces all four. Round numbering follows drand (`floor((now − genesis) / period) + 1`). Range derivation is **exactly** uniform (two-candidate rejection sampling, explicit failure with probability < 2^-128, no biased fallback). There is no derivation-time context. Configuration is atomic via `__constructor`, with key validation (no identity/generator/off-curve keys, oracle ≠ drand key). These changes ship with the next deployment ([details](docs/AUDIT_REPORT.md)).
- **"Can't bias" is conditional.** With the registered keys unchanged, the oracle can neither predict nor bias an output. The oracle account *can* rotate keys (see "Single oracle identity" above), and anything a caller chooses **after** seeing `beta` (for example a domain passed to `derive_range_for_domain`) can be ground by that caller. The contract only binds inputs committed before the drand round is public.
- **SDK scope.** The Rust SDK is a read/verify client. It doesn't submit transactions ([details](sdk/rust/README.md#scope--read-this-first)).

## Performance

`fulfill()` **without a callback** measured at **58,073,400 CPU instructions** (fee=0) and **58,342,003 CPU instructions** (nonzero-fee) on Stellar Mainnet. That is 22.2% headroom under the 75M target and 85.4% under the 400M protocol limit. See [`docs/PROFILING.md`](docs/PROFILING.md).

**Scope of the 75M figure:** it covers the **VRF core** only (drand signature check, BLS-VRF verification, Ed25519, storage, fee transfer), and a unit test enforces it. A callback request adds whatever the consumer's `on_vrf()` costs, which the contract can't bound. The worker's resource guard (`MAX_FULFILL_INSTRUCTIONS`, default 90M) is the operational cap for that case.

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
