/**
 * policy.test.ts — local drand verification cannot be switched off where it
 * protects real money.
 */

import { describe, it, expect } from "vitest";
import { Networks } from "@stellar/stellar-sdk";
import { drandVerificationPolicyError, redisPolicyError } from "./policy.js";

describe("redisPolicyError", () => {
  const P = Networks.PUBLIC;
  const T = Networks.TESTNET;
  it("requires REDIS_URL on Mainnet and in production (no file fallback)", () => {
    expect(redisPolicyError(undefined, P, undefined, undefined)).toMatch(/REDIS_URL is required/);
    expect(redisPolicyError("", T, "production", undefined)).toMatch(/REDIS_URL is required/);
  });
  it("accepts rediss:// everywhere", () => {
    expect(redisPolicyError("rediss://:pw@redis.example.com:6380", P, "production", undefined)).toBeNull();
  });
  it("refuses plaintext redis:// to a remote host in production", () => {
    expect(redisPolicyError("redis://:pw@10.0.0.5:6379", P, undefined, undefined)).toMatch(/rediss:\/\//);
    expect(redisPolicyError("redis://:pw@redis:6379", T, "production", "false")).toMatch(/rediss:\/\//);
  });
  it("allows plaintext only to loopback or with an explicit private-network override", () => {
    expect(redisPolicyError("redis://127.0.0.1:6379", P, undefined, undefined)).toBeNull();
    expect(redisPolicyError("redis://localhost:6379", P, undefined, undefined)).toBeNull();
    expect(redisPolicyError("redis://:pw@redis:6379", P, undefined, "true")).toBeNull();
  });
  it("refuses other schemes", () => {
    expect(redisPolicyError("http://redis:6379", P, undefined, "true")).toMatch(/rediss/);
  });
  it("imposes nothing outside production", () => {
    expect(redisPolicyError(undefined, T, undefined, undefined)).toBeNull();
    expect(redisPolicyError("redis://10.0.0.5:6379", T, "development", undefined)).toBeNull();
  });
});

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
