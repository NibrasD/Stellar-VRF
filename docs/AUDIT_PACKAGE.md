# Audit package contents and reproduction steps

What to include in an audit package:
- `README.md` (project overview) — already present at project root.
- `soroban-contract/src/lib.rs` — core contract logic.
- `soroban-contract/deploy.mjs` and `deployed.json` (if available).
- `artifacts/api-server/src/lib/vrfCrypto.ts` — ECVRF implementation.
- `artifacts/api-server/src/lib/sorobanSubmit.ts` — transaction assembly and signing logic.
- `artifacts/api-server/src/lib/drand.ts` — drand beacon fetching + local signature verification.
- `artifacts/api-server/test/*` — unit and integration tests.
- `artifacts/api-server/.env.example` — variables required to run tests locally.

Reproducing tests locally:
1. Copy `.env.example` to `.env` and fill required secrets (use test keys only).
2. Install dependencies: `pnpm install` (root of repo).
3. Run unit tests: `pnpm --filter @workspace/api-server test`.
4. To run integration tests: set `RUN_INTEGRATION=1` and ensure `SOROBAN_URL` and secrets are set, then run `pnpm --filter @workspace/api-server run test:integration`.
5. Build contract secure profile and capture WASM size:
   `cargo build --manifest-path soroban-contract/Cargo.toml --target wasm32-unknown-unknown --release`

To prepare a zip for external auditors locally, run:
```bash
node scripts/prepare_audit.mjs
zip -r audit_package.zip audit_package/
```
