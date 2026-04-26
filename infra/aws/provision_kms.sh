#!/usr/bin/env bash
set -euo pipefail

# provision_kms.sh — helper to init/plan/apply Terraform for KMS + Secrets
# Usage: export VRF_PRIVATE_KEY_HEX=<hex>
#        (ensure AWS creds or OIDC role in environment)
#        ./provision_kms.sh [--auto-approve]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v terraform >/dev/null 2>&1; then
  echo "terraform is not installed or not in PATH. Install Terraform first." >&2
  exit 2
fi

AUTO_APPROVE=""
if [ "${1-}" = "--auto-approve" ]; then
  AUTO_APPROVE="-auto-approve"
fi

if [ -z "${VRF_PRIVATE_KEY_HEX-}" ]; then
  read -rp "Enter VRF private key hex (will not be saved): " VRF_PRIVATE_KEY_HEX
fi

if [ -z "$VRF_PRIVATE_KEY_HEX" ]; then
  echo "VRF_PRIVATE_KEY_HEX is required" >&2
  exit 2
fi

echo "Initializing Terraform..."
terraform init -input=false

echo "Validating configuration..."
terraform validate

echo "Planning (sensitive value set in TF_VAR_vrf_private_key_hex env var)..."
# export sensitive var into TF_VAR to avoid showing it on the command line
export TF_VAR_vrf_private_key_hex="$VRF_PRIVATE_KEY_HEX"
trap 'unset TF_VAR_vrf_private_key_hex' EXIT

terraform plan -out=tfplan -input=false

echo "Applying plan..."
terraform apply -input=false $AUTO_APPROVE tfplan

echo "Provisioning complete. Terraform outputs:"
terraform output

# unset sensitive env var immediately (guard)
unset TF_VAR_vrf_private_key_hex || true

echo
echo "To copy outputs into GitHub secrets, run the scripts/ci/set_github_secrets.sh helper with gh CLI configured." 
