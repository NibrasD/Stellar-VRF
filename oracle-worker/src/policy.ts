/**
 * policy.ts — startup safety rules that must not depend on operator discipline.
 *
 * Kept free of side effects (unlike config.ts, which reads required env vars at
 * import time) so the rules can be unit-tested directly.
 */

import { Networks } from "@stellar/stellar-sdk";

/**
 * Local drand beacon verification may only be disabled for local debugging.
 *
 * The contract re-verifies drand on-chain, so turning verification off never
 * lets bad randomness through. It does let a bad or compromised relay make the
 * worker build proofs and pay for `fulfill()` transactions that are certain to
 * fail, which is a fee-drain vector. On Mainnet, or anywhere
 * `NODE_ENV=production`, that's refused outright; there is deliberately no
 * override flag.
 *
 * @returns an error message if the configuration must be rejected, else null.
 */
export function drandVerificationPolicyError(
  verifyBeacons: boolean,
  networkPassphrase: string,
  nodeEnv: string | undefined
): string | null {
  if (verifyBeacons) return null;
  if (networkPassphrase === Networks.PUBLIC) {
    return (
      "DRAND_VERIFY_BEACONS=false is not allowed on Stellar Mainnet: an unverified relay " +
      "can make the oracle pay for fulfill() transactions that are guaranteed to fail. " +
      "Remove the variable (default is on)."
    );
  }
  if (nodeEnv === "production") {
    return (
      "DRAND_VERIFY_BEACONS=false is not allowed when NODE_ENV=production. " +
      "Disable verification only for local debugging."
    );
  }
  return null;
}

function isProduction(networkPassphrase: string, nodeEnv: string | undefined): boolean {
  return networkPassphrase === Networks.PUBLIC || nodeEnv === "production";
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Coordination backend rules for Mainnet / `NODE_ENV=production`.
 *
 * - `REDIS_URL` is required. The file-based leader lock and spend ledger are
 *   single-host development fallbacks: they can't coordinate separate hosts,
 *   and a stale-lock takeover on a shared volume isn't a safe mutual exclusion.
 * - The Redis connection must use TLS (`rediss://`). The Redis password and
 *   every lease/ledger command would otherwise cross the network in clear.
 *   Plain `redis://` is accepted only to a loopback host, or when the operator
 *   sets `REDIS_ALLOW_PLAINTEXT=true` for an isolated private network (e.g. the
 *   internal docker-compose network in `docker-compose.ha.yml`).
 *
 * @returns an error message if the configuration must be rejected, else null.
 */
export function redisPolicyError(
  redisUrl: string | undefined,
  networkPassphrase: string,
  nodeEnv: string | undefined,
  allowPlaintext: string | undefined
): string | null {
  if (!isProduction(networkPassphrase, nodeEnv)) return null;
  if (!redisUrl) {
    return (
      "REDIS_URL is required on Mainnet / NODE_ENV=production. The file-based leader " +
      "lock and spend ledger are single-host development fallbacks only."
    );
  }
  let u: URL;
  try {
    u = new URL(redisUrl);
  } catch {
    return "REDIS_URL is not a valid URL";
  }
  if (u.protocol === "rediss:") return null;
  if (u.protocol !== "redis:") return `REDIS_URL must use rediss:// (got ${u.protocol})`;
  if (LOOPBACK_HOSTS.has(u.hostname)) return null;
  if ((allowPlaintext || "").toLowerCase() === "true") return null;
  return (
    `REDIS_URL uses plaintext redis:// to ${u.hostname} on Mainnet / NODE_ENV=production. ` +
    "Use rediss:// (TLS), or set REDIS_ALLOW_PLAINTEXT=true only if Redis is on an " +
    "isolated private network."
  );
}
