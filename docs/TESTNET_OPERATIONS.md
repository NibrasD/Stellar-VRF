# Testnet operations

How the **Testnet** oracle worker is built, deployed and kept alive. It is a single
worker on its own small server (512 MB RAM), isolated from Mainnet:

- its own Stellar account and BLS key (`oracle-worker/testnet_keygen.mjs`), never shared with Mainnet;
- its own host and SSH access;
- no Redis: a lock file is enough for one worker on one host (`leader.ts` picks the file
  backend automatically when `REDIS_URL` is unset);
- no `NODE_ENV=production`, because that makes `policy.ts` demand Redis. Never copy the
  Mainnet `.env` here, and never copy `.env.testnet` to a Mainnet host.

| Property | Value |
|---|---|
| **Contract ID** | [`CD5K4NNYNG3ZFCET24F3SL6MSYYRD5I2BSWW5K3LFQVIKYHRY2ICVIVX`](https://stellar.expert/explorer/testnet/contract/CD5K4NNYNG3ZFCET24F3SL6MSYYRD5I2BSWW5K3LFQVIKYHRY2ICVIVX) |
| **Oracle Account** | [`GA2WKWFHOGUCBX573A26NQAF44UFPUCB3ZS23ROKBXOUQLU7D5V62VET`](https://stellar.expert/explorer/testnet/account/GA2WKWFHOGUCBX573A26NQAF44UFPUCB3ZS23ROKBXOUQLU7D5V62VET) |
| **Status** | **Active** (last verified: October 17, 2026; worker running under PM2) |
| **Service Tier** | Best-effort developer testing (isolated from production Mainnet) |

> **Testnet Reset Notice:** Stellar Testnet is periodically reset by the Stellar Development Foundation (SDF), wiping all contracts and ledger history. After each reset, the contract must be redeployed (`testnet_deploy.mjs`) and its address will change. The Testnet worker operates on a best-effort basis.

Placeholders: `<TESTNET_HOST>` is the server address and `<REL>` is the release name
printed by `testnet_package.ps1` (for example `testnet-53d5aae1`). Nothing in this
document contains a secret.

## 1. Node version

Use **Node 22.12 or newer**. `@stellar/stellar-sdk` 17 declares `engines.node >=22.12.0`.
At the time of writing the Mainnet hosts run v22.23.2 (host B) and v20.20.2 (host A).
v20 is below the SDK's requirement, so do not copy host A.

## 2. Build the package on your PC (never on the server)

The server has too little RAM for `tsc`. Build locally; the script uses `npm.cmd`
everywhere because plain `npm` does not run on this machine:

```powershell
cd C:\Users\User\Stellar-VRF\oracle-worker
.\testnet_package.ps1 -RunTests
```

It refuses to run on a dirty tree (unless `-AllowDirty`), runs `npm.cmd ci` and
`npm.cmd run build`, removes test and declaration files from `dist`, adds
`package.json`, `package-lock.json`, `ttl_extend.mjs` and a `MANIFEST.json` (commit,
build time, SHA-256 of `dist/fulfiller.js`), and refuses to finish if the package
contains an env file or anything shaped like a Stellar secret key. It prints the
`.tgz` path, its SHA-256 and the exact `scp` command.

## 3. One-time server setup (user `deploy`, no root login)

```bash
# Node 22.23.2 (check the CPU first: uname -m should print x86_64; otherwise use linux-arm64)
sudo apt-get update && sudo apt-get install -y xz-utils curl
cd /tmp
curl -fsSLO https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz
curl -fsSLO https://nodejs.org/dist/v22.23.2/SHASUMS256.txt
grep ' node-v22.23.2-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum -c -
sudo tar -xJf node-v22.23.2-linux-x64.tar.xz -C /usr/local --strip-components=1
node -v          # v22.23.2
sudo npm install -g pm2

# 512 MB RAM: add swap only if there is none (check with: swapon --show)
sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Folders: created with sudo, then handed to deploy
sudo mkdir -p /home/deploy/vrf-testnet/releases /home/deploy/vrf-testnet/state
sudo chown -R deploy:deploy /home/deploy/vrf-testnet
chmod 700 /home/deploy/vrf-testnet /home/deploy/vrf-testnet/state
```

Only SSH needs to be reachable. The worker's health endpoint listens on `127.0.0.1:8080`
and nothing else listens, so open no other port.

## 4. Secrets: copy with `scp`, never through git or chat

From your PC (the file is git-ignored):

```powershell
scp C:\Users\User\Stellar-VRF\oracle-worker\.env.testnet deploy@<TESTNET_HOST>:/home/deploy/vrf-testnet/.env
```

```bash
chmod 600 /home/deploy/vrf-testnet/.env
grep -c '^NODE_ENV=' /home/deploy/vrf-testnet/.env    # must print 0
grep -c '^REDIS_URL=' /home/deploy/vrf-testnet/.env   # must print 0
```

## 5. Deploy a release

```powershell
# on your PC
scp "$env:TEMP\<REL>.tgz" deploy@<TESTNET_HOST>:/home/deploy/<REL>.tgz
```

```bash
# on the server: compare with the SHA-256 printed by testnet_package.ps1
sha256sum /home/deploy/<REL>.tgz

mkdir -p /home/deploy/vrf-testnet/releases/<REL>
tar -xzf /home/deploy/<REL>.tgz --strip-components=1 -C /home/deploy/vrf-testnet/releases/<REL>
cd /home/deploy/vrf-testnet/releases/<REL>
npm ci --omit=dev --ignore-scripts
sha256sum dist/fulfiller.js        # must equal fulfillerJsSha256 in MANIFEST.json
cat MANIFEST.json

ln -sfn /home/deploy/vrf-testnet/releases/<REL> /home/deploy/vrf-testnet/current
```

`current` is a symlink, so a rollback is `ln -sfn` to the previous release plus
`pm2 restart oracle-testnet`.

## 6. Start the worker with pm2

The state files must live outside `/tmp` so they survive a reboot. The default
`INSTANCE_ID` is `oracle-<pid>` (it changes on every restart), so pin it. Put both in a
pm2 ecosystem file next to the `.env`, not inside a release:

```bash
cat > /home/deploy/vrf-testnet/ecosystem.config.cjs <<'EOF'
module.exports = {
  apps: [{
    name: "oracle-testnet",
    script: "dist/index.js",
    cwd: "/home/deploy/vrf-testnet/current",
    autorestart: true,
    max_memory_restart: "300M",
    env: {
      DOTENV_PATH: "/home/deploy/vrf-testnet/.env",
      INSTANCE_ID: "oracle-testnet",
      LEADER_LOCK_FILE: "/home/deploy/vrf-testnet/state/leader.lock",
      FEE_GUARD_STATE_FILE: "/home/deploy/vrf-testnet/state/unpaid-spend.json",
      FEE_GUARD_PAID_STATE_FILE: "/home/deploy/vrf-testnet/state/paid-exposure.json"
    }
  }]
};
EOF
cd /home/deploy/vrf-testnet && pm2 start ecosystem.config.cjs && pm2 save
```

Start on boot: run the command that `pm2 startup systemd -u deploy --hp /home/deploy`
prints (it needs `sudo`), then `pm2 save` again. `pm2 startup` only enables the unit for
the next boot; it does not start it now.

Check it (the endpoint is local to the server):

```bash
curl -s http://127.0.0.1:8080/health     # role: leader, listener.running: true
pm2 logs oracle-testnet --lines 30 --nostream
```

A lone worker on the file backend should log `[Leader] oracle-testnet is now the LEADER`
within a few seconds. `/health` reports `degraded` if the listener is stuck, which is
the signal to look at the logs.

## 7. Keep the contract alive (`ttl_extend.mjs`)

Soroban archives the contract when its **instance** or its **WASM code** entry expires,
and then every call fails. The contract calls `extend_ttl(17_280, 518_400)` inside real
transactions such as `request` and `fulfill`, which only does something once fewer than
17,280 ledgers (about 1 day) remain, and then extends to about 30 days. Simulated reads
extend nothing, and there is no periodic job in the worker, so a contract with no
traffic expires. `ttl_extend.mjs` is that periodic job: it extends the instance and the
WASM code in one `ExtendFootprintTtl` transaction.

It is signed by a separate **keeper** account. It never reads or uses the oracle key,
and it refuses to run if an `ORACLE_*` secret is in its environment or keeper file, or if
the keeper is the contract's oracle account.

```bash
cd /home/deploy/vrf-testnet/current

# read-only check, no key needed. Exit 0 if every entry has >= 14 days left, else 2
node ttl_extend.mjs --check --contract <CONTRACT_ID>

# create the keeper key ON the server, so its secret never travels (Testnet only: Friendbot funds it)
node ttl_extend.mjs --keygen --keeper-file /home/deploy/vrf-testnet/keeper.env --friendbot
echo 'CONTRACT_ADDRESS=<CONTRACT_ID>' >> /home/deploy/vrf-testnet/keeper.env
chmod 600 /home/deploy/vrf-testnet/keeper.env

# extend (does nothing while both entries still have more than 45 days)
node ttl_extend.mjs --keeper-file /home/deploy/vrf-testnet/keeper.env
```

Settings (environment variables): `MIN_DAYS=14` (alert threshold), `EXTEND_TO_DAYS=60`,
`EXTEND_IF_BELOW_DAYS=45`, `MAX_FEE_STROOPS` (the script refuses to pay more than this
and also refuses if the keeper balance is below the simulated cost). Days are estimated
at 5 s per ledger, so they are approximate.

Exit codes: `0` ok, `1` error, `2` less than `MIN_DAYS` remaining (alert threshold), `3` an entry is already
archived (needs `RestoreFootprint`, e.g. `stellar contract restore`; the script does not
do that).

**Rent is not cheap.** Simulated on 2026-10-17: about 0.44 XLM per extra day on Mainnet
(extending 14 to 60 days is about 20 XLM) and about 3.5 XLM per extra day on Testnet (6.8
to 60 days is about 187 XLM, free from Friendbot at 10,000 XLM per account). The 44 KB
WASM dominates the cost. Re-simulate before relying on these numbers; they follow network
fee settings.

### Weekly Cron Schedule (for user `deploy`)

Schedule the extension script to run weekly (every Sunday at 04:17 UTC) as the `deploy` user.
The output logs to `/home/deploy/vrf-testnet/state/ttl_extend.log`:

```bash
# Exact crontab entry for user deploy:
17 4 * * 0 cd /home/deploy/vrf-testnet/current && /usr/local/bin/node ttl_extend.mjs --keeper-file /home/deploy/vrf-testnet/keeper.env >> /home/deploy/vrf-testnet/state/ttl_extend.log 2>&1 || echo "ttl_extend FAILED $(date -u)" >> /home/deploy/vrf-testnet/state/ttl_extend.log
```

To install this entry directly into the `deploy` user's crontab on the server:

```bash
( crontab -l 2>/dev/null; echo '17 4 * * 0 cd /home/deploy/vrf-testnet/current && /usr/local/bin/node ttl_extend.mjs --keeper-file /home/deploy/vrf-testnet/keeper.env >> /home/deploy/vrf-testnet/state/ttl_extend.log 2>&1 || echo "ttl_extend FAILED $(date -u)" >> /home/deploy/vrf-testnet/state/ttl_extend.log' ) | crontab -
```

### Checking TTL Health (`--check`)

To check the contract's remaining TTL at any time without submitting a transaction:

```bash
cd /home/deploy/vrf-testnet/current
node ttl_extend.mjs --check --contract CD5K4NNYNG3ZFCET24F3SL6MSYYRD5I2BSWW5K3LFQVIKYHRY2ICVIVX
```

- **Exit code `0`:** Both the contract instance and WASM code have $\ge 14$ days remaining (`MIN_DAYS=14`). The contract is healthy.
- **Exit code `2`:** Less than 14 days remaining on at least one entry. This triggers an operational alert to inspect rent/keeper balance.
- **Exit code `1`:** Execution error (e.g., RPC unreachable or configuration error).
- **Exit code `3`:** An entry has already expired and archived (requires `stellar contract restore`).

Do the same on Mainnet only with a separate Mainnet keeper funded by hand, and run
`node ttl_extend.mjs --check --mainnet` to monitor it (97 days remained on 2026-10-17).
Testnet is also reset from time to time; after a reset the contract has to be redeployed
(`testnet_deploy.mjs`).

## 8. Reboot and rollback checks

```bash
pm2 ls; systemctl is-enabled pm2-deploy        # worker online, unit enabled
ls -l /home/deploy/vrf-testnet/current          # which release is live
```

Rollback: `ln -sfn /home/deploy/vrf-testnet/releases/<OLD_REL> /home/deploy/vrf-testnet/current`
then `pm2 restart oracle-testnet`.

## 9. On-Chain Proof of Operation (`CD5K4NNY...`)

The isolated Testnet contract and oracle worker have been verified on-chain on Stellar Testnet:

| Operation | Transaction Hash | Ledger | Status |
|---|---|---|---|
| **WASM Upload** | [`c2e31c68...`](https://stellar.expert/explorer/testnet/tx/c2e31c6893e32cd867f41e2447d0fc0f1301d0d3dec5996dac545d37a6b47a07) | 5243101 | Successful |
| **Deploy & Init** | [`f96f7b19...`](https://stellar.expert/explorer/testnet/tx/f96f7b19e50aefbd24349be62dd994efd8db78be4331ba6f743e6c85cb25dd1d) | 5243102 | Successful |
| **Request #2** | [`7b22374e...`](https://stellar.expert/explorer/testnet/tx/7b22374ee1e0ba3e9a1d7ff68939c3b2fcd81cd619775bb47b07002bf912e930) | 5247298 | Successful |
| **Fulfillment #2** | [`e5a3127f...`](https://stellar.expert/explorer/testnet/tx/e5a3127fa1562b3ac746400db4bf919547361b139376a4940e3e5010b4f2a85e) | 5247300 | Successful |
| **Request #3** | [`97d81548...`](https://stellar.expert/explorer/testnet/tx/97d8154816102415426fef65338953ae88b684427cf876ffdb2f4142a1039a1b) | 5247358 | Successful |
| **Fulfillment #3** | [`130e6540...`](https://stellar.expert/explorer/testnet/tx/130e6540d2c9f539f8f9577ffd53697e9076614b7bf1b9048499ae96255ae8da) | 5247362 | Successful |

- **Contract ID:** `CD5K4NNYNG3ZFCET24F3SL6MSYYRD5I2BSWW5K3LFQVIKYHRY2ICVIVX`
- **Oracle Account:** `GA2WKWFHOGUCBX573A26NQAF44UFPUCB3ZS23ROKBXOUQLU7D5V62VET`
- **Verification Date:** October 17, 2026
- **Worker Configuration:** PM2 process `oracle-testnet` auto-starts on boot via `pm2 startup`. Both Request #2 and Request #3 were fulfilled and verified against on-chain BLS proofs.
