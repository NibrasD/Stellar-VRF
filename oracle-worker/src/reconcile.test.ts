/**
 * reconcile.test.ts — state-based recovery of pending requests.
 *
 * Uses the REAL @stellar/stellar-sdk XDR types (only the RPC server is faked),
 * so the ledger keys built here are the same bytes sent to a real RPC node.
 *
 * Regression target: the previous implementation scanned IDs 1..200 upwards
 * and stopped at the first gap, so once the contract had issued more than 200
 * requests every NEW pending request was invisible to reconciliation.
 */

import { describe, it, expect, vi } from "vitest";
import { xdr, scValToNative } from "@stellar/stellar-sdk";

vi.mock("./config.js", () => ({
  SOROBAN_RPC_URL: "https://rpc.test",
  CONTRACT_ADDRESS: "CAW6KECQMHRTX2GS3JVHWBMOB5JNNOHNOCE635RQS4SWJ72YF56EUPRX",
  POLL_INTERVAL_MS: 1,
  ORACLE_PUBLIC_KEY: "GA6HYAVWPVOVB4XJHGUZSDHRVYOKLPU4JAHYPXZRSJWO2PM4HSCNKP5P",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
}));
vi.mock("./utils.js", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import { findPendingRequests, readRequestCounter, resetReconcileSweep, decodeEpoch } from "./listener.js";
import { Address, nativeToScVal } from "@stellar/stellar-sdk";
import { getListenerStatus } from "./metrics.js";

interface FakeRequest {
  /** undefined = marker absent (V2 writes Fulfilled/Refunded only when true). */
  fulfilled?: boolean;
  refunded?: boolean;
  round: bigint;
  epoch?: number;
}

/** Fake RPC server backed by an in-memory map of request state. */
function fakeServer(counter: bigint, requests: Map<bigint, FakeRequest>) {
  const getLedgerEntries = vi.fn(async (...keys: any[]) => {
    const entries = [];
    for (const k of keys) {
      const scKey: xdr.ScVal = k.contractData.key;
      const [name, rawId] = scValToNative(scKey) as [string, bigint];
      const req = requests.get(BigInt(rawId));
      if (!req) continue; // missing / expired entry → RPC omits it
      let val: xdr.ScVal;
      if (name === "Fulfilled") {
        if (req.fulfilled === undefined) continue;
        val = xdr.ScVal.scvBool(req.fulfilled);
      } else if (name === "Refunded") {
        if (req.refunded === undefined) continue;
        val = xdr.ScVal.scvBool(req.refunded);
      } else if (name === "RequestEpoch") {
        val = xdr.ScVal.scvU32(req.epoch ?? 1);
      } else {
        val = xdr.ScVal.scvU64(req.round);
      }
      entries.push({ key: k, val: { contractData: { key: scKey, val } } });
    }
    return { entries, latestLedger: 1 };
  });

  const getContractData = vi.fn(async () => ({
    val: {
      contractData: {
        val: {
          instance: {
            storage: [
              { key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("FeeAmount")]), val: xdr.ScVal.scvU64(0n) },
              { key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Counter")]), val: xdr.ScVal.scvU64(counter) },
            ],
          },
        },
      },
    },
  }));

  return { getLedgerEntries, getContractData } as any;
}

function populate(counter: number, overrides: Record<number, Partial<FakeRequest> | null>) {
  const m = new Map<bigint, FakeRequest>();
  for (let i = 1; i <= counter; i++) {
    const o = overrides[i];
    if (o === null) continue; // simulate an expired / archived entry
    m.set(BigInt(i), { fulfilled: true, refunded: false, round: BigInt(1000 + i), ...o });
  }
  return m;
}

describe("readRequestCounter", () => {
  it("reads DataKey::Counter out of contract instance storage", async () => {
    expect(await readRequestCounter(fakeServer(3n, new Map()))).toBe(3n);
  });
});

describe("findPendingRequests", () => {
  it("finds pending requests ABOVE id 200 (the old 1..200 scan missed these)", async () => {
    const reqs = populate(250, {
      7: { fulfilled: false },
      240: { fulfilled: false },
    });
    const server = fakeServer(250n, reqs);

    const pending = await findPendingRequests(server, 1000);

    expect(pending).toEqual([
      { requestId: 7n, requiredRound: 1007n, epochId: 1 },
      { requestId: 240n, requiredRound: 1240n, epochId: 1 },
    ]);
  });

  it("V2: a request with NO Fulfilled/Refunded marker is pending, with its epoch", async () => {
    const reqs = populate(5, {
      2: { fulfilled: undefined, refunded: undefined, epoch: 3 },
      4: { fulfilled: undefined, refunded: true },
    });
    const pending = await findPendingRequests(fakeServer(5n, reqs), 1000);
    expect(pending).toEqual([{ requestId: 2n, requiredRound: 1002n, epochId: 3 }]);
  });

  it("excludes refunded and expired requests", async () => {
    const reqs = populate(10, {
      3: { fulfilled: false, refunded: true }, // refunded → not pending
      5: null,                                 // entries gone → cannot fulfil
      9: { fulfilled: false },
    });

    const pending = await findPendingRequests(fakeServer(10n, reqs), 1000);

    expect(pending.map((p) => p.requestId)).toEqual([9n]);
  });

  it("always scans the newest maxScan IDs, plus one rolling window of older IDs", async () => {
    resetReconcileSweep();
    const reqs = populate(250, {
      7: { fulfilled: false },   // far outside the newest window
      240: { fulfilled: false }, // inside
    });
    const server = fakeServer(250n, reqs);

    // Pass 1: newest 231..250 + older 211..230 → only 240.
    expect((await findPendingRequests(server, 20)).map((p) => p.requestId)).toEqual([240n]);
  });

  it("the older-ID sweep eventually reaches every ID (no request stays undiscovered)", async () => {
    resetReconcileSweep();
    const reqs = populate(250, { 7: { fulfilled: false } });
    const server = fakeServer(250n, reqs);

    // 230 older IDs / 20 per pass → 12 passes cover 1..230.
    let found = false;
    let passes = 0;
    for (; passes < 12 && !found; passes++) {
      found = (await findPendingRequests(server, 20)).some((p) => p.requestId === 7n);
    }
    expect(found).toBe(true);
    expect(passes).toBe(12);

    // The sweep then wraps back to the top of the older range.
    const again = await findPendingRequests(server, 20);
    expect(again.some((p) => p.requestId === 7n)).toBe(false); // 211..230 this pass
  });

  it("batches ledger reads within the RPC's 200-key limit", async () => {
    resetReconcileSweep();
    const server = fakeServer(120n, populate(120, {}));

    await findPendingRequests(server, 1000);

    // 120 ids × 4 keys = 480 keys → 3 calls of 40 ids (160 keys)
    const sizes = server.getLedgerEntries.mock.calls.map((c: unknown[]) => c.length);
    expect(sizes).toEqual([160, 160, 160]);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(200);
  });

  it("returns nothing (and does not scan) when no requests exist", async () => {
    const server = fakeServer(0n, new Map());

    expect(await findPendingRequests(server, 1000)).toEqual([]);
    expect(server.getLedgerEntries).not.toHaveBeenCalled();
  });

  it("counts as listener progress for /health", async () => {
    const before = Date.now();
    await findPendingRequests(fakeServer(1n, populate(1, {})), 10);
    expect(getListenerStatus().lastHeartbeatAt).toBeGreaterThanOrEqual(before);
  });
});

describe("decodeEpoch", () => {
  it("decodes the contract's EpochData struct", () => {
    const pk = Buffer.alloc(192, 7);
    const op = "GA6HYAVWPVOVB4XJHGUZSDHRVYOKLPU4JAHYPXZRSJWO2PM4HSCNKP5P";
    // contracttype struct = ScMap with keys in ascending order.
    const val = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("created_ledger"), val: xdr.ScVal.scvU32(5) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("oracle_address"), val: new Address(op).toScVal() }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("oracle_bls_pk"), val: nativeToScVal(pk, { type: "bytes" }) }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("status"),
        val: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Revoked")]),
      }),
    ]);
    const e = decodeEpoch(val);
    expect(Buffer.from(e.oraclePk)).toEqual(pk);
    expect(e.oracleAddress).toBe(op);
    expect(e.status).toBe("Revoked");
  });
});
