import client from 'prom-client';

// Basic Prometheus metrics for the API server. Import and call `initMetrics`
// during server startup if you want metrics exposed.

export const register = client.register;

export const metrics = {
  requestsTotal: new client.Counter({ name: 'vrf_requests_total', help: 'Total VRF API requests' }),
  fulfillSuccess: new client.Counter({ name: 'vrf_fulfill_success_total', help: 'Successful fulfill submissions' }),
  fulfillFailure: new client.Counter({ name: 'vrf_fulfill_failure_total', help: 'Failed fulfill submissions' }),
  drandVerifyFailure: new client.Counter({ name: 'vrf_drand_verify_failure_total', help: 'Failed drand verification/attestation events' }),
  onchainRequestFailure: new client.Counter({ name: 'vrf_onchain_request_failure_total', help: 'Failed on-chain request submissions' }),
  onchainFulfillFailure: new client.Counter({ name: 'vrf_onchain_fulfill_failure_total', help: 'Failed on-chain fulfill submissions' }),
  requestRetryTotal: new client.Counter({ name: 'vrf_request_retry_total', help: 'Retry-like attempts for VRF request fulfill operations' }),
  requestStuckGauge: new client.Gauge({ name: 'vrf_request_stuck_total', help: 'Number of requests that appear stuck in intermediate states' }),
  txConfirmSeconds: new client.Histogram({
    name: 'vrf_tx_confirmation_seconds',
    help: 'Time to confirm Soroban transactions',
    buckets: [2, 5, 10, 20, 40, 60, 120],
    labelNames: ['kind'] as const,
  }),
  requestDuration: new client.Histogram({ name: 'vrf_request_duration_seconds', help: 'Duration of handling VRF requests', buckets: [0.1, 0.5, 1, 2, 5] }),
};

export function initMetrics() {
  client.collectDefaultMetrics();
}

export default { register, metrics, initMetrics };
