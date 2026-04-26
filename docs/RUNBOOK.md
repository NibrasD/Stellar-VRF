# Runbook (quick operations)

This runbook contains short operational procedures for common emergency and maintenance tasks.

1) Rotate oracle secrets (high level)
   - Remove the current secret from the secret store (or mark rotated).
   - Provision new `VRF_PRIVATE_KEY_HEX` and `ORACLE_STELLAR_SEED` in CI secrets or KMS.
   - Update contract-stored oracle public key if you change the VRF key (requires redeploy/init).

2) Recover from failed fulfill transactions
   - Inspect the transaction using Soroban RPC and `server.getTransaction(txHash)`.
   - If the contract rejected the proof due to `oracle key mismatch`, ensure the private key used off-chain matches `oracle_pk` on-chain.
   - If request status is `proof_generated` or `onchain_submitted` for too long, retry the submit worker idempotently and ensure `finalAlphaSeed` matches the request row.

3) On-chain integration in CI
   - Integration tests run in a dedicated CI environment (non-PR events) and are expected to pass continuously.
   - Required secrets must be present; pipeline fails explicitly if any required secret is missing.

4) Prepare audit package
   - Run `node scripts/prepare_audit.mjs` to collect key files into `audit_package/` for distribution to auditors.

5) Production entropy policy
   - Set `DRAND_REQUIRED=1` in production.
   - Reject non-`drand:` alpha seeds when `DRAND_REQUIRED=1`.
   - Treat any failed drand signature verification as hard failure.

6) Production signer policy
   - Set `REQUIRE_REMOTE_SIGNER=1` in production.
   - Ensure `ORACLE_SIGNER_URL` is configured and reachable before rollout.
   - In strict mode, remote signer failures must fail closed (no local-key fallback).
