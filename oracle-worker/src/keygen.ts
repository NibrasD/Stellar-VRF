/**
 * keygen.ts — BLS12-381 keypair generator for the oracle
 *
 * Generates a random BLS12-381 private key (scalar) and derives the
 * corresponding G2 public key. Output is hex-encoded for use in .env
 * and contract initialization.
 *
 * Usage: npm run keygen
 */

import { bls12_381 } from "@noble/curves/bls12-381";
import crypto from "crypto";

function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  BLS12-381 Oracle Keypair Generator");
  console.log("═══════════════════════════════════════════════════════\n");

  // Generate a random 32-byte scalar as the private key
  const secretBytes = crypto.randomBytes(32);
  const secretHex = secretBytes.toString("hex");

  // The scalar must be reduced modulo the BLS12-381 curve order
  const secretBigInt = BigInt("0x" + secretHex) % bls12_381.G2.CURVE.n;
  const secretReducedHex = secretBigInt.toString(16).padStart(64, "0");

  // Derive the G2 public key
  const publicKeyPoint = bls12_381.G2.ProjectivePoint.BASE.multiply(secretBigInt);
  const publicKeyBytes = publicKeyPoint.toRawBytes(false); // 192 bytes uncompressed
  const publicKeyHex = Buffer.from(publicKeyBytes).toString("hex");

  console.log("🔑 Private Key (add to .env as ORACLE_BLS_SECRET_KEY):");
  console.log(`   ${secretReducedHex}\n`);

  console.log("🔓 Public Key (192 bytes, use in contract init as oracle_pk):");
  console.log(`   ${publicKeyHex}\n`);

  console.log("📋 For deploy.mjs, set ORACLE_PK_HEX to the public key above.");
  console.log("   Then re-deploy the contract with the new key.\n");

  // Verify the keypair by checking that PK = sk * G2
  const verifyPoint = bls12_381.G2.ProjectivePoint.BASE.multiply(secretBigInt);
  const verifyHex = Buffer.from(verifyPoint.toRawBytes(false)).toString("hex");
  if (verifyHex === publicKeyHex) {
    console.log("✔  Keypair verification: PASSED");
  } else {
    console.log("✖  Keypair verification: FAILED (this should never happen)");
    process.exit(1);
  }

  console.log("\n═══════════════════════════════════════════════════════\n");
}

main();
