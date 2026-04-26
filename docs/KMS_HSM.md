KMS / HSM / MPC guidance for VRF private keys

Purpose
- Explain options for removing VRF private key material from the application process and approaches for production-grade key custody.

Options
- External signer (HTTP): run the `vrfSigner` PoC in a separate host that has access to the VRF private key (Secrets Manager, HSM, or a secure file system). The API app delegates proof generation via `VRF_SIGNER_URL`. This is the quickest migration path.
  - External oracle signer (HTTP) for Ed25519 operations: you can also run the PoC signer to host the oracle's Ed25519 key and expose signing endpoints; set `ORACLE_SIGNER_URL` in the main app to delegate `signProofMessage` and `signTransactionHash` to the external signer. The PoC supports `/oraclePublicKey`, `/signProof`, and `/signTx`.
- Cloud KMS (asymmetric keys): some cloud KMS providers support asymmetric keys and remote `Sign` and `GetPublicKey` APIs. If your provider supports `secp256k1` EC operations, you may be able to implement VRF primitives directly via KMS or by deriving public keys only from KMS and delegating proof generation to a secure host.
- HSM (CloudHSM / on-prem): run the EC math inside an HSM or use an HSM-attached host to perform `x * H` multiplications and deterministic nonce arithmetic. This requires HSMs that support raw EC multiplication or a trusted runtime.
- MPC / Threshold VRF: deploy a threshold signing/MPC protocol across multiple independent operators. This is the most robust defense against operator bias but requires a design and cryptographic implementation (research + audit).

Practical recommendations
- If you can use an asymmetric KMS key for `Ed25519` signing (used for on-chain authentication), prefer KMS for Ed25519 (the `keyManager` already supports AWS KMS Sign for Ed25519 for `signProofMessage`).
- For the `secp256k1` VRF key: either
  - Use `VRF_SIGNER_URL` to delegate proof generation to a tightly controlled host that reads the private key from Secrets Manager or HSM, or
  - Evaluate whether your KMS supports `secp256k1` `GetPublicKey` + sign primitives — if so, integrate directly.
- Avoid storing `VRF_PRIVATE_KEY_HEX` in environment variables or code in production.

AWS-specific notes
- AWS KMS supports asymmetric keys and `GetPublicKey`/`Sign` operations for some curves; check current AWS docs before relying on it for `secp256k1` VRF math.
- Use AWS Secrets Manager to store raw secret artifacts only if you plan to run signer code on a host that can securely fetch and use the secret.
- For HSM-backed keys, consider CloudHSM or Nitro Enclaves for secure execution.

Security checklist
- Use mTLS + API authentication for any external signer endpoint.
- Protect signer host with restrictive network ACLs and IAM policies.
- Audit all key usage via KMS/HSM audit logs.
- Enforce deterministic nonce generation inside the secure boundary and log proofs for audit.
- Set `REQUIRE_REMOTE_SIGNER=1` in production so the API refuses to start without `ORACLE_SIGNER_URL`.
