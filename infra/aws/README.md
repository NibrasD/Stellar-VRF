# AWS KMS + Secrets Manager (Terraform) — helper

Prerequisites
- Terraform installed and on PATH
- AWS credentials available (CLI config or environment) or an OIDC role
- `gh` (GitHub CLI) if you want to upload outputs to GitHub secrets
- `VRF_PRIVATE_KEY_HEX` value (hex-encoded secp256k1 private key)

Quick steps

1. Provision KMS + Secrets (interactive)

```bash
export VRF_PRIVATE_KEY_HEX=<hex>
cd infra/aws
./provision_kms.sh
```

Or non-interactive:

```bash
export VRF_PRIVATE_KEY_HEX=<hex>
./provision_kms.sh --auto-approve
```

2. (Optional) Upload outputs to GitHub secrets using `gh`:

```bash
export GITHUB_REPOSITORY=owner/repo
# set required env vars before running the script (see below)
./scripts/ci/set_github_secrets.sh
```

Notes
- The Terraform example creates an ECC_ED25519 KMS key and a Secrets Manager secret named `vrf/private/vrf_private_key_hex`.
- Review `infra/aws/terraform_kms_secrets.tf` before applying in production.
- The helper scripts do not store secrets in the repo — they read from environment variables or prompt interactively.

Security
- Prefer using an OIDC role for CI rather than long-lived AWS keys.
- Limit IAM permissions to `kms:Sign`, `kms:GetPublicKey`, `secretsmanager:GetSecretValue`, and Terraform-managed resource creation as needed.
AWS KMS + Secrets Manager (example)
===================================

This folder contains a minimal Terraform example that provisions:
- an AWS KMS asymmetric key for signing (ED25519 / SIGN_VERIFY)
- a Secrets Manager secret to store the VRF private key (encrypted by the KMS key)

IMPORTANT
- Review organization security policies before running in production.
- Replace `customer_master_key_spec` with the appropriate attribute for your terraform-aws-provider version if needed (some versions use `key_spec`).
- Do NOT commit real secrets to source control.

Quick start (example):

```bash
cd infra/aws
export AWS_PROFILE=your-profile
terraform init
terraform apply -var "aws_region=us-east-1" -var "vrf_private_key_hex=632561f9..." -auto-approve
```

After apply, note the outputs `kms_key_id` and `secret_arn` and configure your CI/production environment to read the secret via Secrets Manager and to allow the service role to use the KMS key.

GitHub Actions: set these repository secrets for integration runs:
- `VRF_PRIVATE_KEY_HEX` (or use Secrets Manager and set `KMS` provider in production)
- `ORACLE_VRF_PRIVATE_KEYS`
- `ORACLE_STELLAR_SEEDS`
- `RUN_INTEGRATION=1` to enable integration job in CI
