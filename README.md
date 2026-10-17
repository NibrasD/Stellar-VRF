# Stellar VRF Oracle

A production-grade **Verifiable Random Function (VRF)** oracle for the Stellar/Soroban blockchain. Uses BLS12-381 cryptography with the [drand](https://drand.love) distributed randomness beacon to deliver publicly verifiable on-chain randomness: every result carries a proof that the contract checks on-chain before accepting it.

> **Trust model in one sentence:** the proof shows that a result matches the *currently registered* oracle and drand keys, but the oracle account can rotate those keys, so the oracle operator is a trusted party for bias resistance. Read [Trust Assumptions & Known Limitations](#trust-assumptions--known-limitations) before using this for anything of value.

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
4. The contract verifies the proof with **on-chain BLS12-381 pairing checks** (~56M CPU instructions measured on Mainnet, see [Performance](#performance))
5. The verified random output (`beta`) is written to contract storage and emitted in the `fulfill` event. `cleanup_proof()` (requester or oracle) removes only the bulky proof: the `Fulfilled` flag and the 32-byte `beta` are kept, so `get_beta()` and the `derive_*()` functions keep working. All entries are still subject to Soroban storage TTL. Read or cache your result after fulfillment (see [Storage TTL Management](docs/OPERATIONS.md#storage-ttl-management)).
6. Anyone can independently re-check the proof and the drand beacon. This confirms the result matches the registered keys; it does **not** remove the trust placed in the oracle account, which can rotate those keys (see [Trust Assumptions](#trust-assumptions--known-limitations))

## Live Deployments

| Network | Contract ID | Oracle Account | Status |
|---|---|---|---|
| **Mainnet** | [`CAW6KECQMHRTX2GS3JVHWBMOB5JNNOHNOCE635RQS4SWJ72YF56EUPRX`](https://stellar.expert/explorer/public/contract/CAW6KECQMHRTX2GS3JVHWBMOB5JNNOHNOCE635RQS4SWJ72YF56EUPRX) | [`GA6HYAVWPVOVB4XJHGUZSDHRVYOKLPU4JAHYPXZRSJWO2PM4HSCNKP5P`](https://stellar.expert/explorer/public/account/GA6HYAVWPVOVB4XJHGUZSDHRVYOKLPU4JAHYPXZRSJWO2PM4HSCNKP5P) | Active & Verified |
| **Testnet** | [`CD5K4NNYNG3ZFCET24F3SL6MSYYRD5I2BSWW5K3LFQVIKYHRY2ICVIVX`](https://stellar.expert/explorer/testnet/contract/CD5K4NNYNG3ZFCET24F3SL6MSYYRD5I2BSWW5K3LFQVIKYHRY2ICVIVX) | [`GA2WKWFHOGUCBX573A26NQAF44UFPUCB3ZS23ROKBXOUQLU7D5V62VET`](https://stellar.expert/explorer/testnet/account/GA2WKWFHOGUCBX573A26NQAF44UFPUCB3ZS23ROKBXOUQLU7D5V62VET) | Active (last verified: October 17, 2026; best-effort, see note below) |

> **Testnet Reset & Best-Effort Notice:** Stellar Testnet is periodically reset by the Stellar Development Foundation (SDF), wiping all contracts and state. When a reset occurs, the Testnet contract address will change upon redeployment. The Testnet oracle worker runs as a single isolated worker on a best-effort basis for developer testing and integration.

### On-Chain Proof of Operation

| Operation | Mainnet Explorer Link | Testnet Explorer Link (`CD5K4NNY...`) |
|---|---|---|
| **WASM Upload** | [`fe1b7f85...`](https://stellar.expert/explorer/public/tx/fe1b7f85b738bdc65620bffd9f10abbfdf7995adfbb4a7a90803c3a17c6cf41b) | [`c2e31c68...`](https://stellar.expert/explorer/testnet/tx/c2e31c6893e32cd867f41e2447d0fc0f1301d0d3dec5996dac545d37a6b47a07) |
| **Deploy & Atomic Init** | [`fccef97c...`](https://stellar.expert/explorer/public/tx/fccef97c5ec84a1a8f483aee779f925c819fab99e91edc692e56644d1089af50) | [`f96f7b19...`](https://stellar.expert/explorer/testnet/tx/f96f7b19e50aefbd24349be62dd994efd8db78be4331ba6f743e6c85cb25dd1d) |
| **Live Request #2** | [`978297f0...`](https://stellar.expert/explorer/public/tx/978297f0df8d9e6c7ec1167043127287404821758586573e97a99265aa167cae) (#1) | [`7b22374e...`](https://stellar.expert/explorer/testnet/tx/7b22374ee1e0ba3e9a1d7ff68939c3b2fcd81cd619775bb47b07002bf912e930) |
| **Live Fulfillment #2** | [`e0cc4b60...`](https://stellar.expert/explorer/public/tx/e0cc4b6089b98300a7dfd230320fe5f37917a1dfd6ee034e762ccdf91d3a960b) (#1) | [`e5a3127f...`](https://stellar.expert/explorer/testnet/tx/e5a3127fa1562b3ac746400db4bf919547361b139376a4940e3e5010b4f2a85e) |
| **Live Request #3** | [`4afc55d4...`](https://stellar.expert/explorer/public/tx/4afc55d41fc3c4afb7c2266cb210aebf641128250cc256f297b1c109ff95fc3c) (#2) | [`97d81548...`](https://stellar.expert/explorer/testnet/tx/97d8154816102415426fef65338953ae88b684427cf876ffdb2f4142a1039a1b) |
| **Live Fulfillment #3** | [`e29aad2c...`](https://stellar.expert/explorer/public/tx/e29aad2c242a22b17813b7951220f63183fae153fe027dd2f66fe352ab851bd9) (#2) | [`130e6540...`](https://stellar.expert/explorer/testnet/tx/130e6540d2c9f539f8f9577ffd53697e9076614b7bf1b9048499ae96255ae8da) |

- 📊 **Dashboard:** [Live ↗](https://nibrasd.github.io/Stellar-VRF/dashboard/)
- 🔬 **Playground:** [Live ↗](https://nibrasd.github.io/Stellar-VRF/playground/)
- 📖 **Integration Guide:** [Live ↗](https://nibrasd.github.io/Stellar-VRF/example-dapp/)

## Quick Start — JavaScript SDK

Published on npm as
[`stellar-vrf-sdk`](https://www.npmjs.com/package/stellar-vrf-sdk) (v2.0.0). Requires
**Node.js ≥ 22.12.0** (`@stellar/stellar-sdk` v17 `engines.node`).

```bash
npm install stellar-vrf-sdk @stellar/stellar-sdk
```

```typescript
import { VrfClient, Networks } from "stellar-vrf-sdk";
import { Keypair } from "@stellar/stellar-sdk";

const client = new VrfClient({
  contractId: "CAW6KECQMHRTX2GS3JVHWBMOB5JNNOHNOCE635RQS4SWJ72YF56EUPRX",
  rpcUrl:     "https://mainnet.sorobanrpc.com",
  networkPassphrase: Networks.PUBLIC,   // Networks.MAINNET is an alias
  // Server-side only: load the key from your secret store / environment.
  // Never hard-code it, and never put a secret key in a web page.
  keypair:    Keypair.fromSecret(process.env.VRF_REQUESTER_SECRET!),
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
[`stellar-vrf-sdk`](https://crates.io/crates/stellar-vrf-sdk) (v2.0.0).

> **Read/verify only.** The Rust SDK queries state (`is_fulfilled`, `get_beta`,
> `derive_random_in_range`, …), reads events and reproduces the derivations
> offline. It **cannot submit transactions** (`request()`); use the JavaScript SDK
> or the Stellar CLI for that ([details](sdk/rust/README.md#scope--read-this-first)).

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
    // To map beta_output into [0, n), use the exact-uniform derivation from
    // consumer-example (`derive_in_range`, identical to the contract's
    // derive_random_in_range). Never use `beta % n`: that is biased.
    // Keep on_vrf() cheap: the oracle
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
- **High availability** — primary + hot-standby on separate hosts with Redis leader election, failover mechanism validated in CI, and a two-host production drill on the current Mainnet contract (primary hard-killed, standby took over and fulfilled a new request) — [evidence](docs/HA_FAILOVER_EVIDENCE.md), Part C
- **Re-entrancy protection** — transient lock per request ID
- **Storage TTL extension** — automatic TTL renewal on all persistent entries

## Trust Assumptions & Known Limitations

Please read these before integrating on Mainnet. Details are in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).

- **Single oracle identity.** One oracle key (Stellar account + BLS + Ed25519) controls `fulfill()`, `rotate_oracle_keys()` and `rotate_drand_pk()`. HA removes the *availability* single point of failure, but not the *key* single point of failure. If that key is lost, the oracle can't be rotated and requests can only be refunded. **If it's stolen, or its holder misbehaves, outputs can be biased, not just withheld.** `fulfill()` verifies against the keys registered *at fulfillment time*, and the same account can switch the drand key to one it controls (`rotate_drand_pk`), which lets it choose alpha. It can also grind BLS keys once a round is public (`rotate_oracle_keys`). This affects pending requests too. **The oracle is therefore a trusted party for bias resistance and unpredictability.** Monitor `rotate_ok` / `rotate_dk` events. Multisig or a hardware signer for the oracle account is a security requirement in the threat model, and **it is not in place yet**: the Mainnet oracle account currently has a single ed25519 signer (weight 1, all thresholds 0), which anyone can check on [Horizon](https://horizon.stellar.org/accounts/GA6HYAVWPVOVB4XJHGUZSDHRVYOKLPU4JAHYPXZRSJWO2PM4HSCNKP5P). Until that changes, treat the operator as fully trusted. Per-request key snapshots and a rotation timelock would remove this. They need a redeployment and are not implemented ([details](docs/THREAT_MODEL.md#trust-assumptions)).
- **Economic sustainability.** The Mainnet contract charges `fee_amount = 2,000,000` stroops (0.2 XLM) per VRF request via native XLM SAC escrow (`CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA`). The escrowed fee is released to the oracle upon successful fulfillment (or refunded to the requester via `timeout_refund()` if unfulfilled after `TIMEOUT_ROUNDS`). This covers the oracle's on-chain fulfillment network fee (~0.15 XLM) and ensures sustainable operations.
- **Fulfillment is best-effort, not guaranteed.** HA, the fee guard and reconciliation make fulfillment likely, but no component guarantees it. The contract guarantees only that a result, *if* delivered, is correct and final, and that an unfulfilled request can be refunded after `TIMEOUT_ROUNDS`.
- **Consumer callbacks are isolated from panics, not from cost.** If your `on_vrf()` panics, `fulfill()` still succeeds, your callback's writes are rolled back, and a `cb_failed` event is emitted. Read the result with `get_beta()`. Soroban can't cap a sub-call's resources, though: `on_vrf()` runs inside the oracle's transaction and the oracle pays for it. An expensive callback can push `fulfill()` past network limits, and then **no** result is delivered. The worker therefore simulates every `fulfill()` and refuses to sign it if CPU, resource fee or max fee exceed configured limits. **Keep `on_vrf()` small.** Store `beta` and do the heavy work in a later transaction.
- **drand chain is fixed.** `rotate_drand_pk()` rotates the key of the *configured* drand chain. It can't migrate the contract to a different drand chain (genesis/period/scheme are fixed). See [OPERATIONS.md](docs/OPERATIONS.md#rotate-drand-public-key).
- **Results are not stored forever.** See step 5 above.
- **Not externally audited.** The contract has **not** had a formal third-party audit. It has been internally reviewed (including an [automated review](docs/AUDIT_REPORT.md), which is historical and not an audit of the current code), unit-tested, and fuzzed in CI (five `cargo-fuzz` targets, 10,000 runs each per change). Fixes from those reviews that are deployed on Mainnet:
  - Exact uniform two-candidate rejection sampling without modulo bias.
  - Strict input binding: no derivation-time caller context (prevents grinding).
  - Atomic configuration via `__constructor` with fail-closed key validation (no separate `init()`, no front-running).
  - Accurate drand round numbering (`floor((now − genesis) / period) + 1`) enforcing `round_offset ≥ 2` (future randomness).
  - Confused-deputy callback protections enforcing `requester == callback_contract` and authorization checks.
- **"Can't bias" / "tamper-proof" are conditional.** With the registered keys unchanged, the oracle can neither predict nor bias an output. The oracle account *can* rotate keys (see "Single oracle identity" above), and anything a caller chooses **after** seeing `beta` (for example a domain passed to `derive_range_for_domain`) can be ground by that caller. The contract only binds inputs committed before the drand round is public.
- **SDK scope.** The Rust SDK is a read/verify client. It doesn't submit transactions ([details](sdk/rust/README.md#scope--read-this-first)). The JavaScript SDK requires **Node.js ≥ 22.12.0**.
- **Web pages never ask for a secret key on Mainnet.** The Playground and the Integration Guide demo sign Mainnet transactions only through the [Freighter](https://www.freighter.app/) wallet. Pasting a secret key is limited to Testnet, for throwaway accounts.

## Performance

`fulfill()` **without a callback** consumed **56,040,632 CPU instructions** on live Stellar Mainnet (TX [`e0cc4b60…`](https://stellar.expert/explorer/public/tx/e0cc4b6089b98300a7dfd230320fe5f37917a1dfd6ee034e762ccdf91d3a960b)).
The Soroban VM allocates a larger *envelope limit* for that transaction (`58,342,003` instructions), which is the upper bound the validator reserves — not what was actually consumed.
That is 25% headroom under the 75M project target and 86% under the 400M network protocol limit.
See [`docs/PROFILING.md`](docs/PROFILING.md) for the full breakdown.

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
