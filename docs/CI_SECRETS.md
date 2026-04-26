# CI Secrets and Environment

This file lists the secrets the CI expects for full end-to-end testing and secure operation.

Recommended GitHub Secrets (names)
- `VRF_PRIVATE_KEY_HEX` — secp256k1 private key (hex) used by `vrfCrypto` for tests.
- `ORACLE_STELLAR_SEED` — Stellar secret seed (Ed25519) used for signing fulfill transactions.
- `RUN_INTEGRATION` — set to `1` to enable integration tests in CI. (Default: unset)
- `RUN_PROPERTY_TESTS` — set to `1` to enable property tests in CI. (Default: unset)

KMS / Signer variables
- `KMS_PROVIDER` — set to `aws` to use AWS KMS/Secrets Manager integration via `keyManager`.
- `KMS_AWS_KEY_ID` — AWS KMS KeyId (for Ed25519 signing of proof messages).
- `KMS_AWS_VRF_KEY_ID` — (optional) AWS KMS asymmetric key id that holds the VRF public key (GetPublicKey). Use only if your provider supports secp256k1.
- `KMS_AWS_VRF_SECRET_ARN` — (optional) Secrets Manager ARN containing `VRF_PRIVATE_KEY_HEX` for signer hosts.
- `AWS_REGION` — AWS region for the KMS/Secrets Manager client.
- `VRF_SIGNER_URL` — external signer service URL (PoC: `http://host:6060/generateProof`) used when VRF proof generation is delegated.
- `VRF_SIGNER_API_KEY` — API key for the external signer (if enabled).

Notes:
- Prefer using cloud KMS or GitHub OIDC (workload identity) to grant CI runners short-lived access to KMS instead of storing AWS credentials directly in secrets.
- For CI that performs integration tests requiring KMS, set `RUN_INTEGRATION=1` and provide the required KMS variables as GitHub secrets; ensure permissions are narrowly scoped.

Notes:
- Do NOT store secrets in the repository or `.env` files. Use GitHub Secrets or a KMS.
- Rotate secrets periodically and follow the runbook steps to replace keys safely.
