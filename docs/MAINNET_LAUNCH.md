# Stellar-VRF V2 — Mainnet launch checklist

Every step below was run on Testnet with the same tools (see
`SECURITY_REVIEW_V2.md`). Nothing here has been run on Mainnet. Do the steps
in order; do not skip a "verify" line.

Throughout: `cd oracle-worker`, Node ≥ 22.12, and `export NETWORK=mainnet`.

## 0. Before you start

- [ ] CI is green on the commit you deploy.
- [ ] You have read `V2_SECURITY_MODEL.md` (trust model, rules for consumers)
      and `SECURITY_REVIEW_V2.md` (internal review, not an independent audit).
- [ ] CI's "Release WASM build" step printed `OK: immutable` for that build.
- [ ] The WASM you deploy is the CI build of that commit:
      `sha256sum soroban-contract/target/wasm32v1-none/release/soroban_vrf_oracle.wasm`
      equals the hash printed by the CI job "Release WASM build".

## 1. Keys (new ones; never reuse Testnet or V1 keys)

| Key | Where it lives | Used for |
|---|---|---|
| Admin account (G…) | nowhere after step 2: its master key is disabled | the on-chain admin address |
| 3 admin signer keys | 3 separate devices, hardware wallets if possible, held by people who can be reached | governance (2 of 3) |
| Operator account + BLS key | the worker hosts' secret store | `fulfill()` only |
| Keeper account | the cron host | TTL extension only |

- [ ] Generate the operator's Stellar key (any Stellar wallet or
      `stellar keys generate`) and its BLS key (`npm run keygen`) on the
      worker host. The BLS key must be new for this deployment.
- [ ] Generate the 3 signer keys on their devices. Only their public keys
      leave the devices.
- [ ] Create and fund the admin account (a few XLM for fees) and the operator
      account (enough for fees; the fee guard's floor is 5 XLM).

## 2. Admin multisig

```bash
ADMIN_SECRET=S…(admin master) SIGNERS=G…,G…,G… THRESHOLD=2 node v2_admin_multisig.mjs
```

- [ ] Verify: `ADMIN_PUBLIC=G… node v2_admin_multisig.mjs --check` prints
      `OK: 2-of-3 multisig, master key disabled.`
- [ ] Destroy the admin master secret.

A single key can no longer act as admin. If two signers are lost, governance
is lost for good (the contract keeps working; its keys can no longer be
rotated or revoked), so keep the three keys in three places.

## 3. Deploy

The deploy transaction needs the admin (2 signatures) and the operator's
authorization. Without `ADMIN_SECRETS` the script prints the transaction XDR
to sign with the signer devices (for example in Stellar Lab) and submit. The
operator's authorization inside it is valid for 100 ledgers (about 8
minutes), so have the signers ready before you run it:

```bash
ADMIN_PUBLIC=G… ORACLE_STELLAR_SECRET=S… ORACLE_BLS_SECRET_KEY=… node v2_deploy.mjs
```

Defaults: fee 0.2 XLM in native XLM, round offset 4, rotation timelock 2 880
ledgers (~4 h), admin-transfer timelock 8 640 ledgers (~12 h). The timelocks
are ledger counts: if you want more wall-clock margin, set
`ROTATION_TIMELOCK_LEDGERS` / `ADMIN_TIMELOCK_LEDGERS` higher now. They
cannot be changed later.

- [ ] Verify on-chain (read-only): `CONTRACT_ADDRESS=C… node v2_monitor.mjs`
      shows the expected admin and operator and `all clear` (TTL alerts are
      handled in step 5).
- [ ] Record the contract address and the WASM hash publicly.

## 4. Worker

- [ ] `.env`: `CONTRACT_ADDRESS`, `ORACLE_STELLAR_SECRET`,
      `ORACLE_BLS_SECRET_KEY`, Mainnet RPC and passphrase, `REDIS_URL` (TLS)
      for HA. Leave `ORACLE_PREVIOUS_*` unset.
- [ ] Start it. Verify the log line `Chain config check: … a key set serves
      the active epoch.` If it refuses to start, fix the configuration; do not
      set `SKIP_CHAIN_CONFIG_CHECK` (refused on Mainnet anyway).
- [ ] Make one real request with the JS SDK and wait for the fulfillment.
      Verify `derive_random_in_range` on-chain equals the SDK's offline value.

## 5. Monitoring and upkeep (required, not optional)

The timelocks protect users only if someone notices a proposal.

- [ ] Cron, every 5 minutes, on a host with **no keys**:
      `NETWORK=mainnet CONTRACT_ADDRESS=C… node v2_monitor.mjs`
      and alert on a non-zero exit. It reports pending rotations and
      admin transfers, a revoked active epoch, an admin account that is not a
      multisig, a low operator balance and entries close to expiry.
- [ ] Cron, weekly, with the keeper key only: `node ttl_extend.mjs --mainnet`.
      A contract with no traffic expires otherwise.
- [ ] Alert on the worker's `/health` endpoint and on its process being down.

When you intend a governance action yourself, run the monitor with
`MONITOR_EXPECT=rotation` (or `admin`) so the expected proposal is
reported as information instead of an alert.

## 6. Publish the SDK and update the pages

- [ ] Publish `stellar-vrf-sdk` 3.0.0 to npm and crates.io (see
      `SDK_RELEASE.md`). 2.x stays the SDK for the V1 contract.
- [ ] Point the dashboard, playground and integration guide at the V2
      contract. They currently target V1 and assume sequential request ids and
      a `public_key` field in the proof.

## 7. Moving users off V1

- [ ] Announce the V2 address and that V1 will stop being served on a date.
- [ ] Keep the V1 worker running until V1 has no pending requests, then stop
      it. V1 requests that are never fulfilled remain refundable by their
      requesters.
- [ ] Do not register the V1 keys on V2.

## Incident quick reference

| Situation | Action |
|---|---|
| Operator key suspected stolen | `v2_rotate.mjs revoke <active epoch>` (2 signers, immediate). Pending requests become refundable at once; new requests stop until a rotation executes (~4 h). Then `propose` with new keys. A stolen operator key cannot choose outputs, only withhold. |
| Unexpected `pending KEY ROTATION / ADMIN TRANSFER` alert | Two admin signer keys were used without your knowledge. If you still control two signers, cancel it (`v2_rotate.mjs cancel` or `cancel-admin-transfer`) and replace the signers. If you do not, you cannot stop it: tell users immediately; the timelock (~4 h for a rotation, ~12 h for an admin transfer) is their time to stop using the contract. Neither can change a result or the code. |
| Worker down | Requests expire after 5 minutes and are refundable. Restart; it recovers open requests from recent events. |
| Planned key rotation | Runbook in `V2_SECURITY_MODEL.md`. |
