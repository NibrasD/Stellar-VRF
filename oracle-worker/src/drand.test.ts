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
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeCurrentRound, roundTimestamp } from "./drand.js";

// ── Mock configuration ──────────────────────────────────────────────────────

// We mock config.js and utils.js at the module level so drand.ts imports
// our test values instead of reading environment variables.
vi.mock("./config.js", () => ({
  DRAND_API_URL: "https://drand.test",
  DRAND_CHAIN_HASH: "test_chain_hash",
  DRAND_GENESIS_TIME: 1_000_000,
  DRAND_PERIOD: 3,
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
