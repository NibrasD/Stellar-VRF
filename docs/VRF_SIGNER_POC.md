**VRF Signer PoC — Design & Runbook**

- **Purpose**: Provide a minimal HTTP service that performs ECVRF proof generation using the VRF private key held in a secure provider (env, AWS Secrets Manager, HSM, or MPC host). This PoC demonstrates how an HSM/MPC-backed signer could be integrated without exposing the private key to the main application process.

- **Security model (PoC)**:
  - The PoC runs as a separate process and exposes limited endpoints:
    - `POST /generateProof` — body: `{ alphaSeed, externalEntropyHex? }` → returns `EcvrfProof`.
    - `GET /publicKey` — returns the VRF public key (compressed hex).
  - In this PoC the signer will use the same code paths as the main app to compute proofs, but it fetches the VRF private key via `keyManager.getVrfPrivateKeyHexAsync()` (Secrets Manager or env).
  - For production, replace the PoC implementation with code that performs EC operations inside a secure boundary (HSM, enclave, or MPC protocol) where the private key never leaves the hardware/MPC participants.

- **How it helps**:
  - Keeps the VRF private key out of the main app process memory.
  - Allows enforcing stricter network and host-level controls on the signer process.
  - Provides a narrow RPC interface for proof generation and public key retrieval.

- **Limitations & caveats**:
  - This PoC is NOT an HSM or MPC implementation; it still performs EC math in user-space and will load the private key into process memory if using Secrets Manager.
  - Real HSMs or MPC require specialized integration and careful protocol design for deterministic VRF nonces.
  - Some managed KMS providers do not support raw secp256k1 EC operations required for ECVRF; verify provider capabilities before relying on KMS to perform VRF math.

- **Running locally (Windows PowerShell)**

1) Install dependencies (once):

```powershell
# from repository root
npm install -g pnpm   # or follow pnpm install instructions
pnpm install
```

2) Start the signer PoC (in a new terminal):

```powershell
# optional: configure where the signer should obtain the VRF key
$env:VRF_PRIVATE_KEY_HEX = "<your_test_sec_hex>"
# start the PoC signer
node .\artifacts\api-server\scripts\start_vrf_signer.mjs
```

3) Example request (PowerShell + Invoke-RestMethod):

```powershell
$body = @{ alphaSeed = 'test-alpha' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:6060/generateProof -Body $body -ContentType 'application/json'
```

- **Production integration notes**:
  - Prefer HSM or audit-grade CFEs: if you can run code inside an HSM enclave or on a host with a dedicated HSM-backed key, implement the ECVRF operations inside that environment.
  - If using MPC, each participant should implement the RFC's deterministic nonce generation and aggregated signing protocol to produce a standard ECVRF proof.
  - Ensure network auth (mTLS, IAM, or firewall rules) and strict ACLs for the signer endpoint.

- **Next steps for a secure HSM/MPC integration**:
  1. Evaluate KMS/HSM support for secp256k1 private operations (CloudHSM, Azure, YubiHSM, or on-prem HSM).
  2. If HSM supports raw EC multiply/sign with secp256k1, implement the ECVRF arithmetic inside the HSM or call HSM primitives where possible.
  3. For MPC, select a threshold-ECDSA/MPC library and design the signing protocol for VRF proof generation (research and external crypto review required).
  4. Add authenticated transport (mTLS) and service-level access controls for the signer.
  5. Implement side-channel protections and audit logging.

- **Files added/modified**:
  - `artifacts/api-server/src/lib/vrfSigner.ts` — PoC signer app creator
  - `artifacts/api-server/scripts/start_vrf_signer.mjs` — launcher
  - `artifacts/api-server/package.json` — `vrf-signer` script added
  - `docs/VRF_SIGNER_POC.md` — this document

- **Hardened deployment options (mTLS, API key, KMS public-key endpoint)**

  - Environment variables supported by the PoC signer:
    - `VRF_SIGNER_TLS_KEY_PATH` — path to server TLS private key (PEM)
    - `VRF_SIGNER_TLS_CERT_PATH` — path to server TLS certificate (PEM)
    - `VRF_SIGNER_CLIENT_CA_PATH` — CA bundle used to validate client certificates (enables mTLS)
    - `VRF_SIGNER_REQUIRE_CLIENT_CERT=1` — require and verify client TLS certificates
    - `VRF_SIGNER_API_KEY` — shared API key value for simple bearer authentication
    - `VRF_SIGNER_REQUIRE_API_KEY=1` — require the API key for all endpoints
    - `KMS_PROVIDER=aws` and `KMS_AWS_VRF_KEY_ID` — when set, the `/publicKey` endpoint will attempt to return the VRF public key directly from AWS KMS via `GetPublicKey` (no private key disclosure)
     - `ORACLE_SIGNER_URL` — base URL of an external oracle signer to delegate Ed25519 signing for on‑chain proofs and txs. When set the server prefers the remote signer for `signProofMessage` and `signTransactionHash`.

    Additional endpoints exposed by the PoC signer (useful when running the signer as a remote oracle):
      - `GET /oraclePublicKey` — returns the oracle Ed25519 public key used for on‑chain signature verification.
      - `POST /signProof` — body: `{ messageHex }` → returns `{ signature }` where `signature` is hex encoded Ed25519 signature of the message.
      - `POST /signTx` — body: `{ messageHex }` → returns `{ signature }` where `signature` signs the transaction digest for remote tx signing.

  - Example: start signer with API-key and HTTPS (self-signed certs) on Windows PowerShell

    1) Generate a local CA and server cert (OpenSSL required):

    ```powershell
    # Create CA
    openssl genrsa -out ca.key 2048
    openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 -subj "/CN=local-ca" -out ca.pem

    # Create server key and CSR
    openssl genrsa -out server.key 2048
    openssl req -new -key server.key -subj "/CN=127.0.0.1" -out server.csr

    # Sign server cert with CA
    openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out server.crt -days 365 -sha256
    ```

    2) Start the signer with TLS and API key:

    ```powershell
    $env:VRF_PRIVATE_KEY_HEX = "<your_test_sec_hex>"
    $env:VRF_SIGNER_TLS_KEY_PATH = "C:\path\to\server.key"
    $env:VRF_SIGNER_TLS_CERT_PATH = "C:\path\to\server.crt"
    $env:VRF_SIGNER_CLIENT_CA_PATH = "C:\path\to\ca.pem"   # optional, required if using client certs
    $env:VRF_SIGNER_API_KEY = "super-secret-key"
    $env:VRF_SIGNER_REQUIRE_API_KEY = "1"
    node .\artifacts\api-server\scripts\start_vrf_signer.mjs
    ```

    3) Test the `/publicKey` endpoint with curl (in PowerShell using OpenSSL CA):

    ```powershell
    curl -k --header "x-api-key: super-secret-key" https://127.0.0.1:6060/publicKey
    ```

    4) If you enabled mTLS (client cert verification), create a client cert signed by `ca.pem` and pass it to curl:

    ```powershell
    # Create client key + CSR
    openssl genrsa -out client.key 2048
    openssl req -new -key client.key -subj "/CN=client" -out client.csr
    openssl x509 -req -in client.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out client.crt -days 365 -sha256

    # Call with client cert
    curl -k --cert client.crt --key client.key --header "x-api-key: super-secret-key" https://127.0.0.1:6060/publicKey
    ```

  - Notes:
    - Use real CA-signed certificates and mTLS in production. The self-signed flow above is for local testing only.
    - `KMS_AWS_VRF_KEY_ID` requires an AWS KMS asymmetric key that supports `GetPublicKey`. If your provider doesn't support secp256k1, you'll need to store the VRF private key in a secure store (Secrets Manager) accessed only by the signer process.


