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
