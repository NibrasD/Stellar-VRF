#!/usr/bin/env bash
#
# deploy_hotfix.sh — Rebuild the oracle worker and restart it under pm2.
# Run this ON THE SERVER from the repository root (e.g. /root/Stellar-VRF).
#
# It is safe to re-run. It does NOT touch your .env or keys.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="${REPO_ROOT}/oracle-worker"
PM2_APP="${PM2_APP:-oracle-primary}"
ORACLE_ACCOUNT="GA6HYAVWPVOVB4XJHGUZSDHRVYOKLPU4JAHYPXZRSJWO2PM4HSCNKP5P"

echo "==> Repo:   ${REPO_ROOT}"
echo "==> Worker: ${WORKER_DIR}"
echo "==> pm2 app: ${PM2_APP}"

cd "${WORKER_DIR}"

# 1. Pre-flight: warn if the oracle balance is low.
echo "==> Checking oracle XLM balance..."
BAL="$(curl -s "https://horizon.stellar.org/accounts/${ORACLE_ACCOUNT}" \
        | grep -o '"balance": "[0-9.]*"' | head -1 | grep -o '[0-9.]*' || echo "?")"
echo "    Balance: ${BAL} XLM"
if [ "${BAL}" != "?" ] && awk "BEGIN{exit !(${BAL} < 10)}"; then
  echo "    ⚠  WARNING: balance < 10 XLM — fund the account before it runs out."
fi

# 2. Ensure .env exists (do not overwrite).
if [ ! -f .env ]; then
  echo "    ⚠  No .env found in ${WORKER_DIR}. Copy .env.mainnet -> .env and set keys."
  exit 1
fi

# 3. Install deps + rebuild.
echo "==> Installing dependencies..."
npm install --no-audit --no-fund

echo "==> Building TypeScript -> dist/ ..."
rm -rf dist
npx tsc --outDir dist
test -f dist/index.js || { echo "    ✖ Build failed: dist/index.js missing"; exit 1; }
echo "    ✔ Build OK"

# 4. Restart under pm2 (start if not already registered).
echo "==> Restarting pm2 app '${PM2_APP}'..."
if pm2 describe "${PM2_APP}" >/dev/null 2>&1; then
  pm2 restart "${PM2_APP}" --update-env
else
  pm2 start dist/index.js --name "${PM2_APP}"
fi
pm2 save || true

echo ""
echo "==> Done. Tailing logs (Ctrl-C to stop) — expect 'New VRF request #...' then 'fulfilled':"
echo ""
pm2 logs "${PM2_APP}" --lines 40
