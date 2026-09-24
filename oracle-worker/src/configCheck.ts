/**
 * configCheck.ts — the contract is the single source of truth for drand and
 * oracle-key configuration; the worker refuses to run when it disagrees.
 *
 * Why: the worker used to carry its own copy of drand genesis/period and
 * public key (env defaults), and index.ts even hard-coded the quicknet
 * genesis. If they drift from the contract's `DrandGenesis` / `DrandPeriod` /
 * `DrandPK` (e.g. after `rotate_drand_pk()`, or a deploy against another
 * chain), the worker waits for the wrong round, verifies beacons against the
 * wrong key, and pays for transactions the contract is certain to reject.
 * The same goes for an oracle BLS key that no longer matches `OraclePK`
 * after `rotate_oracle_keys()`.
 *
 * `compareChainConfig()` is pure (unit-tested); `verifyChainConfig()` reads
 * the contract and throws on any mismatch.
 */

import { bls12_381 } from "@noble/curves/bls12-381";

export interface LocalChainConfig {
  drandGenesisTime: number;
  drandPeriod: number;
  /** Compressed G2 (96 bytes), hex, as returned by drand `/info`. */
  drandPublicKeyHex: string;
  /** Oracle BLS public key derived from ORACLE_BLS_SECRET_KEY, 192 bytes uncompressed. */
  oracleBlsPublicKey: Uint8Array;
  /** Oracle Stellar account (G…). */
  oracleAddress: string;
}

export interface OnChainConfig {
  drandGenesis: bigint;
  drandPeriod: bigint;
  /** `DrandPK`, uncompressed G2 (192 bytes). */
  drandPk: Uint8Array;
  /** `OraclePK`, uncompressed G2 (192 bytes). */
  oraclePk: Uint8Array;
  /** `OracleAddr`. */
  oracleAddress: string;
}

function hex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

/** Compressed-or-uncompressed G2 hex → canonical uncompressed bytes. */
export function g2ToUncompressed(pkHex: string): Uint8Array {
  return bls12_381.G2.ProjectivePoint.fromHex(pkHex).toRawBytes(false);
}

/** Every mismatch between local configuration and contract state (empty = OK). */
export function compareChainConfig(local: LocalChainConfig, chain: OnChainConfig): string[] {
  const problems: string[] = [];
  if (BigInt(local.drandGenesisTime) !== chain.drandGenesis) {
    problems.push(
      `DRAND_GENESIS_TIME=${local.drandGenesisTime} but the contract's DrandGenesis is ${chain.drandGenesis}`
    );
  }
  if (BigInt(local.drandPeriod) !== chain.drandPeriod) {
    problems.push(`DRAND_PERIOD=${local.drandPeriod} but the contract's DrandPeriod is ${chain.drandPeriod}`);
  }
  let localDrand: string | null = null;
  try {
    localDrand = hex(g2ToUncompressed(local.drandPublicKeyHex));
  } catch (err) {
    problems.push(`DRAND_PUBLIC_KEY is not a valid G2 point: ${err instanceof Error ? err.message : err}`);
  }
  if (localDrand !== null && localDrand !== hex(chain.drandPk)) {
    problems.push(
      `DRAND_PUBLIC_KEY (${local.drandPublicKeyHex.slice(0, 16)}…) does not match the contract's DrandPK ` +
        `(${hex(chain.drandPk).slice(0, 16)}…, uncompressed); was rotate_drand_pk() called?`
    );
  }
  if (hex(local.oracleBlsPublicKey) !== hex(chain.oraclePk)) {
    problems.push(
      `ORACLE_BLS_SECRET_KEY derives ${hex(local.oracleBlsPublicKey).slice(0, 16)}… but the contract's ` +
        `OraclePK is ${hex(chain.oraclePk).slice(0, 16)}…; every proof would be rejected`
    );
  }
  if (local.oracleAddress !== chain.oracleAddress) {
    problems.push(
      `ORACLE_STELLAR_SECRET is ${local.oracleAddress} but the contract's OracleAddr is ${chain.oracleAddress}`
    );
  }
  return problems;
}

/** Throw a single descriptive error if the worker disagrees with the contract. */
export async function verifyChainConfig(
  local: LocalChainConfig,
  readChain: () => Promise<OnChainConfig>
): Promise<void> {
  const chain = await readChain();
  const problems = compareChainConfig(local, chain);
  if (problems.length > 0) {
    throw new Error(
      `Worker configuration does not match the deployed contract:\n  - ${problems.join("\n  - ")}\n` +
        `The contract is authoritative. Fix the environment (or set SKIP_CHAIN_CONFIG_CHECK=true ` +
        `for local debugging only; refused on Mainnet).`
    );
  }
}

/**
 * Production fee economics are defined in native XLM only.
 *
 * The contract accepts any token address as `fee_token`, but the worker can
 * only compare a fee with its own XLM costs when that token is the native XLM
 * SAC. Under any other token every request would be silently unpaid. So on
 * Mainnet (or with NODE_ENV=production) the worker refuses to start. Supporting
 * other SEP-41 fee tokens would need a price source, which this project doesn't
 * have. Returns an error message, or null when the token is acceptable.
 */
export function feeTokenPolicyError(
  feeToken: string,
  nativeTokenId: string,
  networkPassphrase: string,
  nodeEnv: string | undefined,
  mainnetPassphrase: string
): string | null {
  if (feeToken === nativeTokenId) return null;
  if (networkPassphrase === mainnetPassphrase || nodeEnv === "production") {
    return (
      `Contract FeeToken ${feeToken} is not the native XLM SAC (${nativeTokenId}). ` +
      `Production deployments must use native XLM as fee_token; the worker has no ` +
      `price for other tokens. Redeploy with the XLM SAC.`
    );
  }
  return null;
}

/** Mainnet (or NODE_ENV=production) must never skip the check. */
export function chainConfigSkipPolicyError(
  skip: boolean,
  networkPassphrase: string,
  nodeEnv: string | undefined,
  mainnetPassphrase: string
): string | null {
  if (!skip) return null;
  if (networkPassphrase === mainnetPassphrase) {
    return "SKIP_CHAIN_CONFIG_CHECK=true is not allowed on Mainnet";
  }
  if (nodeEnv === "production") {
    return "SKIP_CHAIN_CONFIG_CHECK=true is not allowed with NODE_ENV=production";
  }
  return null;
}
