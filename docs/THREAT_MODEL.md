# Threat Model (summary)

This document summarizes high-level threats considered for the Soroban VRF Oracle repository and the mitigations present in the codebase.

Threats
- Private key compromise (secp256k1 VRF key or Oracle Ed25519 seed).
- Replay or double-fulfill attacks against the on-chain contract.
- RPC node inconsistencies (missing events) or manipulated responses.
- Malformed proof data causing crashes in verifier or contract submission.

Mitigations present in repository
- `soroban-contract/src/lib.rs` enforces `proof.public_key` equality, `require_auth()` and verifies Ed25519 signature on proof payload.
- Contract default build now enables feature-gated on-chain ECVRF verification (`default = ["ecvrf"]` in Cargo features).
- Off-chain code verifies ECVRF proofs locally (`verifyEcvrfProof`) before signing/submitting to the contract.
- drand beacons are signature-verified locally before being accepted as entropy input.
- API uses a strict request lifecycle (`pending` → `proof_generated` → `onchain_submitted` → `onchain_confirmed`) to avoid false-success states.
- Integration tests include tolerant parsing for RPC event absence and SCVal/XDR decoding (`scvalDecode.ts`).
- Secrets are removed from source; `.env.example` provided and keyManager scaffold is present for KMS integration.

Recommended next steps (not implemented here)
- Integrate a hardware-backed KMS/HSM for the VRF and oracle signing keys.
- Add runtime protections for key usage and rate limits for oracle endpoints.
- Operational monitoring and alerting for failed submissions, signature mismatches and suspicious replay behavior.
