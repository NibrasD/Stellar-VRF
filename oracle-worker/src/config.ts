/**
 * config.ts — Oracle Worker configuration loader
 * Reads from environment variables (.env file supported via dotenv).
 */

import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

// Load .env robustly, independent of the current working directory.
// Under process managers like PM2 the cwd is often NOT the worker folder, so
// `import "dotenv/config"` (which only checks cwd) silently finds nothing and
// every required variable ends up missing. We resolve the worker root from
// this compiled file's location (dist/ -> worker root) and also honor an
// explicit DOTENV_PATH override.
const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  process.env.DOTENV_PATH,                 // explicit override, if set
  path.resolve(here, "../.env"),           // dist/config.js  -> ../.env
  path.resolve(here, "../../.env"),        // src/config.ts   -> ../../.env (ts-node/tsx)
  path.resolve(process.cwd(), ".env"),     // cwd fallback
].filter(Boolean) as string[];

for (const p of candidates) {
  if (fs.existsSync(p)) {
    loadDotenv({ path: p });
    break;
  }
}

import { Keypair, Networks } from "@stellar/stellar-sdk";
import { drandVerificationPolicyError, redisPolicyError } from "./policy.js";

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

/**
 * drand group public key for the configured chain, as a **compressed G2 point**
 * (96 bytes / 192 hex chars). This is the `public_key` field returned by
 * `GET {DRAND_API_URL}/{DRAND_CHAIN_HASH}/info`.
 *
 * Default = quicknet (`bls-unchained-g1-rfc9380`). If `DRAND_CHAIN_HASH` is
 * overridden, `DRAND_PUBLIC_KEY` MUST be overridden to match.
 *
 * Note this is the compressed encoding, while the contract's `DrandPK` storage
 * slot holds the same key uncompressed (192 bytes) — both describe the same
 * group key, so an off-chain check here and the on-chain pairing check agree.
 */
export const DRAND_PUBLIC_KEY = optionalEnv(
  "DRAND_PUBLIC_KEY",
  "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c" +
    "3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab" +
    "4af5a6e9c76a4bc09e76eae8991ef5ece45a"
);

/**
 * Verify every fetched drand beacon's BLS signature locally before using it.
 *
 * The contract re-verifies the drand signature on-chain, so a forged beacon can
 * never produce accepted randomness. Verifying here closes a *resource* hole
 * instead: without it a compromised or buggy relay can feed the worker garbage,
 * and the worker will happily spend CPU on a BLS-VRF proof and submit a
 * transaction that is guaranteed to be rejected on-chain — wasting fees on
 * every request. Disable only for local debugging: startup REFUSES `false` on
 * Mainnet or with `NODE_ENV=production` (see policy.ts).
 */
export const DRAND_VERIFY_BEACONS =
  optionalEnv("DRAND_VERIFY_BEACONS", "true").toLowerCase() !== "false";

{
  const policyError = drandVerificationPolicyError(
    DRAND_VERIFY_BEACONS,
    NETWORK_PASSPHRASE,
    process.env.NODE_ENV
  );
  if (policyError) throw new Error(policyError);
}

{
  const redisError = redisPolicyError(
    process.env.REDIS_URL,
    NETWORK_PASSPHRASE,
    process.env.NODE_ENV,
    process.env.REDIS_ALLOW_PLAINTEXT
  );
  if (redisError) throw new Error(redisError);
}

/** drand DST for quicknet (`bls-unchained-g1-rfc9380`); matches DRAND_DST on-chain. */
export const DRAND_DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";

// Fail fast on a malformed key rather than surfacing it as a verification
// failure on the first request (which would look like a relay problem).
if (DRAND_VERIFY_BEACONS) {
  if (!/^[0-9a-fA-F]{192}$/.test(DRAND_PUBLIC_KEY)) {
    throw new Error(
      `DRAND_PUBLIC_KEY must be 192 hex chars (96-byte compressed G2 point), got ` +
        `${DRAND_PUBLIC_KEY.length} chars. Fetch it with: ` +
        `curl -s ${DRAND_API_URL}/${DRAND_CHAIN_HASH}/info`
    );
  }
}

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
  console.log(
    `║ drand verify: ${
      DRAND_VERIFY_BEACONS
        ? `ON (pk ${DRAND_PUBLIC_KEY.slice(0, 16)}…)`
        : "OFF — NOT FOR PRODUCTION"
    }`
  );
  console.log(`║ Poll:       ${POLL_INTERVAL_MS}ms`);
  console.log(`║ Retries:    ${MAX_RETRIES}`);
  console.log("╚═══════════════════════════════════════════════════════════╝");
}
