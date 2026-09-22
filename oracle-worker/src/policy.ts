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
