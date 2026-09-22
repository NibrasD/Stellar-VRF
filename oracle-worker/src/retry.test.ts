/**
 * retry.test.ts — leadership is re-checked before EVERY fulfill attempt, and a
 * deliberate abort is never retried.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("./metrics.js", () => ({ recordDrandDelay: vi.fn() }));
vi.mock("./utils.js", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
  bytesToHex: (b: Uint8Array) => Buffer.from(b).toString("hex"),
}));

vi.mock("./config.js", () => ({
  CONTRACT_ADDRESS: "CBTCC5QL5T3JSLEZO4PH6LSJYEQF6GEFDCAO67OXI4DTM5NXMK6TSUHU",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ORACLE_KEYPAIR: {},
  ORACLE_PUBLIC_KEY: "GA6HYAVWPVOVB4XJHGUZSDHRVYOKLPU4JAHYPXZRSJWO2PM4HSCNKP5P",
  TX_FEE: "100",
  MAX_RETRIES: 4,
}));

import { withFulfillRetry, withRetry } from "./retry.js";
import { submitFulfillment, FulfillAbortedError } from "./fulfiller.js";

const PROOF = {
  alphaSeed: Buffer.alloc(32),
  gammaPoint: Buffer.alloc(96),
  betaOutput: Buffer.alloc(32),
  publicKey: Buffer.alloc(192),
  drandRound: 1n,
  drandSignature: Buffer.alloc(96),
  ed25519Signature: Buffer.alloc(64),
};

describe("submitFulfillment canSubmit gate", () => {
  it("never touches the network when not allowed to submit", async () => {
    const server = { getAccount: vi.fn() } as any;

    await expect(submitFulfillment(server, 1n, PROOF, () => false)).rejects.toBeInstanceOf(
      FulfillAbortedError
    );
    expect(server.getAccount).not.toHaveBeenCalled();
  });

  it("re-checks before each INTERNAL retry and aborts once leadership is lost", async () => {
    let leader = true;
    const server = {
      getAccount: vi.fn(async () => {
        leader = false; // lease lost while attempt 1 was in progress
        throw new Error("txBadSeq");
      }),
    } as any;

    await expect(submitFulfillment(server, 1n, PROOF, () => leader)).rejects.toBeInstanceOf(
      FulfillAbortedError
    );
    // Attempt 1 ran; attempt 2 was refused before it could build/sign/send.
    expect(server.getAccount).toHaveBeenCalledTimes(1);
  });

  it("an abort from submitFulfillment is not retried by withFulfillRetry", async () => {
    const server = { getAccount: vi.fn() } as any;
    const canSubmit = vi.fn(() => false);

    await expect(
      withFulfillRetry("fulfill(1)", () => submitFulfillment(server, 1n, PROOF, canSubmit))
    ).rejects.toBeInstanceOf(FulfillAbortedError);
    expect(canSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("withFulfillRetry", () => {
  it("does not retry a FulfillAbortedError (leadership lost)", async () => {
    const fn = vi.fn().mockRejectedValue(new FulfillAbortedError("leadership lost"));

    await expect(withFulfillRetry("fulfill(1)", fn)).rejects.toThrow("leadership lost");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("still retries ordinary transient failures", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("txBadSeq"))
      .mockResolvedValueOnce("hash");

    await expect(withFulfillRetry("fulfill(1)", fn)).resolves.toBe("hash");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("withRetry shouldRetry predicate", () => {
  it("stops immediately when the predicate rejects the error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fatal"));
    await expect(withRetry("x", fn, 5, () => false)).rejects.toThrow("fatal");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
