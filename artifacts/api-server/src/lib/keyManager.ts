// keyManager.ts — key access abstraction.
// Supports local env-based keys by default; optional KMS provider (AWS KMS)
// can be configured via env `KMS_PROVIDER=aws` and provider-specific env vars.

import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/curves/utils.js";

let provider = process.env.KMS_PROVIDER || "env";

// Lazy AWS client (only imported when provider=aws)
let awsKmsClient: any = null;
let awsKeyId: string | undefined = process.env.KMS_AWS_KEY_ID;
let awsSecretsClient: any = null;
let awsVrfSecretArn: string | undefined = process.env.KMS_AWS_VRF_SECRET_ARN;
let awsVrfKeyId: string | undefined = process.env.KMS_AWS_VRF_KEY_ID;
let cachedVrfPrivateKeyHex: string | undefined = undefined;

// Mock/local KMS keypair (for local development and tests when KMS_PROVIDER=mock)
let mockKeypair: Keypair | undefined = undefined;

function requireRemoteSignerInProduction() {
  const mustRequire = process.env.REQUIRE_REMOTE_SIGNER === "1" || process.env.NODE_ENV === "production";
  if (mustRequire && !process.env.ORACLE_SIGNER_URL) {
    throw new Error("Remote signer is required in production (set ORACLE_SIGNER_URL).");
  }
}

function isRemoteSignerStrict(): boolean {
  return process.env.REQUIRE_REMOTE_SIGNER === "1" || process.env.NODE_ENV === "production";
}

function auditKeyUsage(action: string, providerName: string) {
  // Lightweight audit trail for key usage operations.
  // Route these logs to SIEM in production.
  console.info(`[key-audit] action=${action} provider=${providerName} ts=${new Date().toISOString()}`);
}

function ensureMockKeypair(): Keypair {
  if (mockKeypair) return mockKeypair;
  const seed = process.env.MOCK_ORACLE_STELLAR_SEED || process.env.ORACLE_STELLAR_SEED;
  if (seed) {
    mockKeypair = Keypair.fromSecret(seed);
  } else {
    mockKeypair = Keypair.random();
  }
  return mockKeypair;
}

export async function init(): Promise<void> {
  requireRemoteSignerInProduction();
  provider = process.env.KMS_PROVIDER || provider;
  if (provider === "aws") {
    const { KMSClient } = await import("@aws-sdk/client-kms");
    const region = process.env.AWS_REGION || "us-east-1";
    awsKmsClient = new KMSClient({ region });
    if (!awsKeyId) {
      throw new Error("KMS_PROVIDER=aws but KMS_AWS_KEY_ID is not set");
    }
    const { SecretsManagerClient } = await import("@aws-sdk/client-secrets-manager");
    awsSecretsClient = new SecretsManagerClient({ region });
    // awsVrfSecretArn may be undefined; functions that need VRF key will check it
    // Optionally pre-load VRF private key from Secrets Manager into memory
    if (awsVrfSecretArn) {
      try {
        const v = await getVrfPrivateKeyHexAsync();
        cachedVrfPrivateKeyHex = v;
      } catch (e) {
        // non-fatal: initialization can continue without cached secret
      }
    }
  }
}

export function getVrfPrivateKeyHex(): string {
  if (provider === "env") {
    const env = process.env.VRF_PRIVATE_KEY_HEX;
    if (env && env.trim().length > 0) return env.trim();
    throw new Error("Missing VRF_PRIVATE_KEY_HEX environment variable");
  }
  if (provider === "mock") {
    const env = process.env.VRF_PRIVATE_KEY_HEX;
    if (env && env.trim().length > 0) return env.trim();
    throw new Error("Missing VRF_PRIVATE_KEY_HEX environment variable for mock provider");
  }
  if (provider === "aws") {
    if (cachedVrfPrivateKeyHex) return cachedVrfPrivateKeyHex;
    throw new Error("VRF private key not loaded into memory; call keyManager.init() or use VRF_PRIVATE_KEY_HEX env var");
  }
  throw new Error("Unsupported KMS provider: " + provider);
}

export async function getVrfPrivateKeyHexAsync(): Promise<string> {
  if (provider === "env") {
    const env = process.env.VRF_PRIVATE_KEY_HEX;
    if (env && env.trim().length > 0) return env.trim();
    throw new Error("Missing VRF_PRIVATE_KEY_HEX environment variable");
  }
  if (provider === "mock") {
    const env = process.env.VRF_PRIVATE_KEY_HEX;
    if (env && env.trim().length > 0) return env.trim();
    throw new Error("Missing VRF_PRIVATE_KEY_HEX environment variable for mock provider");
  }
  if (provider === "aws") {
    if (!awsSecretsClient) await init();
    if (!awsVrfSecretArn) throw new Error("KMS_AWS_VRF_SECRET_ARN not configured; cannot retrieve VRF private key from Secrets Manager");
    const { GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
    const cmd = new GetSecretValueCommand({ SecretId: awsVrfSecretArn });
    const resp = await awsSecretsClient.send(cmd);
    if (!resp.SecretString) throw new Error("Secrets Manager returned empty secret for VRF key");
    // Expect the secret string to be the raw hex value
    return resp.SecretString.trim();
  }
  throw new Error("Unsupported KMS provider: " + provider);
}

export function getOracleStellarSeed(): string {
  if (provider !== "env" && provider !== "mock") {
    throw new Error("Local oracle seed not available when KMS provider is enabled. Use keyManager.getOraclePublicKey() and keyManager.signProofMessage().");
  }
  const env = process.env.ORACLE_STELLAR_SEED || process.env.MOCK_ORACLE_STELLAR_SEED;
  if (env && env.trim().length > 0) return env.trim();
  throw new Error("Missing ORACLE_STELLAR_SEED environment variable");
}

export function getLocalOracleKeypair(): Keypair | undefined {
  if (provider === "env") {
    const seed = process.env.ORACLE_STELLAR_SEED;
    if (!seed) return undefined;
    return Keypair.fromSecret(seed);
  }
  if (provider === "mock") {
    return ensureMockKeypair();
  }
  return undefined;
}

export async function getOraclePublicKey(): Promise<string> {
  requireRemoteSignerInProduction();
  // If a remote oracle signer URL is configured, prefer it for oracle public key
  const oracleSignerUrl = process.env.ORACLE_SIGNER_URL;
  if (oracleSignerUrl) {
    try {
      const url = new URL('/oraclePublicKey', oracleSignerUrl).toString();
      const resp = await fetch(url, { headers: { Accept: 'application/json' } });
      if (resp.ok) {
        const j: any = await resp.json();
        if (j && j.publicKey) return j.publicKey;
      }
    } catch {
      // ignore and fall through to local/key-provider methods
    }
    if (isRemoteSignerStrict()) {
      throw new Error("Remote signer is required and oracle public key retrieval failed.");
    }
  }
  if (provider === "env") {
    const kp = getLocalOracleKeypair();
    if (!kp) throw new Error("Missing ORACLE_STELLAR_SEED environment variable");
    return kp.publicKey();
  }
  if (provider === "mock") {
    const kp = ensureMockKeypair();
    return kp.publicKey();
  }
  if (provider === "aws") {
    if (!awsKmsClient) await init();
    const { GetPublicKeyCommand } = await import("@aws-sdk/client-kms");
    const cmd = new GetPublicKeyCommand({ KeyId: awsKeyId });
    const resp = await awsKmsClient.send(cmd);
    if (!resp.PublicKey) throw new Error("KMS GetPublicKey returned no public key");
    const pub = Buffer.from(resp.PublicKey as Uint8Array);
    return StrKey.encodeEd25519PublicKey(pub);
  }
  throw new Error("Unsupported KMS provider: " + provider);
}

export async function getVrfPublicKeyAsync(): Promise<string> {
  // Return the VRF public key (compressed hex) without exposing the private key.
  if (provider === "env" || provider === "mock") {
    const env = process.env.VRF_PRIVATE_KEY_HEX;
    if (!env) throw new Error("Missing VRF_PRIVATE_KEY_HEX environment variable");
    const pk = secp256k1.getPublicKey(hexToBytes(env), true);
    return bytesToHex(pk);
  }
  if (provider === "aws") {
    if (!awsKmsClient) await init();
    const keyId = awsVrfKeyId || process.env.KMS_AWS_VRF_KEY_ID;
    if (!keyId) throw new Error("KMS provider configured but KMS_AWS_VRF_KEY_ID not set");
    const { GetPublicKeyCommand } = await import("@aws-sdk/client-kms");
    const cmd = new GetPublicKeyCommand({ KeyId: keyId });
    const resp = await awsKmsClient.send(cmd);
    if (!resp.PublicKey) throw new Error("KMS GetPublicKey returned no public key");
    const pub = Buffer.from(resp.PublicKey as Uint8Array);
    return pub.toString("hex");
  }
  throw new Error("Unsupported KMS provider: " + provider);
}

export async function signProofMessage(message: Buffer): Promise<Buffer> {
  requireRemoteSignerInProduction();
  // If an external oracle signer is configured, delegate signing to it.
  const oracleSignerUrl = process.env.ORACLE_SIGNER_URL;
  if (oracleSignerUrl) {
    try {
      const url = new URL('/signProof', oracleSignerUrl).toString();
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Accept: 'application/json', 'x-api-key': process.env.VRF_SIGNER_API_KEY || process.env.ORACLE_SIGNER_API_KEY || '' },
        body: JSON.stringify({ messageHex: message.toString('hex') }),
      });
      if (!resp.ok) throw new Error(`oracle signer responded: ${resp.status}`);
        const j: any = await resp.json();
      if (!j || !j.signature) throw new Error('oracle signer returned no signature');
      auditKeyUsage("sign_proof_remote", "remote");
      return Buffer.from(j.signature, 'hex');
    } catch (e) {
      // fall back to provider-based signing if remote signer fails
    }
    if (isRemoteSignerStrict()) {
      throw new Error("Remote signer is required and signProof delegation failed.");
    }
  }
  // Sign the proof message (Ed25519) used for on-chain verification.
  if (provider === "env") {
    auditKeyUsage("sign_proof_local", "env");
    const kp = getLocalOracleKeypair();
    if (!kp) throw new Error("Missing ORACLE_STELLAR_SEED environment variable for local signing");
    return Buffer.from(kp.sign(message));
  }
  if (provider === "mock") {
    auditKeyUsage("sign_proof_local", "mock");
    const kp = ensureMockKeypair();
    return Buffer.from(kp.sign(message));
  }
  if (provider === "aws") {
    if (!awsKmsClient) await init();
    const { SignCommand } = await import("@aws-sdk/client-kms");
    const cmd = new SignCommand({
      KeyId: awsKeyId,
      Message: message,
      MessageType: "RAW",
      SigningAlgorithm: "Ed25519" as any,
    });
    const resp = await awsKmsClient.send(cmd);
    if (!resp.Signature) throw new Error("KMS Sign returned no signature");
    auditKeyUsage("sign_proof_kms", "aws");
    return Buffer.from(resp.Signature as Uint8Array);
  }
  throw new Error("Unsupported KMS provider: " + provider);
}

export async function signTransactionHash(hash: Buffer): Promise<Buffer> {
  requireRemoteSignerInProduction();
  // If an external oracle signer is configured, delegate transaction signing to it.
  const oracleSignerUrl = process.env.ORACLE_SIGNER_URL;
  if (oracleSignerUrl) {
    try {
      const url = new URL('/signTx', oracleSignerUrl).toString();
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Accept: 'application/json', 'x-api-key': process.env.VRF_SIGNER_API_KEY || process.env.ORACLE_SIGNER_API_KEY || '' },
        body: JSON.stringify({ messageHex: hash.toString('hex') }),
      });
      if (!resp.ok) throw new Error(`oracle signer responded: ${resp.status}`);
        const j: any = await resp.json();
      if (!j || !j.signature) throw new Error('oracle signer returned no signature');
      auditKeyUsage("sign_tx_remote", "remote");
      return Buffer.from(j.signature, 'hex');
    } catch (e) {
      // fall back to provider-based signing if remote signer fails
    }
    if (isRemoteSignerStrict()) {
      throw new Error("Remote signer is required and signTx delegation failed.");
    }
  }
  // Alias for transaction signing using the same KMS Sign API (ED25519)
  if (provider === "env") {
    auditKeyUsage("sign_tx_local", "env");
    const kp = getLocalOracleKeypair();
    if (!kp) throw new Error("Missing ORACLE_STELLAR_SEED environment variable for local signing");
    return Buffer.from(kp.sign(hash));
  }
  if (provider === "mock") {
    auditKeyUsage("sign_tx_local", "mock");
    const kp = ensureMockKeypair();
    return Buffer.from(kp.sign(hash));
  }
  if (provider === "aws") {
    if (!awsKmsClient) await init();
    const { SignCommand } = await import("@aws-sdk/client-kms");
    const cmd = new SignCommand({
      KeyId: awsKeyId,
      Message: hash,
      MessageType: "DIGEST",
      SigningAlgorithm: "Ed25519" as any,
    });
    const resp = await awsKmsClient.send(cmd);
    if (!resp.Signature) throw new Error("KMS Sign returned no signature");
    auditKeyUsage("sign_tx_kms", "aws");
    return Buffer.from(resp.Signature as Uint8Array);
  }
  throw new Error("Unsupported KMS provider: " + provider);
}

// Transaction signing via remote KMS is not implemented here. For now the
// server supports local transaction signing via `ORACLE_STELLAR_SEED`.

export default { init, getVrfPrivateKeyHex, getVrfPrivateKeyHexAsync, getOracleStellarSeed, getLocalOracleKeypair, getOraclePublicKey, getVrfPublicKeyAsync, signProofMessage, signTransactionHash };
