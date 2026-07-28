/**
 * vrf.ts — Off-chain BLS-VRF proof generation
 *
 * Implements the same cryptographic operations that the on-chain contract
 * verifies, but from the oracle's perspective (knows the secret key).
 *
 * Pipeline:
 *   1. alpha = sha256(request_id || context || round || sha256(drand_sig))
 *   2. H     = hash_to_g1(alpha, VRF_DST)
 *   3. gamma = sk · H
 *   4. beta  = sha256(BETA_DOMAIN || gamma_bytes)
 *   5. Sign (request_id || alpha || gamma || beta || round || drand_sig) with Ed25519
 */

import { bls12_381 } from "@noble/curves/bls12-381";
import { sha256 } from "@noble/hashes/sha256";
import { Keypair } from "@stellar/stellar-sdk";
import {
  ORACLE_BLS_SECRET,
  VRF_DST,
  BETA_DOMAIN,
  ORACLE_KEYPAIR,
} from "./config.js";
import { u64ToBeBytes, concat, hexToBytes, bytesToHex, log } from "./utils.js";
import type { DrandBeacon } from "./drand.js";

export interface VrfProofData {
  alphaSeed: Buffer;       // 32 bytes
  gammaPoint: Buffer;      // 96 bytes (uncompressed G1 affine)
  betaOutput: Buffer;      // 32 bytes
  publicKey: Buffer;       // 192 bytes (uncompressed G2 affine)
  drandRound: bigint;
  drandSignature: Buffer;  // 96 bytes (uncompressed G1 affine, from drand)
  ed25519Signature: Buffer; // 64 bytes
}

/**
 * Derive the BLS12-381 G2 public key from the secret scalar.
 * Returns 192-byte uncompressed affine representation.
 */
export function deriveBlsPublicKey(): Buffer {
  const pk = bls12_381.G2.ProjectivePoint.BASE.multiply(ORACLE_BLS_SECRET);
  return Buffer.from(pk.toRawBytes(false)); // false = uncompressed
}

/**
 * Generate a complete VRF proof for a given request.
 *
 * @param requestId   - The on-chain request ID
 * @param context     - The request context bytes (fetched from contract storage)
 * @param beacon      - The drand beacon for the required round
 * @returns Complete proof data ready for the fulfill() transaction
 */
export function generateVrfProof(
  requestId: bigint,
  context: Buffer,
  beacon: DrandBeacon
): VrfProofData {
  const drandRound = BigInt(beacon.round);

  // Decompress drand G1 signature: 48 bytes compressed → 96 bytes uncompressed
  // The contract expects BytesN<96> (uncompressed G1 affine point)
  const drandSigPoint = bls12_381.G1.ProjectivePoint.fromHex(beacon.signature);
  const drandSigBytes = Buffer.from(drandSigPoint.toRawBytes(false)); // 96 bytes

  log.info(`  drand sig: ${drandSigBytes.length} bytes (uncompressed)`);

  // 1. Compute alpha_seed = sha256(request_id_be || context || round_be || sha256(drand_sig))
  // NOTE: the contract hashes the 96-byte uncompressed drand signature
  const drandRandomness = Buffer.from(sha256(drandSigBytes));
  const alphaInput = concat(
    u64ToBeBytes(requestId),
    context,
    u64ToBeBytes(drandRound),
    drandRandomness
  );
  const alphaSeed = Buffer.from(sha256(alphaInput));

  log.info(`  alpha_seed: ${bytesToHex(alphaSeed).slice(0, 16)}…`);

  // 2. H = hash_to_g1(alpha_seed, VRF_DST)
  const dst = new TextEncoder().encode(VRF_DST);
  const hPoint = bls12_381.G1.hashToCurve(alphaSeed, { DST: dst }) as any;

  // 3. gamma = sk * H
  const gammaPoint = hPoint.multiply(ORACLE_BLS_SECRET);
  const gammaBytes = Buffer.from(gammaPoint.toRawBytes(false)); // 96 bytes uncompressed

  log.info(`  gamma:      ${bytesToHex(gammaBytes).slice(0, 16)}…`);

  // 4. beta = sha256(BETA_DOMAIN || gamma_bytes)
  const betaDomainBytes = Buffer.from(BETA_DOMAIN, "utf-8");
  const betaOutput = Buffer.from(sha256(concat(betaDomainBytes, gammaBytes)));

  log.info(`  beta:       ${bytesToHex(betaOutput).slice(0, 16)}…`);

  // 5. Derive public key (G2 point, 192 bytes)
  const publicKey = deriveBlsPublicKey();

  // 6. Ed25519 signature over proof payload for oracle identity binding
  //    message = request_id_be || alpha_seed || gamma_bytes || beta_output || round_be || drand_sig_bytes
  const sigMessage = concat(
    u64ToBeBytes(requestId),
    alphaSeed,
    gammaBytes,
    betaOutput,
    u64ToBeBytes(drandRound),
    drandSigBytes
  );
  const ed25519Signature = Buffer.from(ORACLE_KEYPAIR.sign(sigMessage));

  log.success(
    `  VRF proof generated for request ${requestId}, round ${drandRound}`
  );

  return {
    alphaSeed,
    gammaPoint: gammaBytes,
    betaOutput,
    publicKey,
    drandRound,
    drandSignature: drandSigBytes,
    ed25519Signature,
  };
}
