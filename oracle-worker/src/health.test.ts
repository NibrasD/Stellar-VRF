/**
 * health.test.ts — a leader with a dead or stuck listener must report degraded.
 *
 * Previously /health only flagged a leader when requests were in flight, so a
 * leader whose listener had died reported 200 OK indefinitely on a quiet chain.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("./leader.js", () => ({
  getLeaderState: () => "leader",
  getInstanceId: () => "test",
}));

import { evaluateListenerHealth } from "./health.js";

const NOW = 10_000_000;
const STALE = 120_000;
const GRACE = 60_000;

describe("evaluateListenerHealth", () => {
  it("ignores standby instances entirely", () => {
    expect(
      evaluateListenerHealth("standby", { running: false, lastHeartbeatAt: null, sessionStartedAt: null }, NOW, STALE, GRACE)
    ).toBeNull();
  });

  it("flags a leader with no listener running (the crashed-listener zombie)", () => {
    expect(
      evaluateListenerHealth("leader", { running: false, lastHeartbeatAt: NOW - 1000, sessionStartedAt: null }, NOW, STALE, GRACE)
    ).toMatch(/no listener session is running/);
  });

  it("flags a running listener that has made no progress past the threshold", () => {
    expect(
      evaluateListenerHealth(
        "leader",
        { running: true, lastHeartbeatAt: NOW - STALE - 1, sessionStartedAt: NOW - 10 * STALE },
        NOW, STALE, GRACE
      )
    ).toMatch(/no progress/);
  });

  it("accepts a healthy idle leader (recent poll, zero traffic)", () => {
    expect(
      evaluateListenerHealth(
        "leader",
        { running: true, lastHeartbeatAt: NOW - 3000, sessionStartedAt: NOW - 10 * STALE },
        NOW, STALE, GRACE
      )
    ).toBeNull();
  });

  it("gives a fresh session a grace period before judging staleness", () => {
    expect(
      evaluateListenerHealth(
        "leader",
        { running: true, lastHeartbeatAt: null, sessionStartedAt: NOW - GRACE + 1 },
        NOW, STALE, GRACE
      )
    ).toBeNull();
  });
});
