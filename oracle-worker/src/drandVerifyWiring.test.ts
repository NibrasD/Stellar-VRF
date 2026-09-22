/**
 * drandVerifyWiring.test.ts — proves that beacon verification is actually
 * ENFORCED on the fetch path, not merely exported.
 *
 * This lives in its own file because it needs `DRAND_VERIFY_BEACONS: true` in
 * the mocked config, whereas `drand.test.ts` mocks it to `false` so its
 * retry/backoff cases can use synthetic (unverifiable) signatures.
 *
 * Why this matters: the contract re-verifies the drand signature on-chain, so a
 * forged beacon can never yield accepted randomness. What it CAN do, if the
 * worker trusts the relay blindly, is make the worker build a proof and pay to
 * submit a transaction that is certain to be rejected — a fee-drain / DoS
 * vector. These tests pin the guard shut.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./config.js", () => ({
  DRAND_API_URL: "https://drand.test",
  DRAND_CHAIN_HASH: "test_chain_hash",
  DRAND_GENESIS_TIME: 1_000_000,
  DRAND_PERIOD: 3,
  DRAND_PUBLIC_KEY:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c" +
    "3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab" +
    "4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  DRAND_VERIFY_BEACONS: true,
  DRAND_DST: "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_",
}));

vi.mock("./utils.js", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

/** Published quicknet beacon, round 1,000,000 (immutable). */
const REAL_BEACON = {
  round: 1_000_000,
  randomness: "b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3",
  signature:
    "83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72",
};

describe("fetchDrandBeacon with verification enabled", () => {
  const mockFetch = vi.fn();
  let fetchDrandBeacon: typeof import("./drand.js")["fetchDrandBeacon"];
  let DrandVerificationError: typeof import("./drand.js")["DrandVerificationError"];

  beforeEach(async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
    const mod = await import("./drand.js");
    fetchDrandBeacon = mod.fetchDrandBeacon;
    DrandVerificationError = mod.DrandVerificationError;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a genuine beacon", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => REAL_BEACON });

    const result = await fetchDrandBeacon(REAL_BEACON.round, 0);

    expect(result).toEqual(REAL_BEACON);
  });

  it("refuses a forged beacon instead of returning it", async () => {
    // Valid-looking G1 point, but not the signature for this round.
    const forged = {
      ...REAL_BEACON,
      signature:
        "a1b2c3d4e5f60718293a4b5c6d7e8f901122334455667788990011223344556677889900aabbccddeeff001122334455",
    };
    mockFetch.mockResolvedValue({ ok: true, json: async () => forged });

    await expect(fetchDrandBeacon(REAL_BEACON.round, 0)).rejects.toThrow(
      DrandVerificationError
    );
  });

  it("refuses a beacon served under the wrong round", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => REAL_BEACON });

    // Ask for a different round than the relay answers with.
    await expect(fetchDrandBeacon(REAL_BEACON.round + 5, 0)).rejects.toThrow(
      /round mismatch/
    );
  });

  it("retries a bad beacon (load-balanced relay) and accepts a good one", async () => {
    const bad = { ...REAL_BEACON, signature: "deadbeef" };
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => bad })
      .mockResolvedValueOnce({ ok: true, json: async () => REAL_BEACON });

    const result = await fetchDrandBeacon(REAL_BEACON.round, 3);

    expect(result).toEqual(REAL_BEACON);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("preserves the verification error type after exhausting retries", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ...REAL_BEACON, signature: "deadbeef" }),
    });

    // Distinguishable from ordinary network failure, so alerting can treat a
    // persistently bad relay differently.
    await expect(fetchDrandBeacon(REAL_BEACON.round, 1)).rejects.toThrow(
      DrandVerificationError
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
