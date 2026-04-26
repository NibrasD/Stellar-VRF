# Soroban VRF Oracle

A production-grade Verifiable Random Function (VRF) oracle running on Stellar Testnet. Every random output is cryptographically provable, sourced from a live randomness beacon, and permanently recorded on a deployed Soroban smart contract.

---

## What This Is

Traditional on-chain randomness is easy to manipulate — a miner or validator who sees the input can cherry-pick a favorable block hash. This oracle solves the problem by combining three independent, publicly auditable components:

**ECVRF (Elliptic Curve VRF)** — The oracle holds a secp256k1 private key. For each request it produces a proof `(Γ, c, s)` alongside the random output `β`. Anyone with the oracle's public key can verify that `β` was derived deterministically from the input seed without the oracle having any choice in the outcome.

**drand (League of Entropy)** — The alpha seed fed into the VRF comes from drand's quicknet beacon (BLS12-381, 3-second period), operated collectively by Cloudflare, EPFL, Protocol Labs and others. No single operator controls the beacon output, making pre-computation attacks impossible.

**Soroban smart contract** — Every request and fulfillment is submitted as a real transaction to the deployed VRF Oracle contract on Stellar Testnet. The contract stores the proof on-chain and verifies the oracle's secp256k1 public key matches the one it was initialized with.

---

## Live Deployment

| Component | Value |
|---|---|
| Contract | `CDSKLSIMDWMM5PVWCHXMUNN5H5VMSAN2PQNTVENKUBNDOCWL37IDJUJD` |
| Network | Stellar Testnet |
| WASM hash | `adda467acaf12fcdca939261944f152660da394ef26472273871b83e3fe2ae5a` |
| Oracle public key | `032c8c31fc9f990c6b55e3865a184a4ce50e09481f2eaeb3e60ec1cea13a6ae645` |
| drand chain | quicknet · 3s period · BLS12-381 G2 |
| Deployed | 2026-04-26 |

Explorer links:
- Contract: https://stellar.expert/explorer/testnet/contract/CDSKLSIMDWMM5PVWCHXMUNN5H5VMSAN2PQNTVENKUBNDOCWL37IDJUJD
- Oracle gas account: https://stellar.expert/explorer/testnet/account/GARPMPBJ5H43UNYHLIC46MSYRDGF4ZNKUYTZYDYVW5S2TUORAMBZRAMI

---

## Repository Structure

```
/
├── artifacts/
│   ├── soroban-vrf/          # React + Vite dashboard
│   └── api-server/           # Fastify REST API
├── soroban-contract/
│   ├── src/lib.rs            # Rust/Soroban VRF Oracle contract
│   ├── deploy.mjs            # Deployment script
│   └── deployed.json         # Deployment record
└── lib/
    └── db/                   # Drizzle schema (shared)
```

---

## Running Locally

Requires Node.js 20+ and pnpm.

```bash
pnpm install
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/soroban-vrf run dev
```

The API server listens on port 8080. The dashboard connects to it automatically.

### Rebuilding the Soroban contract

Requires Rust with the `wasm32-unknown-unknown` target and Rust 1.88+ via rustup.

```bash
cd soroban-contract
RUSTUP_TOOLCHAIN=1.88 \
  LD_LIBRARY_PATH=~/.rustup/toolchains/1.88-x86_64-unknown-linux-gnu/lib \
  cargo build --target wasm32-unknown-unknown --release

node deploy.mjs   # deploys to Stellar Testnet and writes deployed.json
```

---

## How a Request Works

1. The dashboard fetches the current drand quicknet round and suggests its output as the alpha seed.
2. A POST to `/api/vrf-requests` records the request in the database and immediately fires a background call to the Soroban contract's `request()` function, storing the returned contract request ID and the Stellar transaction hash.
3. The oracle fulfills the request by running `generateEcvrfProof(alphaSeed)`:
   - `H = hashToCurve(alphaSeed)` — Try-and-Increment into secp256k1
   - `Γ = x · H` (scalar multiplication with the oracle private key)
   - `k` — deterministic nonce per RFC 6979
   - `c = Hash(PK, H, Γ, U, V)` — 16-byte challenge
   - `s = (k + c·x) mod n` — response scalar (additive variant)
   - `β = SHA256(0xFE ‖ 0x03 ‖ Γ)` — final random output
4. The proof is submitted to the contract's `fulfill()` function, which enforces 5 security checks:
   - **Access control**: only the registered oracle address can submit (via `require_auth`)
   - **Public key integrity**: `proof.public_key` must match the stored oracle PK
   - **Alpha seed integrity**: `proof.alpha_seed` must match the original request seed
   - **Double-fulfillment prevention**: each request can only be fulfilled once
5. Independent verification runs all six ECVRF checks using only the oracle's public key — no trust required.
6. Other contracts can call `derive_random(request_id, context)` to get a deterministic `u64` from any fulfilled proof.

---

## Verification

Any proof can be verified independently using only the oracle's public key (`032c8c31...`), the original alpha seed, and the proof bytes `(Γ, c, s)`. The verification steps are:

1. Assert PK is a valid secp256k1 point
2. Deserialize and validate Γ
3. Recompute H from the alpha seed via hashToCurve
4. Compute U′ = s·G − c·PK and V′ = s·H − c·Γ
5. Recompute c′ = Hash(PK, H, Γ, U′, V′) and check c′ == c
6. Derive β = SHA256(0xFE ‖ 0x03 ‖ Γ)

The dashboard runs these steps in the browser with real EC arithmetic (@noble/curves v2) and shows each step's result in the Verification Execution Trace panel.

---

## Environment

The API server needs a PostgreSQL `DATABASE_URL`. On Replit this is provisioned automatically. No other secrets are required — the oracle private key and Stellar gas account seed are embedded for testnet use.

For production: move both keys to an HSM or secret manager, replace the Friendbot funding with a real funded account, and redeploy the contract to Stellar Mainnet.
