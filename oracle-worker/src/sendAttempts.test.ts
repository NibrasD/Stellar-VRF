/**
 * sendAttempts.test.ts — a third party must not be able to make the oracle
 * pay network fees for the same request without limit.
 *
 * Regression target: a request that always fails after simulation was retried
 * withFulfillRetry × submitFulfillment times per pass, and reconciliation
 * started a fresh pass every RECONCILE_INTERVAL_MS, forever.
 */

import { describe, it, expect } from "vitest";
import { SendAttemptTracker, sendAttemptOptionsFromEnv } from "./sendAttempts.js";

describe("SendAttemptTracker", () => {
  it("allows exactly maxSendsPerRequest sends, then refuses", () => {
    const t = new SendAttemptTracker({ maxSendsPerRequest: 3, maxTrackedRequests: 100 });
    expect(t.tryReserve(7n).ok).toBe(true);
    expect(t.tryReserve(7n).ok).toBe(true);
    expect(t.isExhausted(7n)).toBe(false);
    expect(t.tryReserve(7n).ok).toBe(true);
    expect(t.isExhausted(7n)).toBe(true);

    const refused = t.tryReserve(7n);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/send cap reached for request 7 \(3\/3/);
    expect(t.count(7n)).toBe(3); // a refused reservation is not counted
  });

  it("shares one allowance across passes (reconciliation cannot reset it)", () => {
    const t = new SendAttemptTracker({ maxSendsPerRequest: 4, maxTrackedRequests: 100 });
    // Pass 1: 3 sends (e.g. inner retries). Pass 2 (reconcile): only 1 left.
    for (let i = 0; i < 3; i++) expect(t.tryReserve(1n).ok).toBe(true);
    expect(t.tryReserve(1n).ok).toBe(true);
    expect(t.tryReserve(1n).ok).toBe(false);
    // Unbounded retry loop is bounded: 1000 further attempts spend nothing.
    let extra = 0;
    for (let i = 0; i < 1000; i++) if (t.tryReserve(1n).ok) extra++;
    expect(extra).toBe(0);
  });

  it("tracks requests independently and clear() resets one", () => {
    const t = new SendAttemptTracker({ maxSendsPerRequest: 1, maxTrackedRequests: 100 });
    expect(t.tryReserve(1n).ok).toBe(true);
    expect(t.tryReserve(2n).ok).toBe(true);
    expect(t.tryReserve(1n).ok).toBe(false);
    t.clear(1n);
    expect(t.tryReserve(1n).ok).toBe(true);
    expect(t.tryReserve(2n).ok).toBe(false);
  });

  it("bounds memory by evicting the least recently used id", () => {
    const t = new SendAttemptTracker({ maxSendsPerRequest: 5, maxTrackedRequests: 2 });
    t.tryReserve(1n);
    t.tryReserve(2n);
    t.tryReserve(1n); // 1 is now most recent
    t.tryReserve(3n); // evicts 2
    expect(t.count(2n)).toBe(0);
    expect(t.count(1n)).toBe(2);
    expect(t.count(3n)).toBe(1);
  });

  it("park() exhausts the allowance at once (terminal failures cost nothing more)", () => {
    const t = new SendAttemptTracker({ maxSendsPerRequest: 6, maxTrackedRequests: 100 });
    expect(t.tryReserve(9n).ok).toBe(true);
    t.park(9n);
    expect(t.isExhausted(9n)).toBe(true);
    expect(t.tryReserve(9n).ok).toBe(false);
    expect(t.isExhausted(10n)).toBe(false);
  });

  it("rejects a non-positive cap", () => {
    expect(() => new SendAttemptTracker({ maxSendsPerRequest: 0, maxTrackedRequests: 1 })).toThrow();
  });
});

describe("sendAttemptOptionsFromEnv", () => {
  it("defaults to 6 sends per request", () => {
    expect(sendAttemptOptionsFromEnv({}).maxSendsPerRequest).toBe(6);
  });
  it("honours MAX_SENDS_PER_REQUEST", () => {
    expect(sendAttemptOptionsFromEnv({ MAX_SENDS_PER_REQUEST: "2" }).maxSendsPerRequest).toBe(2);
  });
  it("refuses invalid values instead of silently disabling the cap", () => {
    expect(() => sendAttemptOptionsFromEnv({ MAX_SENDS_PER_REQUEST: "0" })).toThrow();
    expect(() => sendAttemptOptionsFromEnv({ MAX_SENDS_PER_REQUEST: "abc" })).toThrow();
  });
});
