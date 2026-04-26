KMS and Secrets - Setup Guide
==============================

This document explains how to configure key management and repository secrets for production.

Supported approaches
- Local env (testing only): `ORACLE_STELLAR_SEED`, `VRF_PRIVATE_KEY_HEX`, `ORACLE_VRF_PRIVATE_KEYS` in `artifacts/api-server/.env`.
- AWS KMS + Secrets Manager (recommended for production): configure KMS key for signing and store VRF private key in Secrets Manager.

Environment variables used by the project
- `VRF_PRIVATE_KEY_HEX` — secp256k1 VRF private key (hex). Used by `@workspace/api-server` for local signing.
- `ORACLE_VRF_PRIVATE_KEYS` — comma-separated VRF private keys used by integration tests.
- `ORACLE_STELLAR_SEED` — single Stellar secret seed (Ed25519) for local testing.
- `ORACLE_STELLAR_SEEDS` — comma-separated Stellar secret seeds for each oracle (recommended for tests/deploys).
- `KMS_PROVIDER` — set to `aws` to enable AWS KMS paths in `keyManager.ts`.
- `KMS_AWS_KEY_ID` — KMS key id (for signing public keys retrieval).
- `KMS_AWS_VRF_KEY_ID` — KMS asymmetric key id (if using KMS for VRF public key retrieval).
- `KMS_AWS_VRF_SECRET_ARN` — Secrets Manager ARN containing VRF private key (hex).

AWS KMS / Secrets Manager minimal IAM policy (example)
---------------------------------------------------

Attach a policy to the CI/deploy role that allows use of the KMS key and read of the secrets:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "kms:Sign",
        "kms:GetPublicKey"
      ],
      "Resource": "arn:aws:kms:REGION:ACCOUNT_ID:key/YOUR_KEY_ID"
    },
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue"
      ],
      "Resource": "arn:aws:secretsmanager:REGION:ACCOUNT_ID:secret:YOUR_SECRET_NAME-*"
    }
  ]
}
```

GitHub Actions secrets (what to set)
- `VRF_PRIVATE_KEY_HEX` — (optional) VRF hex for local signing
- `ORACLE_VRF_PRIVATE_KEYS` — comma-separated VRF private keys (integration)
- `ORACLE_STELLAR_SEEDS` — comma-separated Stellar secret seeds used in tests/deploy
- `ORACLE_STELLAR_SEED` — single fallback seed
- `RUN_INTEGRATION` — set to `1` to allow CI to run integration job
- `SOROBAN_URL`, `SOROBAN_NETWORK`, `FRIEND_BOT_URL` — overrides for integration job

Notes
- Do NOT commit secret values to source. Use CI/CD secrets and provider-managed KMS.
- For production, prefer delegating signing to a remote signer/HSM and set `REQUIRE_REMOTE_SIGNER=1`.
