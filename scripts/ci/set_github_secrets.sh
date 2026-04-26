#!/usr/bin/env bash
set -euo pipefail

# set_github_secrets.sh — set required repo secrets using gh CLI
# Usage: export GITHUB_REPOSITORY=owner/repo
#        export VRF_PRIVATE_KEY_HEX=... OR provide local file
#        ./set_github_secrets.sh

if ! command -v gh >/dev/null 2>&1; then
  echo "gh (GitHub CLI) not found. Install and authenticate first." >&2
  exit 2
fi

if [ -z "${GITHUB_REPOSITORY-}" ]; then
  echo "GITHUB_REPOSITORY not set. Example: owner/repo" >&2
  exit 2
fi

set_secret() {
  name="$1"; valueVar="$2"
  if [ -z "${!valueVar-}" ]; then
    echo "Skipping $name — env var $valueVar is not set"
    return
  fi
  echo "Setting secret $name in $GITHUB_REPOSITORY"
  gh secret set "$name" --body "${!valueVar}" --repo "$GITHUB_REPOSITORY"
}

# List of recommended secrets (set only those you have)
set_secret VRF_PRIVATE_KEY_HEX VRF_PRIVATE_KEY_HEX
set_secret ORACLE_VRF_PRIVATE_KEYS ORACLE_VRF_PRIVATE_KEYS
set_secret ORACLE_STELLAR_SEEDS ORACLE_STELLAR_SEEDS
set_secret ORACLE_STELLAR_SEED ORACLE_STELLAR_SEED
set_secret SOROBAN_URL SOROBAN_URL
set_secret SOROBAN_NETWORK SOROBAN_NETWORK
set_secret FRIEND_BOT_URL FRIEND_BOT_URL
set_secret AWS_ROLE_ARN AWS_ROLE_ARN
set_secret AWS_REGION AWS_REGION
set_secret KMS_AWS_KEY_ID KMS_AWS_KEY_ID
set_secret KMS_AWS_VRF_SECRET_ARN KMS_AWS_VRF_SECRET_ARN

echo "Done. Verify secrets in https://github.com/$GITHUB_REPOSITORY/settings/secrets/actions"
