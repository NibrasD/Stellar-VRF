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
2. The oracle fetches a **future** drand quicknet beacon (`round_offset ≥ 2` rounds after the current one, i.e. under normal ledger-clock alignment it is published 3–6 s after the request ledger closes. That delay is what prevents prediction, and it is not a hard guarantee: it depends on the ledger timestamp tracking real time)
3. Oracle generates a BLS12-381 VRF proof bound to your context + drand randomness
4. The contract verifies the proof with **on-chain BLS12-381 pairing checks** (~58M CPU instructions)
5. The verified random output (`beta`) is written to contract storage and emitted in the `fulfill` event. `cleanup_proof()` (requester or oracle) removes only the bulky proof: the `Fulfilled` flag and the 32-byte `beta` are kept, so `get_beta()` and the `derive_*()` functions keep working. All entries are still subject to Soroban storage TTL. Read or cache your result after fulfillment (see [Storage TTL Management](docs/OPERATIONS.md#storage-ttl-management)).
6. Anyone can independently re-verify — no trust required

## Live Deployments

| Network | Contract ID | Oracle Account | Status |
|---|---|---|---|
| **Mainnet** | [`CAW6KECQMHRTX2GS3JVHWBMOB5JNNOHNOCE635RQS4SWJ72YF56EUPRX`](https://stellar.expert/explorer/public/contract/CAW6KECQMHRTX2GS3JVHWBMOB5JNNOHNOCE635RQS4SWJ72YF56EUPRX) | [`GA6HYAVWPVOVB4XJHGUZSDHRVYOKLPU4JAHYPXZRSJWO2PM4HSCNKP5P`](https://stellar.expert/explorer/public/account/GA6HYAVWPVOVB4XJHGUZSDHRVYOKLPU4JAHYPXZRSJWO2PM4HSCNKP5P) | Active & Verified |
| **Testnet** | [`CBEDNSJ63LANUSJHRZSNQUV22X6JYU6E7PTUDIGQDOHNH7VIT4CAJTBR`](https://stellar.expert/explorer/testnet/contract/CBEDNSJ63LANUSJHRZSNQUV22X6JYU6E7PTUDIGQDOHNH7VIT4CAJTBR) | [`GA6HYAVWPVOVB4XJHGUZSDHRVYOKLPU4JAHYPXZRSJWO2PM4HSCNKP5P`](https://stellar.expert/explorer/testnet/account/GA6HYAVWPVOVB4XJHGUZSDHRVYOKLPU4JAHYPXZRSJWO2PM4HSCNKP5P) | Active & Verified |

### On-Chain Proof of Operation

| Operation | Mainnet Explorer Link | Testnet Explorer Link |
|---|---|---|
| **WASM Upload** | [`fe1b7f85...`](https://stellar.expert/explorer/public/tx/fe1b7f85b738bdc65620bffd9f10abbfdf7995adfbb4a7a90803c3a17c6cf41b) | [`59e0cd96...`](https://stellar.expert/explorer/testnet/tx/59e0cd96c43ee52546f1f8db23f96cd33ee79b8c501de93557b400c6bbe2c779) |
| **Deploy & Atomic Init** | [`fccef97c...`](https://stellar.expert/explorer/public/tx/fccef97c5ec84a1a8f483aee779f925c819fab99e91edc692e56644d1089af50) | [`1e832b86...`](https://stellar.expert/explorer/testnet/tx/1e832b864f80cb54f507109e4c1484e680e635a5b6234774e8d9155fa1a88d96) |
| **Live Request** | [`978297f0...`](https://stellar.expert/explorer/public/tx/978297f0df8d9e6c7ec1167043127287404821758586573e97a99265aa167cae) | [`dbc6a944...`](https://stellar.expert/explorer/testnet/tx/dbc6a944995acf762cbd944a16a3d9a8be7b35d22aee6fc65184cecc81c11040) |
| **Live Fulfillment** | [`e0cc4b60...`](https://stellar.expert/explorer/public/tx/e0cc4b6089b98300a7dfd230320fe5f37917a1dfd6ee034e762ccdf91d3a960b) | [`323ae892...`](https://stellar.expert/explorer/testnet/tx/323ae89254509d6a1b24b7f224476efa2f45970a13a3bba7f034d64fe1aa3f3e) |

- 📊 **Dashboard:** [Live ↗](https://nibrasd.github.io/Stellar-VRF/dashboard/)
- 🔬 **Playground:** [Live ↗](https://nibrasd.github.io/Stellar-VRF/playground/)
- 📖 **Integration Guide:** [Live ↗](https://nibrasd.github.io/Stellar-VRF/example-dapp/)

## Quick Start — JavaScript SDK

Published on npm as
[`stellar-vrf-sdk`](https://www.npmjs.com/package/stellar-vrf-sdk). Requires
**Node.js ≥ 22.12.0** (`@stellar/stellar-sdk` v17 `engines.node`).

```bash
npm install stellar-vrf-sdk @stellar/stellar-sdk
```

> ⚠ **Use SDK 2.0.0 with the current contract.** The published 1.0.x packages send a
> `context` argument to `derive_random_in_range` that the current contract (`CAW6KECQ…UPRX`)
> no longer accepts. Until 2.0.0 is on npm/crates.io, build the SDK from `sdk/js` / `sdk/rust`.
> See [docs/SDK_RELEASE.md](docs/SDK_RELEASE.md).

```typescript
import { VrfClient, Networks } from "stellar-vrf-sdk";
import { Keypair } from "@stellar/stellar-sdk";

const client = new VrfClient({
  contractId: "CAW6KECQMHRTX2GS3JVHWBMOB5JNNOHNOCE635RQS4SWJ72YF56EUPRX",
  rpcUrl:     "https://mainnet.sorobanrpc.com",
  networkPassphrase: Networks.PUBLIC,   // Networks.MAINNET is an alias
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

> ⚠ **`derive_range_for_domain`: the domain must be committed before fulfillment
> if the result is meant to be fair.** The function stays callable after `beta`
> is public. Whoever picks the domain at that point can try `A`, `B`, `C`, …
> and keep the result they like. That is grinding over the same randomness, and
> the VRF can't prevent it. Use constants in your code (`b"card-1"`, `b"card-2"`)
> or values your contract stored **before** `request()`. Never forward a
> user-chosen value there. The contract can't tell when a domain was chosen.

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
- **Economic sustainability.** The Mainnet contract charges `fee_amount = 2,000,000` stroops (0.2 XLM) per VRF request via native XLM SAC escrow (`CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA`). The escrowed fee is released to the oracle upon successful fulfillment (or refunded to the requester via `timeout_refund()` if unfulfilled after `TIMEOUT_ROUNDS`). This covers the oracle's on-chain fulfillment network fee (~0.15 XLM) and ensures sustainable operations.
- **Fulfillment is best-effort, not guaranteed.** HA, the fee guard and reconciliation make fulfillment likely, but no component guarantees it. The contract guarantees only that a result, *if* delivered, is correct and final, and that an unfulfilled request can be refunded after `TIMEOUT_ROUNDS`.
- **Consumer callbacks are isolated from panics, not from cost.** If your `on_vrf()` panics, `fulfill()` still succeeds, your callback's writes are rolled back, and a `cb_failed` event is emitted. Read the result with `get_beta()`. Soroban can't cap a sub-call's resources, though: `on_vrf()` runs inside the oracle's transaction and the oracle pays for it. An expensive callback can push `fulfill()` past network limits, and then **no** result is delivered. The worker therefore simulates every `fulfill()` and refuses to sign it if CPU, resource fee or max fee exceed configured limits. **Keep `on_vrf()` small.** Store `beta` and do the heavy work in a later transaction.
- **drand chain is fixed.** `rotate_drand_pk()` rotates the key of the *configured* drand chain. It can't migrate the contract to a different drand chain (genesis/period/scheme are fixed). See [OPERATIONS.md](docs/OPERATIONS.md#rotate-drand-public-key).
- **Results are not stored forever.** See step 5 above.
- **Audited production architecture.** The contract incorporates all security audit and fuzzing enhancements:
  - Exact uniform two-candidate rejection sampling without modulo bias.
  - Strict input binding: no derivation-time caller context (prevents grinding).
  - Atomic configuration via `__constructor` with fail-closed key validation (no separate `init()`, no front-running).
  - Accurate drand round numbering (`floor((now − genesis) / period) + 1`) enforcing `round_offset ≥ 2` (future randomness).
  - Confused-deputy callback protections enforcing `requester == callback_contract` and authorization checks.
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
