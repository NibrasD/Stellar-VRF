# Incident Response Procedures

## Severity Levels

| Level | Description | Response Time |
|---|---|---|
| P0 — Critical | Oracle down, no fulfillments possible | Immediate (< 15 min) |
| P1 — High | Increased failure rate, degraded performance | < 1 hour |
| P2 — Medium | Single request failure, intermittent issues | < 4 hours |
| P3 — Low | Minor alerts, non-impacting issues | Next business day |

---

## P0: Oracle Completely Down

**Symptoms:** Health endpoint returns 503, no fulfillments in > 10 minutes.

**Steps:**
1. Check both nodes: `curl http://localhost:8080/health && curl http://localhost:8081/health`
2. Check logs: `docker compose -f docker-compose.ha.yml logs --tail=50`
3. Restart unhealthy node: `docker compose -f docker-compose.ha.yml restart oracle-primary`
4. If still down, verify Stellar network: https://dashboard.stellar.org
5. If Stellar is fine, redeploy: `docker compose -f docker-compose.ha.yml up -d --force-recreate`
6. Verify recovery: `curl http://localhost:8080/health`

**Post-incident:** Check how many requests timed out. Requesters can call `timeout_refund()`.

---

## P1: High Failure Rate

**Symptoms:** `vrf_requests_failed_total` increasing, some requests not fulfilling.

**Steps:**
1. Check error logs for pattern (sequence errors, drand failures, etc.)
2. If `txBadSeq`: verify only one node is leader, check leader election lock
3. If drand errors: try alternate endpoint (`DRAND_API_URL=https://api2.drand.sh`)
4. If crypto errors: verify oracle keys match contract state

---

## P1: Double Submission Detected

**Symptoms:** Two `fulfill()` calls for same request ID, second fails with "already fulfilled".

**This is expected behavior** — the CEI guard worked correctly. No action needed.
Investigate why two nodes both thought they were leader and fix leader election config.

---

## P2: drand Delays

**Symptoms:** `vrf_drand_delays_total` spiking, fulfillment taking > 30 seconds.

**Steps:**
1. Check drand API: `curl https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/latest`
2. Switch to backup endpoint if needed
3. No user action required — oracle will retry automatically

---

## Communication Template

```
[VRF Oracle Status Update]

Time: {timestamp}
Severity: P{level}
Status: Investigating / Mitigating / Resolved

Impact: {description of impact on users}
Cause: {root cause if known}
Action: {what is being done}
ETA: {estimated resolution time}

Requests submitted during the incident:
- Requesters can call timeout_refund() after the timeout window (~60s)
- No funds at risk — fees are held in the contract
```
