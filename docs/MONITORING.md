Prometheus metrics and alerting for the VRF API

Overview
 - The API server exposes Prometheus metrics at `/metrics` when `monitoring.initMetrics()` is enabled (this is invoked by default in `app.ts`).
 - Key metrics available:
   - `vrf_requests_total` — total API requests processed
   - `vrf_fulfill_success_total` — successful on-chain fulfill submissions
   - `vrf_fulfill_failure_total` — failed fulfill submissions
   - `vrf_drand_verify_failure_total` — drand signature/attestation failures
   - `vrf_onchain_request_failure_total` — request tx submission failures
   - `vrf_onchain_fulfill_failure_total` — fulfill tx submission failures
   - `vrf_request_retry_total` — retry-like attempts
   - `vrf_request_stuck_total` — number of requests stuck in intermediate states
   - `vrf_tx_confirmation_seconds{kind=request|fulfill}` — tx confirmation latency
   - `vrf_request_duration_seconds` — histogram of request latencies

Example Alertmanager rules (Prometheus recording/alerting rules)
Save the following snippet as a Prometheus rules file and load into your Prometheus/Alertmanager stack.

```
groups:
  - name: vrf.rules
    rules:
      - alert: HighFulfillFailureRate
        expr: rate(vrf_fulfill_failure_total[10m]) > 0.01
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High VRF fulfill failure rate"
          description: "Fulfill failures > 1% over last 10m. Check signer/KMS and Soroban RPC connectivity."

      - alert: NoMetricsFromApi
        expr: absent(up{job="vrf-api"})
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "VRF API metrics not reachable"
          description: "Prometheus cannot reach the VRF API scrape target. Ensure scrape config and network rules are correct."

      - alert: DrandVerificationFailures
        expr: increase(vrf_drand_verify_failure_total[10m]) > 0
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "drand verification failures detected"
          description: "At least one drand verification/attestation failure in the last 10m."

      - alert: StuckVrfRequests
        expr: vrf_request_stuck_total > 0
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "VRF requests stuck in intermediate states"
          description: "Requests remain in pending/proof_generated/onchain_submitted beyond threshold."

      - alert: HighConfirmationLatency
        expr: histogram_quantile(0.95, sum(rate(vrf_tx_confirmation_seconds_bucket[10m])) by (le, kind)) > 45
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "High Soroban tx confirmation latency"
          description: "P95 tx confirmation latency above 45s."
```

Grafana ideas
 - Single dashboard with panels:
   - Requests per minute (rate of `vrf_requests_total`)
   - Fulfill success vs failure ratio (counters)
   - Request latency histogram (p95/p99 derived from `vrf_request_duration_seconds`)
   - Uptime / scrape health for `vrf-api`

Operational notes
 - Secure `/metrics` scrape endpoints behind network ACLs or mTLS when exposing to shared Prometheus instances.
 - Alerting should notify operators on both increased failures and significant latency regressions.
