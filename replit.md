# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Artifacts

### Soroban VRF Dashboard (`artifacts/soroban-vrf`)
- **Purpose**: Production-quality full-stack VRF oracle dashboard for Soroban/Stellar — 100% real cryptography
- **Preview path**: `/`
- **Framework**: React + Vite
- **Pages**:
  - `/` — Dashboard: stats, drand live beacon, Stellar Testnet data, randomness chart, activity log
  - `/requests` — VRF Requests list; New Request dialog has "Seed from drand" button
  - `/requests/:id` — Request detail with proof and "Verify Proof" action
  - `/proofs` — All ECVRF proofs with verification status
  - `/verify/:id` — Step-by-step 6-check ECVRF verification

### API Server (`artifacts/api-server`)
- **Purpose**: Express 5 API server with real ECVRF, live Stellar Horizon, and drand integration
- **Preview path**: `/api`
- **Routes**:
  - `GET/POST /api/vrf-requests` — List and create VRF requests
  - `GET /api/vrf-requests/:id` — Get request detail with proof
  - `POST /api/vrf-requests/:id/fulfill` — Generate REAL ECVRF-SECP256K1-SHA256-TAI proof
  - `GET /api/vrf-proofs` — List all proofs
  - `POST /api/vrf-proofs/:id/verify` — Real 6-step EC arithmetic verification
  - `GET /api/stats/dashboard` — Aggregate stats
  - `GET /api/stats/randomness-distribution` — Hex distribution data
  - `GET /api/stats/recent-activity` — Activity log feed
  - `GET /api/stellar/network` — Live Stellar Testnet ledger data from Horizon
  - `GET /api/drand/latest?chain=quicknet|default` — Live drand beacon (League of Entropy)
  - `GET /api/drand/round/:round?chain=...` — Specific drand round

## Database Schema

- **vrf_requests** — VRF randomness requests (id, alpha_seed, requester_address, status, random_output, contract_address, gas_estimate, created_at, fulfilled_at)
- **vrf_proofs** — ECVRF proof records (id, request_id, gamma_point, challenge_scalar, response_scalar, public_key, proof_bytes, verification_status, verification_steps, computed_at)
- **activity_log** — Event audit trail (id, type, description, request_id, proof_id, timestamp)

## VRF Cryptography

Real ECVRF-SECP256K1-SHA256-TAI (`artifacts/api-server/src/lib/vrfCrypto.ts`):
- Suite: ECVRF-SECP256K1-SHA256-TAI per draft-irtf-cfrg-vrf-15
- Library: `@noble/curves` v2 secp256k1 + `@noble/hashes` sha2 (NO mocks or simulations)
- Private key: fixed deterministic oracle key `c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721`
- `generateEcvrfProof(alphaSeed)` — hash_to_try_and_increment → Γ=xH → k nonce → c challenge → s response
- `verifyEcvrfProof(proof, alphaSeed)` — 6 real EC arithmetic checks: PK valid, Γ valid, H=hashToCurve, U'=sG−cPK, V'=sH−cΓ, c'==c

## Soroban Contract Deployment

**Contract: `CB2T6ZARCT2L6BIKTSIOJLPBSY4HY2Z6VKWPW3N6XEMJDJXASKGPG77Q`** (Stellar Testnet, deployed 2026-04-03)
- Explorer: https://stellar.expert/explorer/testnet/contract/CB2T6ZARCT2L6BIKTSIOJLPBSY4HY2Z6VKWPW3N6XEMJDJXASKGPG77Q
- WASM hash: `df23d973258f9376f28249c70d3c17b72761dd54c6b0bca0f58b90dffc5857b4` (soroban_vrf_oracle.wasm, 4.4 KB)
- Deployer: `GCKLQ7EWMZTCLD4VKSZLN4NYEYE7TX3FATAYSBSROTTCVPG2DW3KZ6MQ` (funded via Friendbot)
- Build: `soroban-contract/` → Rust `#[no_std]` with `soroban-sdk v20.5`, compiled to wasm32-unknown-unknown, Rust 1.88 via rustup
- Contract functions: `init(oracle_pk)`, `request(alpha_seed, requester) → u64`, `fulfill(request_id, EcvrfProof)`, `get_proof(id)`, `is_fulfilled(id)`, `oracle_pk()`
- Deploy script: `node soroban-contract/deploy.mjs`
- Deployment result saved in `soroban-contract/deployed.json`

On fulfill: `sorobanRequest()` runs in background → stores `contractRequestId` + `requestTxHash`; `sorobanFulfill()` runs in background → stores `fulfillTxHash` + `onChainExplorerUrl` in vrf_proofs

## drand Integration

`artifacts/api-server/src/lib/drand.ts` connects to the League of Entropy drand network:
- **Chains**: quicknet (BLS12-381 G2, 3s period) and default (BLS12-381 G1, 30s period)
- **Why**: Threshold BLS signatures from Cloudflare, EPFL, Protocol Labs etc. — no single operator can bias output
- **Solves NebulaVRF problem**: commit-reveal lets operator pre-select seed; drand prevents oracle from predicting alpha seed
- `suggestedAlphaSeed` embeds chain hash + round + randomness hex for ready-to-use trustless VRF seeding

## Key Library Notes

- `@noble/curves` v2 uses `.js` subpath exports: `secp256k1.js`, `utils.js`
- `@noble/hashes` v2 uses `sha2.js` (not `sha256.js`)
- Both must be externalized in `build.mjs` so Node resolves them natively at runtime
- `secp256k1.Point.Fn.ORDER` = curve order n (v2 API; v1 used `secp256k1.CURVE.n`)
- `point.toBytes(false)` = uncompressed 65 bytes (v2 API; v1 used `toRawBytes`)
