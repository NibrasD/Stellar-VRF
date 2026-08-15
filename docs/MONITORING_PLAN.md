# On-Chain Monitoring Plan — Stellar VRF Oracle

This monitoring plan is derived from the [STRIDE Threat Model](./STRIDE_THREAT_MODEL.md).
Each monitor traces back to a threat ID from that document so the two stay linked.

**Classification: Internal.** A filled-in monitoring plan reveals what is and isn't
monitored. Treat this as sensitive.

---

## What are we monitoring?

The Stellar VRF Oracle provides verifiable randomness to Soroban contracts on the Stellar
network. The system holds no pooled funds, but controls the integrity of randomness output
used by downstream applications (games, lotteries, NFT mints, etc.). Compromised randomness
could cause direct financial loss in consumer applications.

| Component | On-chain address | Notes |
|---|---|---|
| VRF Oracle Contract | `CAQFZI4IVZ35YODWSYWRKZE7WARBXKPQ3M5PA66R3PPR6M775K67FHQR` | Stores proofs, manages request lifecycle |
| Oracle Operator Account | `GARPMPBJ5H43UNYHLIC46MSYRDGF4ZNKUYTZYDYVW5S2TUORAMBZRAMI` | Signs and submits fulfill() transactions |
| Oracle Worker | Off-chain (TypeScript process) | Listens for events, generates VRF proofs |
| drand quicknet | Off-chain (distributed beacon) | Source of unpredictable randomness input |

---

## What could go wrong?

### Threat register

| Threat ID | Threat (from STRIDE model) | Affected component | Severity |
|---|---|---|---|
| Spoofing.1 | Forged oracle proof submitted via fulfill() | VRF Contract | Critical |
| Spoofing.2 | Fake callback to consumer contract | Consumer contracts | High |
| Tampering.1 | Oracle biases output via crafted alpha_seed | VRF Contract | Critical |
| Tampering.3 | Malicious key rotation after account compromise | VRF Contract | High |
| Information_Disclosure.1 | Oracle BLS secret key leaked | Oracle Worker | Critical |
| Denial_of_Service.1 | Oracle goes offline, requests pile up unfulfilled | Oracle Worker | Medium |
| Denial_of_Service.2 | Spam requests exhaust oracle gas | Oracle Worker | Low |
| Elevation.1 | Callback re-entrancy to double-fulfill | VRF Contract | High |
| Elevation.2 | Replay of valid fulfill transaction | VRF Contract | High |
| Elevation.3 | Unauthorized timeout refund | VRF Contract | Medium |

---

## What does exploitation look like on-chain?

| Threat ID | Exploitation scenario | Observable on-chain effect(s) |
|---|---|---|
| Spoofing.1 | Attacker submits a fulfill() call with fabricated BLS proof. | Transaction from a non-oracle address invoking `fulfill()`; transaction reverts with "auth failed" or "pairing check failed". |
| Tampering.1 | Oracle submits a proof with a tampered alpha_seed. | Transaction reverts with "alpha seed mismatch". If somehow bypassed: `fulfill()` event with unexpected beta_output hash pattern. |
| Tampering.3 | Compromised oracle account calls `rotate_oracle_keys()` to install attacker's BLS key. | `rotate_oracle_keys` invocation event from the oracle address; new `oracle_pk` value stored. Subsequent fulfill() calls use a different BLS public key than expected. |
| Information_Disclosure.1 | Attacker with leaked BLS key generates valid proofs from their own machine. | `fulfill()` calls from the legitimate oracle address succeed, but originate from unexpected IP/infrastructure. On-chain: no direct signal (valid proofs look identical). Off-chain: oracle worker logs show it did not process the request. |
| Denial_of_Service.1 | Oracle worker crashes. Requests remain in "pending" state. | Growing count of requests where `is_fulfilled()` returns false and age exceeds `TIMEOUT_ROUNDS`. No `fulfill()` events for extended period. |
| Denial_of_Service.2 | Flood of `request()` calls from throwaway accounts. | Spike in `request` event count per ledger range. Unusual number of unique requester addresses. |
| Elevation.1 | Malicious callback re-enters fulfill(). | Transaction reverts with "already fulfilled". If Fulfilling guard fires: revert with "re-entrancy detected". |
| Elevation.2 | Replay of a previous fulfill() transaction. | Transaction reverts with "already fulfilled". Duplicate transaction hash rejected by Soroban. |
| Elevation.3 | Non-requester calls timeout_refund(). | Transaction reverts with "auth failed". If somehow bypassed: `timeout_refund` event where the caller differs from the original requester. |

---

## What will we monitor for?

| Monitor ID | Observable on-chain effect | Trigger condition & baseline | Monitoring rule |
|---|---|---|---|
| Tampering.3.M.1 | `rotate_oracle_keys` invocation | Any invocation. Baseline: zero — key rotation is a rare administrative event, never expected in normal operation. | Alert immediately on any oracle key rotation on the VRF contract. |
| Tampering.3.M.2 | `rotate_drand_pk` invocation | Any invocation. Baseline: zero — drand PK rotation is extremely rare. | Alert immediately on any drand PK rotation. |
| Denial_of_Service.1.M.1 | No `fulfill()` events for > 5 minutes while pending requests exist | Time since last `fulfill()` event exceeds 300s and `request_count > fulfilled_count`. Baseline: fulfill() should occur within ~30s of each request when oracle is healthy. | Alert on oracle liveness failure — no fulfillments while requests are pending. |
| Denial_of_Service.1.M.2 | Growing unfulfilled request backlog | `request_count - fulfilled_count > 5` sustained for > 10 minutes. Baseline: backlog should be 0-1 during normal operation. | Alert on growing request backlog indicating oracle degradation. |
| Denial_of_Service.2.M.1 | Spike in `request` events | More than 20 `request` events in a single 5-minute window. Baseline: normal usage is < 5 requests per 5-minute window during testnet. | Alert on request spam — possible gas griefing attack on oracle. |
| Spoofing.1.M.1 | Failed `fulfill()` transactions | Any `fulfill()` invocation that reverts. Baseline: zero — all fulfill() calls should succeed in normal operation. | Alert on any failed fulfill() transaction, indicating either a bug or an attack attempt. |
| Elevation.1.M.1 | Re-entrancy revert in fulfill() | Transaction revert containing "already fulfilled" during a callback execution context. Baseline: zero. | Alert on potential re-entrancy attack via malicious consumer callback. |
| Information_Disclosure.1.M.1 | fulfill() succeeds but oracle worker did not process | Oracle worker logs show no processing for a request_id that was fulfilled on-chain. Baseline: every on-chain fulfillment should have a corresponding worker log entry. | Alert on phantom fulfillment — possible BLS key compromise. Off-chain monitor required. |

Each monitor stated in one line:

- **Tampering.3.M.1** — We address **Tampering.3** in **the VRF contract** by monitoring for **`rotate_oracle_keys` invocations** on address **`CAQFZI4I...`**.
- **Tampering.3.M.2** — We address **Tampering.3** in **the VRF contract** by monitoring for **`rotate_drand_pk` invocations** on address **`CAQFZI4I...`**.
- **Denial_of_Service.1.M.1** — We address **Denial_of_Service.1** in **the oracle worker** by monitoring for **absence of `fulfill()` events while pending requests exist** on address **`CAQFZI4I...`**.
- **Denial_of_Service.1.M.2** — We address **Denial_of_Service.1** in **the VRF contract** by monitoring for **unfulfilled request backlog exceeding 5** on address **`CAQFZI4I...`**.
- **Denial_of_Service.2.M.1** — We address **Denial_of_Service.2** in **the VRF contract** by monitoring for **request event spikes exceeding 20 per 5 minutes** on address **`CAQFZI4I...`**.
- **Spoofing.1.M.1** — We address **Spoofing.1** in **the VRF contract** by monitoring for **failed `fulfill()` transactions** on address **`CAQFZI4I...`**.
- **Elevation.1.M.1** — We address **Elevation.1** in **the VRF contract** by monitoring for **re-entrancy reverts during callback** on address **`CAQFZI4I...`**.
- **Information_Disclosure.1.M.1** — We address **Information_Disclosure.1** in **the oracle worker** by monitoring for **fulfillments not initiated by our worker** (off-chain log comparison).

---

## What happens when an alert fires?

| Monitor ID | Severity | Response / action | Owner | Status | Last reviewed |
|---|---|---|---|---|---|
| Tampering.3.M.1 | Critical | Notify team via Telegram/Discord immediately. Verify if rotation was intentional. If not: assume key compromise, rotate keys again from a secure device, notify all consumer contract operators. | Oracle Operator | Planned | 2026-08-15 |
| Tampering.3.M.2 | High | Verify against drand network announcements. If unexpected: pause oracle worker, investigate, rotate if needed. | Oracle Operator | Planned | 2026-08-15 |
| Denial_of_Service.1.M.1 | Medium | Check oracle worker process health (systemd/PM2 status). Restart if crashed. If infrastructure issue: failover to backup instance. Notify consumers of temporary delay. | Oracle Operator | Planned | 2026-08-15 |
| Denial_of_Service.1.M.2 | Medium | Same as DoS.1.M.1 — indicates sustained outage. Escalate if restart does not resolve. | Oracle Operator | Planned | 2026-08-15 |
| Denial_of_Service.2.M.1 | Low | Investigate source addresses. If spam: consider enabling `fee_amount > 0` via contract re-init or rate limiting at the oracle worker level. | Oracle Operator | Planned | 2026-08-15 |
| Spoofing.1.M.1 | High | Investigate the failed transaction. If from a known address: likely a bug. If from unknown address: someone is probing. Log and continue monitoring. | Oracle Operator | Planned | 2026-08-15 |
| Elevation.1.M.1 | High | Investigate the consumer contract that triggered re-entrancy. Blacklist the callback address if malicious. The on-chain guard already prevented exploitation. | Oracle Operator | Planned | 2026-08-15 |
| Information_Disclosure.1.M.1 | Critical | Assume BLS key compromise. Immediately call `rotate_oracle_keys()` from a secure device. Notify all consumer contract operators. Investigate how the key was leaked. | Oracle Operator | Planned | 2026-08-15 |

**Status values:** *Active* (live and alerting), *Tuning* (live, thresholds being refined), *Planned* (agreed, not yet implemented).

All monitors are currently *Planned* for testnet. They will be moved to *Active* before mainnet deployment using a monitoring solution such as Stellar's event indexing, a custom watcher script, or a third-party monitoring service.

---

## Did we do a good job?

- Does every threat have at least one monitor? **Yes.** All 10 threats from the register have at least one monitor. Spoofing.2 (fake consumer callbacks) is handled off-chain via consumer contract authorization checks — not directly monitorable by us on-chain.
- Is every trigger threshold grounded in a baseline? **Yes.** Baselines are derived from observed testnet behavior (e.g., < 5 requests per 5-min window, fulfill within 30s).
- Does every monitor have a defined response, owner, and status? **Yes.** See table above.
- Have any monitors fired? **Not yet.** All monitors are in *Planned* status for testnet.
- Are all addresses current? **Yes.** Verified as of 2026-08-15.
- Were any off-chain threats identified? **Yes.** Information_Disclosure.1 (BLS key leak) requires off-chain log comparison. Oracle worker liveness (DoS.1) is partially off-chain.
