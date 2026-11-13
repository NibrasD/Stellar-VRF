/**
 * vrf.ts — Off-chain BLS-VRF proof generation (V2)
 *
 * Implements the same cryptographic operations that the on-chain contract
 * verifies, from the oracle's side (it knows the secret key of the request's
 * epoch).
 *
 * Pipeline:
 *   1. alpha = sha256(request_id ‖ context ‖ round ‖ sha256(drand_sig) ‖ epoch_id)
 *   2. H     = hash_to_g1(alpha, VRF_DST)
 *   3. gamma = sk · H
 *   4. beta  = sha256(BETA_DOMAIN ‖ gamma_bytes)
 *
 * There is no separate signature: the operator account's Soroban authorization
 * of `fulfill()` covers every argument. The BLS public key is not sent either:
 * the contract reads it from the request's epoch.
 */

import { bls12_381 } from "@noble/curves/bls12-381";
import { sha256 } from "@noble/hashes/sha256";
import { VRF_DST, BETA_DOMAIN } from "./config.js";
import { u64ToBeBytes, u32ToBeBytes, concat, bytesToHex, log } from "./utils.js";
import type { DrandBeacon } from "./drand.js";
import type { OracleKeySet } from "./keys.js";

export interface VrfProofData {
  alphaSeed: Buffer; // 32 bytes
  gammaPoint: Buffer; // 96 bytes (uncompressed G1 affine)
  betaOutput: Buffer; // 32 bytes
  drandRound: bigint;
  drandSignature: Buffer; // 96 bytes (uncompressed G1 affine, from drand)
}

/**
 * Generate the proof for a request.
 *
 * @param requestId - On-chain request id
 * @param context   - Request context bytes (from contract storage)
 * @param beacon    - drand beacon of the request's bound round
 * @param epochId   - Key epoch the request is bound to (`RequestEpoch(id)`)
 * @param keys      - The key set registered for that epoch
 */
export function generateVrfProof(
  requestId: bigint,
  context: Buffer,
  beacon: DrandBeacon,
  epochId: number,
  keys: OracleKeySet
): VrfProofData {
  const drandRound = BigInt(beacon.round);

  // drand serves the G1 signature compressed (48 bytes); the contract takes
  // the uncompressed affine encoding (96 bytes) and hashes those bytes.
  const drandSigBytes = Buffer.from(
    bls12_381.G1.ProjectivePoint.fromHex(beacon.signature).toRawBytes(false)
  );

  const alphaSeed = Buffer.from(
    sha256(
      concat(
        u64ToBeBytes(requestId),
        context,
        u64ToBeBytes(drandRound),
        Buffer.from(sha256(drandSigBytes)),
        u32ToBeBytes(epochId)
      )
    )
  );

  const h = bls12_381.G1.hashToCurve(alphaSeed, { DST: new TextEncoder().encode(VRF_DST) }) as any;
  const gammaPoint = Buffer.from(h.multiply(keys.blsSecret).toRawBytes(false));
  const betaOutput = Buffer.from(
    sha256(concat(Buffer.from(BETA_DOMAIN, "utf-8"), gammaPoint))
  );

  log.info(
    `  VRF proof for request ${requestId} (epoch ${epochId}, ${keys.label} keys, round ${drandRound}): ` +
      `beta ${bytesToHex(betaOutput).slice(0, 16)}…`
  );

  return { alphaSeed, gammaPoint, betaOutput, drandRound, drandSignature: drandSigBytes };
}
