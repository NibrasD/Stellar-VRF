# Operational Procedures

This document covers day-to-day operational procedures for the Stellar VRF Oracle
on mainnet.

## Deployment

### Contract Addresses

| Network | Contract ID | Oracle Account |
|---|---|---|
| **Mainnet** | `CCN75KEGLETGRTVJJDMXB2ZRQD6PC2S56VUOEKVLQPVEIJYGSOV55G57` | `GAQ3XIUK4VSMKMDPX6TA2CQGHJ3CUK7Z5ZLMNQRHTBYLVT3NUEBI5TVU` |
| Testnet | `CCOX44NFMB3G4TDOLG5EKCXBP3EZ5PCEC3SQNMWP24WG6BA6HCSU2CBE` | — |

### Mainnet Transaction Proof

| Transaction | Hash | Explorer |
|---|---|---|
| WASM Upload | `296bbf779514e69e0e9731f3a22018fc31153f5fcc9bf29131311c839716790e` | [View](https://stellar.expert/explorer/public/tx/296bbf779514e69e0e9731f3a22018fc31153f5fcc9bf29131311c839716790e) |
| Contract Deploy | `5febbea86e59a315c7d3ab80647cadab06c37def85bc247d764d1d8713dce181` | [View](https://stellar.expert/explorer/public/tx/5febbea86e59a315c7d3ab80647cadab06c37def85bc247d764d1d8713dce181) |
| Contract Init | `bbcb6a1a048ebc1aa1bd8915c80d6e727c21b940a60c6e34878114c3430222b9` | [View](https://stellar.expert/explorer/public/tx/bbcb6a1a048ebc1aa1bd8915c80d6e727c21b940a60c6e34878114c3430222b9) |
| First request() | `fae15bdd8e8b38163b69ed0c7df87150870aefb92078141fbdcef2bdc7d7846e` | [View](https://stellar.expert/explorer/public/tx/fae15bdd8e8b38163b69ed0c7df87150870aefb92078141fbdcef2bdc7d7846e) |
| First fulfill() | `5190ba03ba8cc708efe035996f90da0668f9f1d725658bd84aecbd63be24e5f2` | [View](https://stellar.expert/explorer/public/tx/5190ba03ba8cc708efe035996f90da0668f9f1d725658bd84aecbd63be24e5f2) |

## Starting the Oracle Worker

### Prerequisites

- Node.js ≥ 20
- Oracle account funded with XLM on mainnet
- `.env` file configured (see `.env.mainnet` template)

### Start Primary

```bash
cd oracle-worker
cp .env.mainnet .env
npx tsc --outDir dist
node dist/index.js
```

The worker will:
1. Print configuration
2. Start leader election (file-based lock)
3. If elected leader, begin polling for VRF request events
4. Automatically fulfill pending requests with BLS-VRF proofs
5. Health endpoint available at `http://localhost:8080/health`

### Start Hot-Standby Replica

Run a second instance on the same server (or shared filesystem):

```bash
node dist/index.js
```

The replica will:
1. Detect the existing leader lock
2. Enter standby mode, monitoring the lock heartbeat
3. Automatically take over if the primary's heartbeat is stale (>30s)
4. On-chain idempotency check (`is_fulfilled()`) prevents double-submission

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SOROBAN_RPC_URL` | No | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint |
| `NETWORK_PASSPHRASE` | No | Test SDF Network | Network passphrase |
| `CONTRACT_ADDRESS` | **Yes** | — | VRF oracle contract ID |
| `ORACLE_STELLAR_SECRET` | **Yes** | — | Oracle Ed25519 secret key |
| `ORACLE_BLS_SECRET_KEY` | **Yes** | — | Oracle BLS12-381 private scalar (hex) |
| `DRAND_API_URL` | No | `https://api.drand.sh` | drand HTTP API |
| `POLL_INTERVAL_MS` | No | `3000` | Event polling interval |
| `MAX_RETRIES` | No | `3` | Max fulfill retry attempts |
| `TX_FEE` | No | `1000000` | Transaction fee (stroops) |

## Monitoring

### Health Check

```bash
curl http://localhost:8080/health
```

Returns JSON with:
- `status`: "healthy" or "unhealthy"
- `role`: "LEADER" or "STANDBY"
- `lastPoll`: timestamp of last successful poll
- `uptime`: seconds since start

### Key Metrics to Watch

1. **XLM Balance** — Oracle account needs XLM for transaction fees
   - Alert if balance < 5 XLM
   - Each fulfill() costs ~1.3 XLM in fees

2. **Fulfill Latency** — Time from request event to fulfill TX confirmation
   - Normal: 5–15 seconds
   - Alert if > 60 seconds

3. **drand Availability** — The oracle depends on drand quicknet beacons
   - If drand is down, oracle cannot generate proofs
   - Retry logic handles temporary outages (up to MAX_RETRIES)

4. **Instruction Budget** — Monitor `fulfill()` instruction count
   - Current: **58,641,186** / 100,000,000
   - Alert if > 70,000,000 after contract upgrades

## Key Rotation

### Rotate Oracle BLS Key

```bash
# Generate new BLS keypair
node -e "const { bls12_381 } = require('@noble/curves/bls12-381');
const sk = bls12_381.utils.randomPrivateKey();
console.log('Secret:', Buffer.from(sk).toString('hex'));
const pk = bls12_381.G2.ProjectivePoint.BASE.multiply(BigInt('0x' + Buffer.from(sk).toString('hex')));
console.log('Public (192 bytes):', Buffer.from(pk.toRawBytes(false)).toString('hex'));"

# Call rotate_oracle_keys() on-chain with new public key
# Update .env with new ORACLE_BLS_SECRET_KEY
# Restart worker
```

### Rotate drand Public Key

Only needed if drand quicknet rotates their key (extremely rare):

```bash
# Fetch new key from drand API
curl https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/info

# Call rotate_drand_pk() on-chain with new uncompressed G2 key (192 bytes)
```

## Storage TTL Management

Soroban storage entries expire. The oracle worker extends TTLs during `fulfill()`:

- **Instance storage** (contract state): extended on every `fulfill()`
- **Request data**: extended to at least 100,000 ledgers (~5.7 days)
- **Proof cleanup**: `cleanup_proof()` removes bulky proof data while retaining
  the `Fulfilled` flag permanently

Manual TTL extension is not typically needed if the oracle processes requests
regularly.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "txInsufficientBalance" | Oracle account low on XLM | Fund the oracle account |
| "is_fulfilled = true" (skip) | Another instance already fulfilled | Normal for HA — no action needed |
| "drand beacon not found" | drand round not yet available | Oracle retries automatically |
| "Leader lock stale" | Primary crashed | Standby takes over automatically |
| Worker starts but no events | No pending requests | Normal idle state |
