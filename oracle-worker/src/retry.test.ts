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

// Stub the SDK's transaction building so the beforeSend gate can be exercised
// without a network: assembleTransaction() yields a tx whose `fee` is the
// `_fee` carried by the mock simulation result.
vi.mock("@stellar/stellar-sdk", async (orig) => {
  const actual: any = await orig();
  class FakeBuilder {
    addOperation() { return this; }
    setTimeout() { return this; }
    build() { return {}; }
  }
  return {
    ...actual,
    TransactionBuilder: FakeBuilder,
    Operation: { invokeContractFunction: () => ({}) },
    rpc: {
      ...actual.rpc,
      Api: {
        ...actual.rpc.Api,
        isSimulationError: () => false,
        isSimulationSuccess: () => true,
      },
      assembleTransaction: (_tx: unknown, sim: { _fee?: string }) => ({
        build: () => ({ fee: sim._fee ?? "0", sign: () => {} }),
      }),
    },
  };
});

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
import { FulfillTerminalError } from "./fulfillErrors.js";

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

describe("submitFulfillment beforeSend gate (fee guard)", () => {
  function mockServer(fee: string, instructions = 58_342_003, minResourceFee = "1400000") {
    return {
      getAccount: vi.fn(async () => ({})),
      simulateTransaction: vi.fn(async () => ({
        _fee: fee,
        minResourceFee,
        transactionData: { resources: { instructions } },
      })),
      sendTransaction: vi.fn(async () => ({ status: "PENDING", hash: "h" })),
      getTransaction: vi.fn(async () => ({ status: "SUCCESS" })),
    } as any;
  }

  it("passes the assembled tx max fee and never sends when refused", async () => {
    const server = mockServer("1700000");
    const beforeSend = vi.fn(async () => ({ ok: false as const, reason: "budget used up" }));

    await expect(
      submitFulfillment(server, 1n, PROOF, () => true, beforeSend)
    ).rejects.toBeInstanceOf(FulfillAbortedError);
    expect(beforeSend).toHaveBeenCalledTimes(1);
    // Max fee, plus a unique send id used to key the fee reservation.
    expect(beforeSend).toHaveBeenCalledWith(1_700_000n, expect.any(String));
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });

  it("gates EVERY internal retry, so a retried request pays into the budget each time", async () => {
    const server = mockServer("1500000");
    server.sendTransaction = vi.fn(async () => ({ status: "ERROR", errorResult: "txBadSeq" }));
    const beforeSend = vi.fn(async () => ({ ok: true as const }));

    await expect(submitFulfillment(server, 1n, PROOF, () => true, beforeSend)).rejects.toThrow(
      /after 4 attempts/
    );
    expect(beforeSend).toHaveBeenCalledTimes(4); // MAX_RETRIES in the config mock
    expect(server.sendTransaction).toHaveBeenCalledTimes(4);
  });
});

describe("submitFulfillment settles each send's fee reservation by outcome", () => {
  function server(opts: { send?: any; tx?: any; sendThrows?: boolean }) {
    return {
      getAccount: vi.fn(async () => ({})),
      simulateTransaction: vi.fn(async () => ({
        _fee: "1500000",
        minResourceFee: "1400000",
        transactionData: { resources: { instructions: 58_000_000 } },
      })),
      sendTransaction: vi.fn(async () => {
        if (opts.sendThrows) throw new Error("socket hang up");
        return opts.send ?? { status: "PENDING", hash: "h" };
      }),
      getTransaction: vi.fn(async () => opts.tx ?? { status: "SUCCESS" }),
    } as any;
  }
  async function run(s: any) {
    const outcomes: string[] = [];
    const gate = vi.fn(async () => ({
      ok: true as const,
      settle: async (o: string) => {
        outcomes.push(o);
      },
    }));
    const err = await submitFulfillment(s, 1n, PROOF, () => true, gate).catch((e) => e);
    return { outcomes, err };
  }

  it("success → success", async () => {
    expect((await run(server({}))).outcomes).toEqual(["success"]);
  });

  it("tx_bad_seq at submission → not_included on every attempt (released)", async () => {
    const r = await run(server({ send: { status: "ERROR", errorResult: "txBadSeq" } }));
    expect(r.outcomes).toEqual(["not_included", "not_included", "not_included", "not_included"]);
  });

  it("an unlisted submission error → failed (kept, conservative)", async () => {
    const r = await run(server({ send: { status: "ERROR", errorResult: "txSomethingNew" } }));
    expect(r.outcomes.every((o) => o === "failed")).toBe(true);
  });

  it("applied and failed on-chain → failed (kept)", async () => {
    const r = await run(server({ tx: { status: "FAILED", resultXdr: "invokeHostFunctionTrapped" } }));
    expect(r.outcomes).toEqual(["failed"]);
    expect(r.err).toBeInstanceOf(FulfillTerminalError);
  });

  it("no answer from sendTransaction → unknown (kept until resolved)", async () => {
    const r = await run(server({ sendThrows: true }));
    expect(r.outcomes).toEqual(["unknown", "unknown", "unknown", "unknown"]);
  });
});

describe("submitFulfillment resource guard + terminal errors", () => {
  function mockServer(fee: string, instructions: number, minResourceFee = "1400000") {
    return {
      getAccount: vi.fn(async () => ({})),
      simulateTransaction: vi.fn(async () => ({
        _fee: fee,
        minResourceFee,
        transactionData: { resources: { instructions } },
      })),
      sendTransaction: vi.fn(async () => ({ status: "PENDING", hash: "h" })),
      getTransaction: vi.fn(async () => ({ status: "SUCCESS" })),
    } as any;
  }

  it("refuses an over-budget simulation before the fee gate, and does not retry", async () => {
    const server = mockServer("1500000", 95_000_000); // expensive on_vrf()
    const beforeSend = vi.fn(async () => ({ ok: true as const }));

    const err = await submitFulfillment(server, 1n, PROOF, () => true, beforeSend).catch((e) => e);
    expect(err).toBeInstanceOf(FulfillTerminalError);
    expect(err.reason).toBe("resource_bound_exceeded");
    expect(server.simulateTransaction).toHaveBeenCalledTimes(1); // no internal retry
    expect(beforeSend).not.toHaveBeenCalled(); // no budget reserved
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });

  it("refuses an over-budget resource fee", async () => {
    const server = mockServer("1500000", 58_000_000, "9000000");
    await expect(submitFulfillment(server, 1n, PROOF)).rejects.toBeInstanceOf(FulfillTerminalError);
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });

  it("a deterministic send failure is not retried internally or by withFulfillRetry", async () => {
    const server = mockServer("1500000", 58_000_000);
    server.sendTransaction = vi.fn(async () => ({ status: "ERROR", errorResult: "tx_insufficient_balance" }));
    await expect(
      withFulfillRetry("fulfill(1)", () => submitFulfillment(server, 1n, PROOF))
    ).rejects.toBeInstanceOf(FulfillTerminalError);
    expect(server.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("a simulation panic like 'already fulfilled' is terminal and settled", async () => {
    const server = mockServer("1500000", 58_000_000);
    const { rpc } = await import("@stellar/stellar-sdk");
    const spy = vi.spyOn(rpc.Api, "isSimulationError").mockReturnValue(true);
    server.simulateTransaction = vi.fn(async () => ({ error: "HostError: \"already fulfilled\"" }));
    const err = await submitFulfillment(server, 1n, PROOF).catch((e) => e);
    spy.mockRestore();
    expect(err).toBeInstanceOf(FulfillTerminalError);
    expect(err.settled).toBe(true);
    expect(server.simulateTransaction).toHaveBeenCalledTimes(1);
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
