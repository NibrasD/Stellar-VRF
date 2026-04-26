# Technical Architecture — Soroban VRF Oracle

---

## Overview

The system is a three-layer stack: a React dashboard for user interaction, a Fastify API that runs the cryptographic core and coordinates with external networks, and a Rust smart contract deployed to Stellar Testnet that serves as the tamper-proof ledger of record.

```
┌─────────────────────────────────────────────────────┐
│  Browser (React + Vite)                             │
│  Dashboard · Requests · Proofs · Verify             │
└────────────────────┬────────────────────────────────┘
                     │ HTTP / JSON
┌────────────────────▼────────────────────────────────┐
│  API Server (Fastify, Node.js)                      │
│  vrfCrypto.ts · sorobanSubmit.ts · drand.ts         │
│  Drizzle ORM → PostgreSQL                           │
└──────┬────────────────────┬───────────────────────┬─┘
       │                    │                       │
  drand quicknet      Stellar RPC             Horizon API
  (League of          (Soroban               (ledger data,
   Entropy)           Testnet)                explorer links)
                           │
              ┌────────────▼────────────┐
              │  Soroban Contract       │
              │  (Rust, wasm32)         │
              │  CBCFEQBSOQK6SH...      │
              └─────────────────────────┘
```

---

## Monorepo Layout

The project is a pnpm workspace. Three packages ship independently:

| Package | Path | Role |
|---|---|---|
| `@workspace/soroban-vrf` | `artifacts/soroban-vrf/` | React/Vite dashboard |
| `@workspace/api-server` | `artifacts/api-server/` | Fastify REST API |
| `@workspace/db` | `lib/db/` | Drizzle schema, shared types |

The Rust contract lives outside the Node.js workspace in `soroban-contract/` and is built separately.

---

## Cryptographic Layer

**File:** `artifacts/api-server/src/lib/vrfCrypto.ts`

Suite: **ECVRF-SECP256K1-SHA256-TAI** per IRTF CFRG draft-irtf-cfrg-vrf-15.

Dependencies: `@noble/curves` v2 (real EC arithmetic, no wrappers), `@noble/hashes` (SHA-256).

### Key Generation

The oracle key is a fixed secp256k1 scalar for testnet reproducibility:

```
private key:  c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721
public key:   032c8c31fc9f990c6b55e3865a184a4ce50e09481f2eaeb3e60ec1cea13a6ae645
```

For production this would be held in an HSM. The public key is stored on-chain in the Soroban contract at `init()` time so any verifier can retrieve it trustlessly.

### Proof Generation

```
hashToCurve(alpha):
  counter = 0
  loop:
    H = SHA256(suite_string ‖ 0x01 ‖ PK ‖ alpha ‖ counter)
    try to lift H as x-coordinate on secp256k1  ← Try-and-Increment
    if valid: return point

generateProof(alpha):
  H = hashToCurve(alpha)
  Γ = x · H                         // scalar mult with private key x
  k = RFC6979_nonce(x, H)           // deterministic nonce
  U = k · G
  V = k · H
  c = SHA256(PK ‖ H ‖ Γ ‖ U ‖ V)[0:16]  // 16-byte challenge
  s = (k + c·x) mod n                  // additive variant
  β = SHA256(0xFE ‖ 0x03 ‖ Γ)      // random output
```

Note: this uses the additive variant (`s = k + c·x`). Verification
reconstructs `U’ = s·G − c·PK` which equals `k·G` because
`s·G − c·PK = (k+cx)·G − c·(xG) = k·G`. The math is equivalent — just a
different convention from the subtractive variant in the IRTF draft.

### Proof Verification (6 steps)

```
1. assertValidity(PK)
2. Γ = deserialize(proof.gammaPoint); assertValidity(Γ)
3. H = hashToCurve(alpha)
4. U′ = s·G − c·PK          // = (k+cx)G − c(xG) = kG
   V′ = s·H − c·Γ          // = (k+cx)H − c(xH) = kH
5. c′ = SHA256(PK ‖ H ‖ Γ ‖ U′ ‖ V′)[0:16]
   assert c′ == c
6. β = SHA256(0xFE ‖ 0x03 ‖ Γ)
```

No oracle private key is involved in verification. The output is uniquely determined by the input and the oracle's public key.

---

## Randomness Beacon (drand)

**File:** `artifacts/api-server/src/lib/drand.ts`

The oracle uses drand quicknet as the alpha seed source.

| Property | Value |
|---|---|
| Chain hash | `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971` |
| Scheme | Threshold BLS (BLS12-381 G2) |
| Period | 3 seconds |
| Operators | Cloudflare, EPFL, Protocol Labs, cLabs, Emerald Onion, others |

The API fetches the latest round directly from `https://api.drand.sh/{chainHash}/public/latest`. The dashboard links each round number to `https://api.drand.sh/{chainHash}/public/{round}` so anyone can fetch the raw beacon JSON with no intermediary.

Why drand matters: a commit-reveal scheme (block hash, etc.) lets the requester see the seed before committing. drand's output is a threshold BLS signature — no single party knows it until the signature is assembled from the quorum, making pre-computation impossible.

---

## Soroban Smart Contract

**File:** `soroban-contract/src/lib.rs`  
**Contract ID:** `CDSKLSIMDWMM5PVWCHXMUNN5H5VMSAN2PQNTVENKUBNDOCWL37IDJUJD`

Written in Rust with `soroban-sdk v20.0.0`, compiled to `wasm32-unknown-unknown` (42.5 KB WASM with ECVRF verification). `#![no_std]` — no heap allocator, no OS dependencies.

### Data Structures

```rust
#[contracttype]
pub struct EcvrfProof {
    pub alpha_seed:  Bytes,       // UTF-8 input seed
    pub gamma_point: BytesN<33>,  // compressed secp256k1 point
    pub c_scalar:    BytesN<16>,  // 16-byte challenge
    pub s_scalar:    BytesN<32>,  // 32-byte response
    pub beta_output: BytesN<32>,  // SHA-256 random output
    pub public_key:  BytesN<33>,  // compressed oracle PK
}

#[contracttype]
pub struct VrfRequest {
    pub alpha_seed:  Bytes,
    pub requester:   String,
    pub fulfilled:   bool,
    pub proof:       Option<EcvrfProof>,
}
```

Storage uses `Persistent` storage keyed on `DataKey::Request(u64)` and `DataKey::Proof(u64)`. The oracle’s public key and Stellar address are held in `Instance` storage, set once at `init()`.

### Security Model

The `fulfill()` function enforces seven on-chain security checks:

1. **Access Control** — `oracle.require_auth()` verifies the Stellar Ed25519 signature, ensuring only the registered oracle can submit proofs.
2. **Oracle Address Match** — The caller's address must equal the `OracleAddr` stored at init time.
3. **Double-Fulfillment Prevention** — A request can only be fulfilled once.
4. **Public Key Integrity** — `proof.public_key` must match the stored oracle public key. Prevents key-substitution attacks.
5. **Ed25519 Proof Signature** — The proof data is signed by the oracle's Ed25519 key and verified on-chain via `env.crypto().ed25519_verify()`.
6. **Alpha Seed Integrity** — `proof.alpha_seed` must match the original request seed stored on-chain. Prevents oracle from swapping the seed post-request.
7. **On-Chain ECVRF Verification** — Full secp256k1 EC arithmetic (via `k256` crate) verifies the VRF proof cryptographically: `hashToCurve → U'=s·G−c·PK → V'=s·H−c·Γ → c'==c`. Feature-gated under `ecvrf`.

### Contract Functions

| Function | Visibility | Description |
|---|---|---|
| `init(oracle_addr, oracle_pk)` | Public | Set oracle address and PK; panics if already set |
| `request(alpha_seed, requester) → u64` | Public | Record a new request; return its ID |
| `fulfill(oracle, request_id, proof)` | Auth | Attach a proof; 5 security checks enforced |
| `derive_random(request_id, context) → u64` | Public | Deterministic random from fulfilled proof |
| `get_proof(id)` | Public | Read a stored request |
| `is_fulfilled(id)` | Public | Check fulfillment status |
| `oracle_pk()` | Public | Return the stored oracle public key |
| `oracle_addr()` | Public | Return the stored oracle Stellar address |

### Deployment

```bash
# Build
cargo build --target wasm32-unknown-unknown --release

# Deploy (node deploy.mjs)
#   1. soroban contract upload → WASM hash
#   2. soroban contract create → contract ID
#   3. invoke init(oracle_addr=GARP..., oracle_pk=032c8c31...)
```

Deploy script uses `@stellar/stellar-sdk` v15, `rpc.Server`, and `rpc.assembleTransaction`. Results written to `soroban-contract/deployed.json`.

---

## On-Chain Submission Flow

**File:** `artifacts/api-server/src/lib/sorobanSubmit.ts`

Submissions run in the background (fire-and-forget after the API responds) so the HTTP request is not blocked by 5–10 second Stellar finality.

```
POST /api/vrf-requests
  └─ insert DB row (requestId)
  └─ respond 201
  └─ [background] sorobanRequest(alphaSeed, requester)
       ├─ ensureFunded() — check oracle Stellar account via getAccount()
       ├─ build Tx: invokeContractFunction("request", [alpha, requester])
       ├─ simulateTransaction() → resource footprint
       ├─ assembleTransaction() → signed prepared Tx
       ├─ sendTransaction() → hash
       ├─ pollTx(hash) — getTransaction() every 2s, up to 60s
       └─ update DB: contractRequestId, requestTxHash

POST /api/vrf-requests/:id/fulfill
  └─ generateEcvrfProof(alphaSeed)
  └─ insert proof row
  └─ respond 200
  └─ [background] sorobanFulfill(contractRequestId, proof)
       ├─ compress gamma: 04||x||y (65B) → 02/03||x (33B)
       ├─ build Tx: invokeContractFunction("fulfill", [id, EcvrfProofMap])
       ├─ simulate → assemble → sign → send
       ├─ pollTx(hash)
       └─ update DB: fulfillTxHash, onChainExplorerUrl
```

The gamma compression step is critical — the database stores gamma as a 65-byte uncompressed point for use in off-chain EC arithmetic, but the Soroban contract declares `gamma_point: BytesN<33>` (compressed). Compression uses the parity of the y-coordinate's last byte: even → `0x02` prefix, odd → `0x03` prefix.

---

## API Routes

| Method | Path | Description |
|---|---|---|
| GET | `/api/stats/dashboard` | Aggregate counters |
| GET | `/api/drand/latest` | Live drand beacon |
| GET | `/api/stellar/network` | Horizon ledger data |
| POST | `/api/vrf-requests` | Create request |
| GET | `/api/vrf-requests` | List all requests |
| GET | `/api/vrf-requests/:id` | Single request |
| POST | `/api/vrf-requests/:id/fulfill` | Generate proof + submit |
| GET | `/api/vrf-proofs` | List all proofs |
| GET | `/api/vrf-proofs/:id` | Single proof |
| POST | `/api/vrf-proofs/:id/verify` | Run 6-step ECVRF verification |

---

## Database Schema

PostgreSQL via Drizzle ORM. Two core tables:

```sql
vrf_requests (
  id                serial PRIMARY KEY,
  alpha_seed        text NOT NULL,
  requester_address text NOT NULL,
  status            text DEFAULT 'pending',
  random_output     text,
  contract_address  text,
  gas_estimate      integer,
  contract_request_id integer,
  request_tx_hash   text,
  fulfill_tx_hash   text,
  on_chain_explorer_url text,
  created_at        timestamptz DEFAULT now(),
  fulfilled_at      timestamptz
)

vrf_proofs (
  id                    serial PRIMARY KEY,
  request_id            integer REFERENCES vrf_requests(id),
  gamma_point           text NOT NULL,    -- uncompressed hex (65 bytes)
  challenge_scalar      text NOT NULL,    -- 32 hex chars (16 bytes)
  response_scalar       text NOT NULL,    -- 64 hex chars (32 bytes)
  public_key            text NOT NULL,    -- compressed hex (33 bytes)
  proof_bytes           text NOT NULL,    -- serialized proof
  random_output         text NOT NULL,    -- β = SHA256(0xFE||0x03||Γ)
  verification_status   text DEFAULT 'unverified',
  gas_used              integer,
  block_time            integer,
  fulfill_tx_hash       text,
  on_chain_explorer_url text,
  created_at            timestamptz DEFAULT now()
)
```

---

## Frontend Architecture

React 18 + Vite, TypeScript, shadcn/ui components, TailwindCSS. Single-page app with React Router.

| Route | Component | Data source |
|---|---|---|
| `/` | Dashboard | drand, Horizon, PostgreSQL stats |
| `/requests` | Request list | `/api/vrf-requests` |
| `/requests/:id` | Request detail | `/api/vrf-requests/:id` |
| `/proofs` | Proof list | `/api/vrf-proofs` |
| `/verify/:id` | Proof verifier | `/api/vrf-proofs/:id` + ECVRF verify |

The dashboard auto-refreshes drand every 3s and Horizon every 10s. The drand "Verify raw JSON" link opens `https://api.drand.sh/{chain}/public/{round}` directly in a new tab — the user sees the raw beacon, no intermediary. Every Stellar ledger row links to `stellar.expert`.

---

## External Dependencies of Note

| Library | Version | Purpose |
|---|---|---|
| `@noble/curves` | 2.x | secp256k1 EC arithmetic (hashToCurve, point ops) |
| `@noble/hashes` | 1.x | SHA-256 |
| `@stellar/stellar-sdk` | 15.x | Soroban RPC, transaction building, XDR encoding |
| `drizzle-orm` | 0.x | Type-safe SQL queries |
| `fastify` | 4.x | HTTP server |
| `soroban-sdk` | 20.0.0 | Rust contract SDK |
| `k256` | 0.13 | secp256k1 EC arithmetic for on-chain ECVRF verification |
| `sha2` | 0.10 | SHA-256 for on-chain hash-to-curve and challenge recomputation |

---

## Production Considerations

The current deployment is testnet-only. Moving to Mainnet requires:

1. **Oracle private key** — move out of source code into an HSM or KMS. The `keyManager` module already supports AWS KMS, env vars, and remote signer delegation.
2. **Stellar gas account** — fund a real account with XLM. Remove Friendbot dependency.
3. **drand chain** — quicknet is appropriate for production (3s period, large quorum).
4. **Contract redeployment** — upload WASM to Mainnet, call `init()` with the production oracle address and PK.
5. **drand beacon verification** — local `sha256(sig)==randomness` verification is implemented; upgrade to full BLS12-381 pairing verification for maximum security.
6. **Rate limiting** — in-memory rate limiter is active; for multi-instance deployments, swap to Redis-backed rate limiting.
