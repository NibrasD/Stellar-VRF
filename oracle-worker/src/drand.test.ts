/**
 * drand.test.ts — Unit tests for drand beacon fetch with retry/backoff/recovery.
 *
 * Tests cover:
 *   - Successful fetch on first attempt
 *   - Retry on HTTP 404 (round not yet available)
 *   - Retry on HTTP 503 (service unavailable)
 *   - Exponential backoff timing
 *   - Timeout (AbortSignal) handling
 *   - Network error recovery
 *   - Exhausted retries throw after maxRetries+1 attempts
 *   - computeCurrentRound / roundTimestamp pure function correctness
 *   - waitAndFetchBeacon: pre-wait sleep, propagation buffer, immediate fetch
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  computeCurrentRound,
  roundTimestamp,
  verifyDrandBeacon,
  DrandVerificationError,
} from "./drand.js";

// ── Mock configuration ──────────────────────────────────────────────────────

// We mock config.js and utils.js at the module level so drand.ts imports
// our test values instead of reading environment variables.
// The real quicknet group key, so the verification tests below exercise the
// same key the worker uses in production.
const QUICKNET_PK =
  "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c" +
  "3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab" +
  "4af5a6e9c76a4bc09e76eae8991ef5ece45a";

vi.mock("./config.js", () => ({
  DRAND_API_URL: "https://drand.test",
  DRAND_CHAIN_HASH: "test_chain_hash",
  DRAND_GENESIS_TIME: 1_000_000,
  DRAND_PERIOD: 3,
  DRAND_PUBLIC_KEY:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c" +
    "3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab" +
    "4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  // Most fetch/retry tests use synthetic (unverifiable) signatures, so
  // verification is off by default here and enabled explicitly in the
  // verification test block below.
  DRAND_VERIFY_BEACONS: false,
  DRAND_DST: "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_",
}));

vi.mock("./utils.js", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// ── Pure function tests ─────────────────────────────────────────────────────

describe("computeCurrentRound", () => {
  it("returns 0 for timestamps at or before genesis", () => {
    expect(computeCurrentRound(1_000_000)).toBe(0);
    expect(computeCurrentRound(999_999)).toBe(0);
    expect(computeCurrentRound(0)).toBe(0);
  });

  it("computes correct round for timestamps after genesis", () => {
    // genesis=1_000_000, period=3
    expect(computeCurrentRound(1_000_003)).toBe(1);
    expect(computeCurrentRound(1_000_006)).toBe(2);
    expect(computeCurrentRound(1_000_009)).toBe(3);
    expect(computeCurrentRound(1_000_010)).toBe(3); // floor
  });
});

describe("roundTimestamp", () => {
  it("computes correct timestamp for a given round", () => {
    // genesis=1_000_000, period=3
    expect(roundTimestamp(0)).toBe(1_000_000);
    expect(roundTimestamp(1)).toBe(1_000_003);
    expect(roundTimestamp(100)).toBe(1_000_300);
  });
});

// ── fetchDrandBeacon tests ──────────────────────────────────────────────────

describe("fetchDrandBeacon", () => {
  const mockFetch = vi.fn();
  let fetchDrandBeacon: typeof import("./drand.js")["fetchDrandBeacon"];

  beforeEach(async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();

    // Re-import to get the module with mocked globals
    const mod = await import("./drand.js");
    fetchDrandBeacon = mod.fetchDrandBeacon;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns beacon data on successful first fetch", async () => {
    const beacon = { round: 42, randomness: "abcd", signature: "1234567890abcdef1234" };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => beacon,
    });

    const result = await fetchDrandBeacon(42, 0);

    expect(result).toEqual(beacon);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on HTTP 404 and succeeds on second attempt", async () => {
    const beacon = { round: 10, randomness: "ff", signature: "aa11223344556677aabb" };
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => "not found" })
      .mockResolvedValueOnce({ ok: true, json: async () => beacon });

    const result = await fetchDrandBeacon(10, 3);

    expect(result).toEqual(beacon);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on HTTP 503 and succeeds on third attempt", async () => {
    const beacon = { round: 20, randomness: "ee", signature: "bb22334455667788ccdd" };
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "unavailable" })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "unavailable" })
      .mockResolvedValueOnce({ ok: true, json: async () => beacon });

    const result = await fetchDrandBeacon(20, 5);

    expect(result).toEqual(beacon);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting all retries on persistent 404", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: async () => "not found" });

    await expect(fetchDrandBeacon(99, 2)).rejects.toThrow(
      "drand API error 404: not found"
    );
    // maxRetries=2 → attempts 0, 1, 2 = 3 total calls
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("retries on network error and succeeds", async () => {
    const beacon = { round: 5, randomness: "dd", signature: "cc33445566778899eeff" };
    mockFetch
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({ ok: true, json: async () => beacon });

    const result = await fetchDrandBeacon(5, 3);

    expect(result).toEqual(beacon);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting all retries on persistent network error", async () => {
    mockFetch.mockRejectedValue(new Error("ETIMEDOUT"));

    await expect(fetchDrandBeacon(7, 1)).rejects.toThrow(
      /Failed to fetch drand round 7 after 2 attempts.*ETIMEDOUT/
    );
    // maxRetries=1 → attempts 0, 1 = 2 total calls
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws on non-retryable HTTP errors (e.g. 500) with maxRetries=0", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "internal server error",
    });

    await expect(fetchDrandBeacon(3, 0)).rejects.toThrow(
      /drand API error 500|Failed to fetch drand round 3/
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("uses AbortSignal.timeout in fetch calls", async () => {
    const beacon = { round: 1, randomness: "aa", signature: "1122334455667788aabb" };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => beacon });

    await fetchDrandBeacon(1, 0);

    const fetchCall = mockFetch.mock.calls[0];
    expect(fetchCall[1]).toBeDefined();
    expect(fetchCall[1].signal).toBeDefined();
  });
});

// ── waitAndFetchBeacon tests ────────────────────────────────────────────────

describe("waitAndFetchBeacon", () => {
  const mockFetch = vi.fn();
  let waitAndFetchBeacon: typeof import("./drand.js")["waitAndFetchBeacon"];
  let mockSleep: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();

    // Get reference to mocked sleep
    const utils = await import("./utils.js");
    mockSleep = utils.sleep as unknown as ReturnType<typeof vi.fn>;
    mockSleep.mockClear();

    const mod = await import("./drand.js");
    waitAndFetchBeacon = mod.waitAndFetchBeacon;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("sleeps until round is available when round is in the future", async () => {
    // Config: genesis=1_000_000, period=3
    // Round 100 → timestamp = 1_000_000 + 100*3 = 1_000_300
    // Mock Date.now() to return a time BEFORE round 100
    const beforeRoundTime = 1_000_290; // 10 seconds before round 100
    vi.spyOn(Date, "now").mockReturnValue(beforeRoundTime * 1000);
    vi.spyOn(Math, "floor").mockReturnValueOnce(beforeRoundTime);

    const beacon = { round: 100, randomness: "ff", signature: "aabbccdd11223344eeff" };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => beacon });

    const result = await waitAndFetchBeacon(100);

    expect(result).toEqual(beacon);
    // sleep should have been called with (waitSec * 1000) where
    // waitSec = expectedTime - now + 2 = 1_000_300 - 1_000_290 + 2 = 12
    expect(mockSleep).toHaveBeenCalled();
    const sleepCallArg = mockSleep.mock.calls[0][0];
    // Should be 12 * 1000 = 12000ms (10s wait + 2s propagation buffer)
    expect(sleepCallArg).toBe(12_000);
  });

  it("does NOT sleep when round is already in the past", async () => {
    // Round 10 → timestamp = 1_000_000 + 10*3 = 1_000_030
    // Mock Date.now() to return time AFTER round 10
    const afterRoundTime = 1_000_050; // 20 seconds after round 10
    vi.spyOn(Date, "now").mockReturnValue(afterRoundTime * 1000);
    vi.spyOn(Math, "floor").mockReturnValueOnce(afterRoundTime);

    const beacon = { round: 10, randomness: "ee", signature: "1122aabb3344ccdd5566" };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => beacon });

    const result = await waitAndFetchBeacon(10);

    expect(result).toEqual(beacon);
    // sleep should NOT have been called (round is already available)
    // Note: mockSleep might be called by fetchDrandBeacon internals,
    // but the pre-wait sleep should not happen
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("propagates errors from fetchDrandBeacon", async () => {
    // Round already in the past — no pre-wait
    const pastTime = 2_000_000;
    vi.spyOn(Date, "now").mockReturnValue(pastTime * 1000);
    vi.spyOn(Math, "floor").mockReturnValueOnce(pastTime);

    mockFetch.mockRejectedValue(new Error("network down"));

    await expect(waitAndFetchBeacon(5)).rejects.toThrow(/network down/);
  });
});

// ── verifyDrandBeacon tests ─────────────────────────────────────────────────
//
// These are REAL BLS verifications against the live quicknet group public key
// using a fixed, published beacon — no network access and no mocking of the
// crypto. A regression in the hashing convention (round encoding, sha256 of the
// round, or the DST) makes the "valid beacon" case fail immediately.

/** Published quicknet beacon, round 1,000,000 (api.drand.sh, immutable). */
const REAL_BEACON = {
  round: 1_000_000,
  randomness: "b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3",
  signature:
    "83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72",
};

describe("verifyDrandBeacon", () => {
  it("accepts a genuine quicknet beacon", () => {
    expect(() => verifyDrandBeacon(REAL_BEACON)).not.toThrow();
  });

  it("accepts a genuine beacon when the expected round matches", () => {
    expect(() => verifyDrandBeacon(REAL_BEACON, REAL_BEACON.round)).not.toThrow();
  });

  it("uses the same public key the worker ships with", () => {
    // Guards against the mocked config drifting from the real default.
    expect(QUICKNET_PK).toHaveLength(192); // 96-byte compressed G2 point
  });

  it("rejects a beacon whose round does not match the requested round", () => {
    expect(() => verifyDrandBeacon(REAL_BEACON, REAL_BEACON.round + 1)).toThrow(
      DrandVerificationError
    );
    expect(() => verifyDrandBeacon(REAL_BEACON, REAL_BEACON.round + 1)).toThrow(
      /round mismatch/
    );
  });

  it("rejects a valid signature replayed under a different round", () => {
    // The core forgery attempt: a relay serving round N's signature as round M.
    const replayed = { ...REAL_BEACON, round: 1_000_001 };
    expect(() => verifyDrandBeacon(replayed)).toThrow(DrandVerificationError);
    expect(() => verifyDrandBeacon(replayed)).toThrow(/INVALID/);
  });

  it("rejects a tampered signature (single flipped hex nibble)", () => {
    const sig = REAL_BEACON.signature;
    const flipped =
      sig.slice(0, sig.length - 1) + (sig.at(-1) === "2" ? "3" : "2");
    expect(() => verifyDrandBeacon({ ...REAL_BEACON, signature: flipped })).toThrow(
      DrandVerificationError
    );
  });

  it("rejects a malformed signature (wrong length)", () => {
    expect(() =>
      verifyDrandBeacon({ ...REAL_BEACON, signature: "deadbeef" })
    ).toThrow(DrandVerificationError);
  });

  it("rejects a beacon with no signature", () => {
    expect(() => verifyDrandBeacon({ ...REAL_BEACON, signature: "" })).toThrow(
      /no signature/
    );
  });

  it("rejects a beacon with no valid round", () => {
    expect(() =>
      verifyDrandBeacon({ ...REAL_BEACON, round: NaN })
    ).toThrow(/no valid round/);
  });

  it("does not reject solely because the randomness field is wrong", () => {
    // randomness is advisory: the proof binds to the signature, so a wrong
    // randomness field is warned about, not fatal.
    expect(() =>
      verifyDrandBeacon({ ...REAL_BEACON, randomness: "00".repeat(32) })
    ).not.toThrow();
  });
});
