# Oracle Operational Runbook

This runbook covers day-to-day operations, deployment procedures, and
troubleshooting for the Stellar VRF Oracle.

---

## Quick Reference

| Item | Value |
|---|---|
| Contract (Testnet) | `CCOX44NFMB3G4TDOLG5EKCXBP3EZ5PCEC3SQNMWP24WG6BA6HCSU2CBE` |
| Contract (Mainnet) | TBD after deployment |
| Health endpoint | `http://localhost:8080/health` |
| Metrics endpoint | `http://localhost:8080/metrics` |
| drand chain | quicknet (`52db9ba7…`) |
| drand period | 3 seconds |
| Timeout window | 20 drand rounds (~60 seconds) |

---

## 1. Initial Deployment

### 1.1 Generate oracle keypair

```bash
# Generate new BLS + Ed25519 keypair
cd oracle-worker
npm run keygen

# Save output securely — this is your oracle secret key
# NEVER commit to git
```

### 1.2 Create `.env` file

```bash
cp .env.example .env
# Edit with your values:
# ORACLE_STELLAR_SECRET=S...
# ORACLE_BLS_SECRET_KEY=<hex from keygen>
# CONTRACT_ADDRESS=C...
# SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
# NETWORK_PASSPHRASE=Test SDF Network ; September 2015
```

### 1.3 Deploy contract (testnet)

```bash
stellar contract deploy \
  --wasm soroban-contract/target/wasm32v1-none/release/soroban_vrf_oracle.wasm \
  --source-account deployer \
  --network testnet
```

### 1.4 Initialize contract

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source-account deployer \
  --network testnet \
  -- init \
  --oracle_pk <BLS_PUBLIC_KEY_HEX> \
  --oracle_address <ORACLE_STELLAR_ADDRESS> \
  --oracle_ed25519_pk <ED25519_PK_HEX> \
  --drand_pk <DRAND_PK_HEX> \
  --g2_generator <G2_GEN_HEX> \
  --drand_genesis_time 1692803367 \
  --drand_period 3 \
  --round_offset 2 \
  --fee_token <SAC_ADDRESS> \
  --fee_amount 0
```

### 1.5 Start oracle worker (single node)

```bash
cd oracle-worker
npm install
npm run build
npm start
```

### 1.6 Start oracle worker (HA mode)

```bash
cd oracle-worker
docker compose -f docker-compose.ha.yml up -d

# Verify both nodes are running
docker compose -f docker-compose.ha.yml ps

# Check leader election
curl http://localhost:8080/status | jq .role  # should be "leader"
curl http://localhost:8081/status | jq .role  # should be "standby"
```

---

## 2. Health Monitoring

### 2.1 Check health endpoints

```bash
# Primary
curl http://localhost:8080/health

# Standby
curl http://localhost:8081/health
```

Expected response:
```json
{
  "status": "ok",
  "instance": "oracle-primary",
  "role": "leader",
  "uptime_seconds": 3600,
  "requests_fulfilled": 42,
  "requests_failed": 0,
  "last_fulfill_at": "2026-09-09T12:00:00.000Z"
}
```

### 2.2 Check Prometheus metrics

```bash
curl http://localhost:8080/metrics
```

Key metrics to watch:
- `vrf_requests_failed_total` — should be 0
- `vrf_fulfill_duration_ms_avg` — should be < 30,000ms
- `vrf_drand_delays_total` — should be low
- `vrf_is_leader` — exactly one node should be 1

### 2.3 Check contract state

```bash
stellar contract invoke --id <CONTRACT_ID> --network testnet -- timeout_rounds
```

---

## 3. Failover Procedures

### 3.1 Manual failover (planned maintenance)

```bash
# Stop primary gracefully — standby takes over within 30s
docker compose -f docker-compose.ha.yml stop oracle-primary

# Verify standby became leader
curl http://localhost:8081/status | jq .role  # should become "leader"

# Restart primary (will become standby)
docker compose -f docker-compose.ha.yml start oracle-primary
```

### 3.2 Emergency failover (primary crashed)

The standby will automatically detect the stale lock (after `LEADER_LOCK_TTL_MS` = 30s)
and take over. No manual action needed.

To verify:
```bash
curl http://localhost:8081/health  # standby should now show role: "leader"
```

### 3.3 Test failover drill

```bash
# Run monthly to verify HA works
docker compose -f docker-compose.ha.yml kill oracle-primary
sleep 35  # wait for TTL to expire
curl http://localhost:8081/status | jq '{role, requests_fulfilled}'
docker compose -f docker-compose.ha.yml up -d oracle-primary
```

---

## 4. Key Rotation

### 4.1 Rotate oracle BLS + Ed25519 keys

```bash
# Step 1: Generate new keys
npm run keygen
# Save new ORACLE_BLS_SECRET_KEY and note the new public key

# Step 2: Call rotate_oracle_keys() — signed by CURRENT oracle
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source-account current-oracle \
  --network testnet \
  -- rotate_oracle_keys \
  --new_oracle_pk <NEW_BLS_PK_HEX> \
  --new_oracle_address <NEW_ORACLE_ADDRESS> \
  --new_ed25519_pk <NEW_ED25519_HEX>

# Step 3: Update .env with new keys
# Step 4: Restart oracle worker
docker compose -f docker-compose.ha.yml restart

# Note: pending requests submitted before rotation will fail verification
# Requesters should call timeout_refund() for those requests
```

### 4.2 Rotate drand public key

Only needed if drand changes their chain key (rare).

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source-account oracle \
  --network testnet \
  -- rotate_drand_pk \
  --new_drand_pk <NEW_DRAND_PK_HEX>
```

---

## 5. Troubleshooting

### 5.1 Oracle not fulfilling requests

1. Check health: `curl http://localhost:8080/health`
2. Check logs: `docker compose -f docker-compose.ha.yml logs -f oracle-primary`
3. Verify drand is reachable: `curl https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/latest`
4. Check oracle account has XLM for fees: `stellar account view <ORACLE_ADDRESS> --network testnet`
5. Verify contract address in `.env` matches deployed contract

### 5.2 Transaction failing with "already fulfilled"

Idempotency check worked correctly — request was already fulfilled. No action needed.

### 5.3 Transaction failing with "txBadSeq"

Two nodes submitted simultaneously (leader election race). Check that exactly one node has role `leader`:
```bash
curl http://localhost:8080/status | jq .role
curl http://localhost:8081/status | jq .role
```

### 5.4 drand timeout

If drand API is unreachable, oracle will retry with exponential backoff.
Check `vrf_drand_delays_total` metric. If persistent, check alternate drand endpoints:
- `https://api.drand.sh` (primary)
- `https://api2.drand.sh` (secondary)

Set `DRAND_API_URL` in `.env` to switch.

### 5.5 High fulfillment latency

Expected: ~15-30 seconds (drand period + proof generation + TX confirmation).
If > 60 seconds:
1. Check Stellar network congestion via [Stellar Dashboard](https://dashboard.stellar.org)
2. Increase `TX_FEE` in `.env`
3. Check drand API latency

---

## 6. Backup and Recovery

### 6.1 What to back up

- `.env` file (especially `ORACLE_BLS_SECRET_KEY` and `ORACLE_STELLAR_SECRET`)
- Store in encrypted vault (e.g., 1Password, HashiCorp Vault)
- Back up to at least 2 locations

### 6.2 Restore from backup

```bash
# Restore .env file from backup
# Rebuild and restart
cd oracle-worker
docker compose -f docker-compose.ha.yml up -d
```

### 6.3 Complete disaster recovery

If oracle server is lost entirely:
1. Provision new server
2. Install Docker
3. Clone repository
4. Restore `.env` from backup
5. `docker compose -f docker-compose.ha.yml up -d`
6. Verify: `curl http://localhost:8080/health`

---

## 7. Mainnet Deployment Checklist

- [ ] Generate fresh keypair (`npm run keygen`)
- [ ] Fund oracle account on mainnet (minimum 5 XLM for fees)
- [ ] Deploy contract WASM to mainnet
- [ ] Initialize with production keys and `fee_amount`
- [ ] Start primary oracle on production server
- [ ] Start standby oracle on secondary server
- [ ] Verify health endpoints
- [ ] Submit test request + verify fulfillment
- [ ] Enable monitoring alerts
- [ ] Update dashboard contract address to mainnet
- [ ] Update playground to mainnet

---

## 8. Alert Thresholds

| Alert | Threshold | Action |
|---|---|---|
| No fulfillment in 10 min | `last_fulfill_at` > 600s ago | Check oracle logs, restart if needed |
| Request failure rate > 0% | `vrf_requests_failed_total` > 0 | Investigate immediately |
| drand delays | `vrf_drand_delays_total` > 10/hour | Check drand API, switch endpoint |
| Oracle not leader | Both nodes show `standby` | Manual intervention — check lock file |
| Uptime < 99% | Health returns 503 | Restart unhealthy node |
