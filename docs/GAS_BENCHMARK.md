# Gas / Cost Benchmarking (notes)

This repository does not include an automated benchmarking harness that runs against a live Soroban network, but the following steps outline how to measure costs for `request` and `fulfill` operations:

1. Use `@stellar/stellar-sdk` to build and simulate transactions (`server.simulateTransaction(tx)`). The simulation response contains estimated resource usage which can be used to estimate gas.
2. To measure end-to-end cost, submit real transactions on Testnet and observe the resulting fees reported by the RPC or explorer.
3. Capture timings and fees in a script and aggregate over `N` runs to compute median and p95 costs.

Suggested script location: `scripts/bench_gas.mjs` (not included by default). The `sorobanSubmit.ts` helpers can be reused to build transactions.
