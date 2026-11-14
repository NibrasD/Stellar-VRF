/**
 * keys.ts — the oracle's key sets, one per contract key epoch it can serve.
 *
 * In V2 every request is bound to the key epoch that was active when it was
 * created, and `fulfill()` verifies against THAT epoch's BLS key and requires
 * THAT epoch's operator account. After a rotation, requests created before it
 * must still be fulfilled with the old keys. The worker therefore holds:
 *
 *   - `current`  (ORACLE_STELLAR_SECRET / ORACLE_BLS_SECRET_KEY), and
 *   - optionally `previous` (ORACLE_PREVIOUS_STELLAR_SECRET /
 *     ORACLE_PREVIOUS_BLS_SECRET_KEY) during the hand-over window.
 *
 * For each request the worker reads the request's epoch from the contract and
 * picks the key set whose BLS public key AND operator account match it.
 *
 * Pure module (no environment access) so it can be unit-tested.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { bls12_381 } from "@noble/curves/bls12-381";

export interface OracleKeySet {
  label: "current" | "previous";
  stellar: Keypair;
  blsSecret: bigint;
  /** 192-byte uncompressed G2 public key. */
  blsPublicKey: Uint8Array;
}

/** What the contract stores for an epoch (the parts the worker needs). */
export interface EpochKeys {
  oraclePk: Uint8Array;
  oracleAddress: string;
}

/** BLS12-381 G2 public key (uncompressed, 192 bytes) for a secret scalar. */
export function blsPublicKeyOf(secret: bigint): Uint8Array {
  return bls12_381.G2.ProjectivePoint.BASE.multiply(secret).toRawBytes(false);
}

export function parseBlsSecret(hex: string, envName: string): bigint {
  const clean = hex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,64}$/.test(clean)) {
    throw new Error(`${envName} must be a hex scalar (up to 64 hex chars)`);
  }
  const s = BigInt("0x" + clean);
  if (s <= 1n || s >= bls12_381.fields.Fr.ORDER) {
    throw new Error(`${envName} must be in [2, r)`);
  }
  return s;
}

export function makeKeySet(
  label: OracleKeySet["label"],
  stellarSecret: string,
  blsSecretHex: string,
  blsEnvName: string
): OracleKeySet {
  const blsSecret = parseBlsSecret(blsSecretHex, blsEnvName);
  return {
    label,
    stellar: Keypair.fromSecret(stellarSecret),
    blsSecret,
    blsPublicKey: blsPublicKeyOf(blsSecret),
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The key set that can fulfill requests of `epoch`, or null if none can. */
export function selectKeySet(keys: OracleKeySet[], epoch: EpochKeys): OracleKeySet | null {
  return (
    keys.find(
      (k) => sameBytes(k.blsPublicKey, epoch.oraclePk) && k.stellar.publicKey() === epoch.oracleAddress
    ) ?? null
  );
}
