# On-chain ECVRF Verification Feasibility

Summary: implementing full ECVRF verification inside the Soroban WASM contract is technically possible but non-trivial and has trade-offs.

Key considerations
- Crypto primitives: ECVRF requires secp256k1 point operations (affine/EC arithmetic) — ensure `env.crypto()` in Soroban supports needed ops or link a verified secp256k1 library into the contract WASM.
- Gas / cost: EC arithmetic inside WASM is computationally expensive; expect higher gas and slower performance.
- Safety: ported crypto must be constant-time and thoroughly audited.

Practical options
1. Native ECVRF in contract (heavy): port a minimal secp256k1 implementation and VRF verify routine into contract; requires thorough optimization and auditing.
2. Hybrid: verify only lightweight checks on-chain (e.g., key matches / signature verification) and rely on off-chain verification for EC math, with on-chain commit of final proof for auditability.
3. Use chain-native VRF primitives if available: prefer chains that expose VRF verify ops in their runtime.

Recommendation
- For a near-term production rollout, prefer options (2) + strong off-chain audit and multi-party randomness (threshold) rather than embedding full ECVRF verification in WASM immediately.

Build / experiment notes
- The contract secure build enables `ecvrf` by default.
- Example secure build (requires Rust toolchain and network to fetch crates):

```bash
cargo build --manifest-path soroban-contract/Cargo.toml --target wasm32-unknown-unknown --release
```

- The `ecvrf` feature pulls in `k256` and `sha2` and increases WASM size significantly; always run gas/size benchmarks before considering mainnet deployment.
