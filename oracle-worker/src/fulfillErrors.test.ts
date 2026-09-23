/**
 * fulfillErrors.test.ts — deterministic failures must stop, transient ones
 * must retry.
 */

import { describe, it, expect } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import {
  FulfillTerminalError,
  classifyFulfillError,
  classifyFulfillFailure,
  failureError,
  isNonRetryable,
} from "./fulfillErrors.js";
import { withFulfillRetry } from "./retry.js";

/** A real TransactionResult: txFailed, one invokeHostFunction op with `ihfCode`. */
function failedTxResult(ihfCode: number): xdr.TransactionResult {
  const buf = Buffer.alloc(32);
  let o = 0;
  buf.writeBigInt64BE(777n, o); o += 8;
  buf.writeInt32BE(-1, o); o += 4; // txFAILED
  buf.writeUInt32BE(1, o); o += 4; // 1 op result
  buf.writeInt32BE(0, o); o += 4; // opINNER
  buf.writeInt32BE(24, o); o += 4; // INVOKE_HOST_FUNCTION
  buf.writeInt32BE(ihfCode, o); o += 4;
  buf.writeInt32BE(0, o); // ext v0
  return xdr.TransactionResult.fromXDR(buf);
}

function txResultWithCode(code: number): xdr.TransactionResult {
  const buf = Buffer.alloc(16);
  buf.writeBigInt64BE(0n, 0);
  buf.writeInt32BE(code, 8);
  buf.writeInt32BE(0, 12);
  return xdr.TransactionResult.fromXDR(buf);
}

describe("classifyFulfillFailure — contract panics", () => {
  const cases: Array<[string, string, boolean]> = [
    ["HostError: Error(WasmVm, InvalidAction) \"already fulfilled\"", "already_fulfilled", true],
    ["panicked: request refunded", "request_refunded", true],
    ["bls vrf verification failed", "vrf_proof_invalid", false],
    ["drand signature verification failed", "drand_signature_invalid", false],
    ["oracle key mismatch", "oracle_key_mismatch", false],
    ["drand round mismatch", "drand_round_mismatch", false],
  ];
  for (const [text, reason, settled] of cases) {
    it(`"${reason}" is terminal (settled=${settled})`, () => {
      expect(classifyFulfillFailure(text)).toEqual({ kind: "terminal", reason, settled });
    });
  }
});

describe("failureError — real XDR results", () => {
  it("a trapping consumer callback is terminal", () => {
    const e = failureError("Transaction failed: abc", failedTxResult(-2));
    expect(e).toBeInstanceOf(FulfillTerminalError);
    expect((e as FulfillTerminalError).reason).toBe("host_function_trapped");
  });

  it("resource limit exceeded is terminal", () => {
    const e = failureError("Transaction failed: abc", failedTxResult(-3));
    expect((e as FulfillTerminalError).reason).toBe("resource_limit_exceeded");
  });

  it("insufficient refundable fee is retryable (re-simulation fixes it)", () => {
    const e = failureError("Transaction failed: abc", failedTxResult(-5));
    expect(e).not.toBeInstanceOf(FulfillTerminalError);
  });

  it("txBadSeq is retryable", () => {
    const e = failureError("Send error", txResultWithCode(-5));
    expect(e).not.toBeInstanceOf(FulfillTerminalError);
    expect(e.message).toMatch(/tx_bad_seq/);
  });

  it("txInsufficientBalance is terminal", () => {
    const e = failureError("Send error", txResultWithCode(-7));
    expect(e).toBeInstanceOf(FulfillTerminalError);
  });
});

describe("classifyFulfillError", () => {
  it("unknown / network errors are retryable", () => {
    expect(classifyFulfillError(new Error("ECONNRESET")).kind).toBe("retryable");
    expect(classifyFulfillError(new Error("Transaction confirmation timeout: x")).kind).toBe("retryable");
  });

  it("keeps a FulfillTerminalError's own reason", () => {
    const e = new FulfillTerminalError("x", "resource_bound_exceeded", false);
    expect(classifyFulfillError(e)).toEqual({ kind: "terminal", reason: "resource_bound_exceeded", settled: false });
  });

  it("isNonRetryable covers aborts and terminal errors only", () => {
    const aborted = new Error("x");
    aborted.name = "FulfillAbortedError";
    expect(isNonRetryable(aborted)).toBe(true);
    expect(isNonRetryable(new FulfillTerminalError("x", "r", false))).toBe(true);
    expect(isNonRetryable(new Error("x"))).toBe(false);
  });
});

describe("withFulfillRetry", () => {
  it("does not retry a terminal error", async () => {
    let calls = 0;
    await expect(
      withFulfillRetry("t", async () => {
        calls++;
        throw new FulfillTerminalError("callback trapped", "host_function_trapped", false);
      })
    ).rejects.toBeInstanceOf(FulfillTerminalError);
    expect(calls).toBe(1);
  });
});
