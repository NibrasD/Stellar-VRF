/**
 * config.ts — Oracle Worker configuration loader
 * Reads from environment variables (.env file supported via dotenv).
 */

import "dotenv/config";
import { Keypair, Networks } from "@stellar/stellar-sdk";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

// ─── Stellar / Soroban ──────────────────────────────────────────────────────

export const SOROBAN_RPC_URL = optionalEnv(
  "SOROBAN_RPC_URL",
  "https://soroban-testnet.stellar.org"
);

export const NETWORK_PASSPHRASE = optionalEnv(
  "NETWORK_PASSPHRASE",
  Networks.TESTNET
);

export const CONTRACT_ADDRESS = requireEnv("CONTRACT_ADDRESS");

// Oracle Stellar keypair (Ed25519)
const oracleStellarSecret = requireEnv("ORACLE_STELLAR_SECRET");
export const ORACLE_KEYPAIR = Keypair.fromSecret(oracleStellarSecret);
export const ORACLE_PUBLIC_KEY = ORACLE_KEYPAIR.publicKey();
export const ORACLE_ED25519_PK = ORACLE_KEYPAIR.rawPublicKey(); // 32 bytes

// Oracle BLS12-381 private key (scalar)
export const ORACLE_BLS_SECRET_HEX = requireEnv("ORACLE_BLS_SECRET_KEY");
export const ORACLE_BLS_SECRET = BigInt("0x" + ORACLE_BLS_SECRET_HEX);

// ─── drand ──────────────────────────────────────────────────────────────────

export const DRAND_CHAIN_HASH = optionalEnv(
  "DRAND_CHAIN_HASH",
  "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971"
);

export const DRAND_API_URL = optionalEnv("DRAND_API_URL", "https://api.drand.sh");

export const DRAND_GENESIS_TIME = parseInt(
  optionalEnv("DRAND_GENESIS_TIME", "1692803367"),
  10
);

export const DRAND_PERIOD = parseInt(
  optionalEnv("DRAND_PERIOD", "3"),
  10
);

// ─── Worker tuning ──────────────────────────────────────────────────────────

export const POLL_INTERVAL_MS = parseInt(
  optionalEnv("POLL_INTERVAL_MS", "3000"),
  10
);

export const MAX_RETRIES = parseInt(optionalEnv("MAX_RETRIES", "3"), 10);

export const TX_FEE = optionalEnv("TX_FEE", "1000000");

// ─── Constants matching on-chain contract ───────────────────────────────────

export const VRF_DST = "SOROBAN_VRF_BLS12381G1_XMD:SHA-256_SSWU_RO_";
export const BETA_DOMAIN = "VREP_BETA_V1";

export function printConfig(): void {
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║          Soroban VRF Oracle Worker — Configuration       ║");
  console.log("╠═══════════════════════════════════════════════════════════╣");
  console.log(`║ RPC:        ${SOROBAN_RPC_URL}`);
  console.log(`║ Contract:   ${CONTRACT_ADDRESS}`);
  console.log(`║ Oracle:     ${ORACLE_PUBLIC_KEY}`);
  console.log(`║ Network:    ${NETWORK_PASSPHRASE}`);
  console.log(`║ drand API:  ${DRAND_API_URL}`);
  console.log(`║ Poll:       ${POLL_INTERVAL_MS}ms`);
  console.log(`║ Retries:    ${MAX_RETRIES}`);
  console.log("╚═══════════════════════════════════════════════════════════╝");
}
