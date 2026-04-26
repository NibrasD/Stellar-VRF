# KMS Integration (AWS KMS)

This document describes how to configure `KMS_PROVIDER=aws` for limited signing support.

What is implemented
- `keyManager.init()` will initialize an AWS KMS client when `KMS_PROVIDER=aws`.
- `keyManager.getOraclePublicKey()` fetches the public key from KMS and returns the Stellar address.
- `keyManager.signProofMessage(message)` uses KMS `Sign` (SigningAlgorithm=ED25519) to sign the proof message submitted to the contract.

Important limitations
- Transaction signing (the Stellar transaction envelope) via remote KMS is NOT implemented. The server still expects a local `ORACLE_STELLAR_SEED` for signing transactions. See notes below for options.
- VRF private key (secp256k1) is not available via KMS in this implementation. Generating ECVRF proofs currently requires `VRF_PRIVATE_KEY_HEX` in a secure store.

Recommended deployment options
1. Short term: Keep `VRF_PRIVATE_KEY_HEX` in a secure CI secret and store the oracle Ed25519 key in AWS KMS. Use KMS for proof signing and local `ORACLE_STELLAR_SEED` for transaction signing (or export the public key to the contract initializer).
2. Medium term: Implement remote transaction signing by adding `keyManager.signTransaction()` which signs the transaction hash via KMS and attaches the signature to the envelope. This requires careful integration with `@stellar/stellar-sdk` and testing.
3. Long term: Move VRF generation into an HSM or KMS that supports secp256k1 private ops (or adopt an MPC/threshold scheme) so private keys never leave hardware.

Env variables
- `KMS_PROVIDER=aws`
- `KMS_AWS_KEY_ID` — KMS Key ARN or alias to use for signing (ED25519 key)
- `AWS_REGION` — AWS region for the KMS key
 - `KMS_AWS_VRF_SECRET_ARN` — (optional) ARN of Secrets Manager secret that stores `VRF_PRIVATE_KEY_HEX` to avoid local env usage

Security notes
- Rotate KMS key material regularly and enable CloudTrail + KMS logs.
- Restrict KMS key usage to the service principal responsible for signing only.
