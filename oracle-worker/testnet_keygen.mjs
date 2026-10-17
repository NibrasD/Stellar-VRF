/**
 * testnet_keygen.mjs — create an ISOLATED set of Testnet oracle credentials.
 *
 * Generates a brand-new Stellar keypair and a brand-new BLS12-381 key, funds the
 * account through Friendbot, and writes everything to `.env.testnet`
 * (git-ignored, mode 0600 on POSIX). Nothing here is ever derived from, or
 * shared with, the Mainnet oracle.
 *
 * Only PUBLIC values are printed. Secrets go to the file and nowhere else.
 *
 * Usage:  node testnet_keygen.mjs [--out <path>] [--no-fund]
 *         (refuses to overwrite an existing file)
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { Keypair } from "@stellar/stellar-sdk";
import { bls12_381 } from "@noble/curves/bls12-381";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const OUT = path.resolve(outIdx >= 0 ? argv[outIdx + 1] : path.join(__dirname, ".env.testnet"));
const FUND = !argv.includes("--no-fund");

// The Mainnet oracle must never be reused on Testnet.
const MAINNET_ORACLE = "GA6HYAVWPVOVB4XJHGUZSDHRVYOKLPU4JAHYPXZRSJWO2PM4HSCNKP5P";

if (fs.existsSync(OUT)) {
  console.error(`REFUSING to overwrite existing ${OUT}. Move it away first.`);
  process.exit(1);
}

const kp = Keypair.random();
if (kp.publicKey() === MAINNET_ORACLE) throw new Error("impossible: generated the Mainnet key");

const n = bls12_381.G2.CURVE.n;
let sk;
do {
  sk = BigInt("0x" + crypto.randomBytes(32).toString("hex")) % n;
} while (sk === 0n);
const skHex = sk.toString(16).padStart(64, "0");
const blsPk = Buffer.from(bls12_381.G2.ProjectivePoint.BASE.multiply(sk).toRawBytes(false)).toString("hex");

const env = `# Stellar VRF — TESTNET oracle worker. Generated ${new Date().toISOString()}.
# ISOLATED from Mainnet: separate Stellar account, separate BLS key. Never reuse
# any value from the Mainnet .env here, and never copy this file to a Mainnet host.
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
NETWORK_PASSPHRASE=Test SDF Network ; September 2015
# Filled in after testnet_deploy.mjs:
CONTRACT_ADDRESS=

ORACLE_STELLAR_SECRET=${kp.secret()}
ORACLE_BLS_SECRET_KEY=${skHex}

DRAND_CHAIN_HASH=52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971
DRAND_API_URL=https://api.drand.sh
DRAND_GENESIS_TIME=1692803367
DRAND_PERIOD=3
# DRAND_PUBLIC_KEY is deliberately left unset: the worker's built-in default is the
# quicknet key and beacon verification stays ON.
DRAND_VERIFY_BEACONS=true

INSTANCE_ID=oracle-testnet
HEALTH_PORT=8080
# Distinct Redis key names, so even an accidental shared Redis can't mix state with Mainnet.
LEADER_REDIS_KEY=vrf-oracle-testnet:leader
FEE_GUARD_REDIS_KEY=vrf-oracle-testnet:unpaid-spend
# Redis is set per host (see docs/TESTNET_OPERATIONS.md); the Testnet Redis must be
# a different instance from Mainnet's.
# REDIS_URL=
`;

fs.writeFileSync(OUT, env, { mode: 0o600, flag: "wx" });
console.log("Testnet oracle credentials written to:", OUT);
console.log("  Stellar account :", kp.publicKey());
console.log("  BLS public key  :", blsPk.slice(0, 32) + "…");

if (FUND) {
  const r = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
  console.log(`  Friendbot       : HTTP ${r.status}${r.ok ? " (funded)" : " (FAILED — fund manually)"}`);
}
console.log("\nNext: node testnet_deploy.mjs");
