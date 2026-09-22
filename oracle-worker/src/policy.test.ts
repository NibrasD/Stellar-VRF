/**
 * policy.test.ts — local drand verification cannot be switched off where it
 * protects real money.
 */

import { describe, it, expect } from "vitest";
import { Networks } from "@stellar/stellar-sdk";
import { drandVerificationPolicyError } from "./policy.js";

describe("drandVerificationPolicyError", () => {
  it("always accepts verification ON", () => {
    expect(drandVerificationPolicyError(true, Networks.PUBLIC, "production")).toBeNull();
  });

  it("refuses verification OFF on Mainnet, whatever NODE_ENV says", () => {
    for (const env of [undefined, "development", "production"]) {
      expect(drandVerificationPolicyError(false, Networks.PUBLIC, env)).toMatch(/Mainnet/);
    }
  });

  it("refuses verification OFF with NODE_ENV=production on any network", () => {
    expect(drandVerificationPolicyError(false, Networks.TESTNET, "production")).toMatch(/NODE_ENV=production/);
  });

  it("allows verification OFF only for non-production testnet debugging", () => {
    expect(drandVerificationPolicyError(false, Networks.TESTNET, undefined)).toBeNull();
    expect(drandVerificationPolicyError(false, Networks.TESTNET, "development")).toBeNull();
  });
});
