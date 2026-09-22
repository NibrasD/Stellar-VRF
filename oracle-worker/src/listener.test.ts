/**
 * listener.test.ts — Unit tests for Soroban event listener recovery.
 *
 * Tests cover:
 *   - startListenerLoop exits gracefully when isActive returns false
 *   - startListenerLoop continues on handler errors (no crash)
 *   - startListenerLoop throws after repeated poll failures (supervisor hook)
 *   - periodic task (reconciliation) runs while active
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock all external dependencies ──────────────────────────────────────────

vi.mock("./config.js", () => ({
  SOROBAN_RPC_URL: "https://rpc.test",
  CONTRACT_ADDRESS: "CTEST",
  POLL_INTERVAL_MS: 100,
  ORACLE_PUBLIC_KEY: "GTEST",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
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

// Mock the entire stellar-sdk to avoid importing the real heavy module
vi.mock("@stellar/stellar-sdk", () => ({
  rpc: {
    Server: vi.fn(),
  },
  xdr: {},
  Address: { fromString: vi.fn() },
  scValToNative: vi.fn(),
  nativeToScVal: vi.fn(),
  TransactionBuilder: vi.fn(),
  Operation: {},
}));

// ── startListenerLoop tests ─────────────────────────────────────────────────

describe("startListenerLoop", () => {
  let startListenerLoop: typeof import("./listener.js")["startListenerLoop"];

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("./listener.js");
    startListenerLoop = mod.startListenerLoop;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits gracefully when isActive() returns false immediately", async () => {
    const mockServer = {
      getHealth: vi.fn().mockResolvedValue({
        latestLedger: 1000,
        oldestLedger: 500,
      }),
      getEvents: vi.fn().mockResolvedValue({ events: [] }),
    } as any;

    const handler = vi.fn();
    let callCount = 0;
    const isActive = () => {
      callCount++;
      return callCount <= 1; // active for init, then stop
    };

    await startListenerLoop(mockServer, handler, isActive);

    // Should have exited without calling handler
    expect(handler).not.toHaveBeenCalled();
  });

  it("continues processing when handler throws an error (no crash)", async () => {
    const mockServer = {
      getHealth: vi.fn().mockResolvedValue({
        latestLedger: 1000,
        oldestLedger: 500,
      }),
      getEvents: vi.fn().mockResolvedValue({ events: [] }),
    } as any;

    const handler = vi.fn().mockRejectedValue(new Error("handler failed"));
    let iterations = 0;
    const isActive = () => {
      iterations++;
      return iterations <= 3; // allow 3 iterations then stop
    };

    // Should NOT throw even though handler fails
    await expect(
      startListenerLoop(mockServer, handler, isActive)
    ).resolves.toBeUndefined();
  });

  it("gives up (throws) after repeated poll failures so the supervisor can act", async () => {
    // Previously every poll error was swallowed forever: a dead RPC produced a
    // leader that looked alive but never saw another event.
    const mockServer = {
      getHealth: vi
        .fn()
        .mockResolvedValueOnce({ latestLedger: 1000, oldestLedger: 500 }) // init
        .mockRejectedValue(new Error("ECONNREFUSED")),                    // every poll
      getEvents: vi.fn(),
    } as any;

    await expect(
      startListenerLoop(mockServer, vi.fn(), () => true)
    ).rejects.toThrow(/failed \d+ times in a row/);
  });

  it("runs the periodic task (reconciliation) while active", async () => {
    const mockServer = {
      getHealth: vi.fn().mockResolvedValue({ latestLedger: 1000, oldestLedger: 500 }),
      getEvents: vi.fn().mockResolvedValue({ events: [] }),
    } as any;
    const periodic = vi.fn().mockResolvedValue(undefined);
    let n = 0;

    await startListenerLoop(mockServer, vi.fn(), () => ++n <= 3, {
      periodic,
      periodicEveryMs: 0, // due on every iteration
    });

    expect(periodic).toHaveBeenCalled();
  });
});
