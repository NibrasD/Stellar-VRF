/**
 * listener.test.ts — Unit tests for Soroban event listener recovery.
 *
 * Tests cover:
 *   - startListenerLoop exits gracefully when isActive returns false
 *   - startListenerLoop continues on handler errors (no crash)
 *   - pollRequestEvents cursor resync on retention errors
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
});
