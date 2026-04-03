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
- **Purpose**: Full-stack web app for demonstrating and simulating Soroban Verifiable Random Function (VRF) workflows
- **Preview path**: `/`
- **Framework**: React + Vite
- **Pages**:
  - `/` — Dashboard: aggregate stats, randomness distribution chart, recent activity
  - `/requests` — VRF Requests list with create form and fulfill action
  - `/requests/:id` — Request detail with proof components
  - `/proofs` — All ECVRF proofs with verification status
  - `/verify/:id` — Step-by-step on-chain verification simulator

### API Server (`artifacts/api-server`)
- **Purpose**: Express 5 API server implementing the VRF contract
- **Preview path**: `/api`
- **Routes**:
  - `GET/POST /api/vrf-requests` — List and create VRF requests
  - `GET /api/vrf-requests/:id` — Get request detail with proof
  - `POST /api/vrf-requests/:id/fulfill` — Generate ECVRF proof and fulfill request
  - `GET /api/vrf-proofs` — List all proofs
  - `POST /api/vrf-proofs/:id/verify` — Run on-chain verification simulation
  - `GET /api/stats/dashboard` — Aggregate stats
  - `GET /api/stats/randomness-distribution` — Hex distribution data
  - `GET /api/stats/recent-activity` — Activity log feed

## Database Schema

- **vrf_requests** — VRF randomness requests (id, alpha_seed, requester_address, status, random_output, contract_address, gas_estimate, created_at, fulfilled_at)
- **vrf_proofs** — ECVRF proof records (id, request_id, gamma_point, challenge_scalar, response_scalar, public_key, proof_bytes, verification_status, verification_steps, computed_at)
- **activity_log** — Event audit trail (id, type, description, request_id, proof_id, timestamp)

## VRF Cryptography

The `artifacts/api-server/src/lib/vrfCrypto.ts` module simulates ECVRF-P256-SHA256-TAI:
- `generateEcvrfProof(alphaSeed)` — Generates gamma point, challenge scalar, response scalar, and random output
- `verifyEcvrfProof(proof, alphaSeed)` — Runs 6-step on-chain verification simulation
