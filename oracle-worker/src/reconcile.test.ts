/**
 * reconcile.test.ts — recovery of open requests from the chain.
 *
 * Uses the REAL @stellar/stellar-sdk XDR types (only the RPC server is faked),
 * so the event values and ledger keys here are the bytes a real RPC node
 * exchanges.
 *
 * V2 request ids are derived from the requester and its nonce, so they are
 * not sequential and cannot be found by counting. Reconciliation lists recent
 * `request` events and checks each id's Fulfilled / Refunded marker.
 */

import { describe, it, expect, vi } from "vitest";
import { xdr, scValToNative, Address, nativeToScVal } from "@stellar/stellar-sdk";

vi.mock("./config.js", () => ({
  WORKER_CONCURRENCY: 4,
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

import { findPendingRequests, decodeEpoch } from "./listener.js";
import { getListenerStatus } from "./metrics.js";

const REQUESTER = "GA6HYAVWPVOVB4XJHGUZSDHRVYOKLPU4JAHYPXZRSJWO2PM4HSCNKP5P";

interface FakeRequest {
  id: bigint;
  ledger: number;
  round: bigint;
  epoch: number;
  /** undefined = marker absent (V2 writes Fulfilled/Refunded only when true). */
  fulfilled?: boolean;
  refunded?: boolean;
}

/** Fake RPC: `request` events plus the Fulfilled / Refunded ledger entries. */
function fakeServer(requests: FakeRequest[], latestLedger = 10_000, oldestLedger = 1) {
  const events = requests
    .slice()
    .sort((a, b) => a.ledger - b.ledger)
    .map((r) => ({
      ledger: r.ledger,
      value: xdr.ScVal.scvVec([
        xdr.ScVal.scvU64(r.id),
        new Address(REQUESTER).toScVal(),
        xdr.ScVal.scvU32(r.epoch),
        xdr.ScVal.scvU64(r.round),
      ]),
    }));

  const getHealth = vi.fn(async () => ({ status: "healthy", latestLedger, oldestLedger }));

  // Pages by position: the cursor is the index of the next event.
  const getEvents = vi.fn(async (req: any) => {
    const from = req.cursor !== undefined ? Number(req.cursor) : events.findIndex((e) => e.ledger >= req.startLedger);
    const start = from < 0 ? events.length : from;
    const page = events.slice(start, start + req.limit);
    return { events: page, cursor: String(start + page.length), latestLedger };
  });

  const getLedgerEntries = vi.fn(async (...keys: any[]) => {
    const entries = [];
    for (const k of keys) {
      const scKey: xdr.ScVal = k.contractData.key;
      const [name, rawId] = scValToNative(scKey) as [string, bigint];
      const req = requests.find((r) => r.id === BigInt(rawId));
      if (!req) continue;
      const flag = name === "Fulfilled" ? req.fulfilled : name === "Refunded" ? req.refunded : undefined;
      if (flag === undefined) continue; // marker absent → RPC omits the entry
      entries.push({ key: k, val: { contractData: { key: scKey, val: xdr.ScVal.scvBool(flag) } } });
    }
    return { entries, latestLedger };
  });

  return { getHealth, getEvents, getLedgerEntries } as any;
}

// Non-sequential ids, as the contract produces them.
const ID_A = 7450777608292806116n;
const ID_B = 12819282031553731624n;
const ID_C = 3971875892804378338n;

describe("findPendingRequests", () => {
  it("returns open requests (no marker) with their epoch and round, oldest first", async () => {
    const server = fakeServer([
      { id: ID_B, ledger: 9_950, round: 2002n, epoch: 3 },
      { id: ID_A, ledger: 9_900, round: 2001n, epoch: 1 },
    ]);
    expect(await findPendingRequests(server, 600)).toEqual([
      { requestId: ID_A, requiredRound: 2001n, epochId: 1 },
      { requestId: ID_B, requiredRound: 2002n, epochId: 3 },
    ]);
  });

  it("excludes fulfilled and refunded requests", async () => {
    const server = fakeServer([
      { id: ID_A, ledger: 9_900, round: 1n, epoch: 1, fulfilled: true },
      { id: ID_B, ledger: 9_910, round: 2n, epoch: 1, refunded: true },
      { id: ID_C, ledger: 9_920, round: 3n, epoch: 1 },
    ]);
    const pending = await findPendingRequests(server, 600);
    expect(pending.map((p) => p.requestId)).toEqual([ID_C]);
  });

  it("only looks back the configured number of ledgers", async () => {
    const server = fakeServer([
      { id: ID_A, ledger: 9_000, round: 1n, epoch: 1 }, // older than the look-back
      { id: ID_B, ledger: 9_700, round: 2n, epoch: 1 },
    ]);
    const pending = await findPendingRequests(server, 600);
    expect(pending.map((p) => p.requestId)).toEqual([ID_B]);
    expect(server.getEvents.mock.calls[0][0].startLedger).toBe(9_400);
  });

  it("never asks the RPC for a ledger outside its retention window", async () => {
    const server = fakeServer([{ id: ID_A, ledger: 9_990, round: 1n, epoch: 1 }], 10_000, 9_800);
    await findPendingRequests(server, 600);
    expect(server.getEvents.mock.calls[0][0].startLedger).toBe(9_801);
  });

  it("pages through more events than one page holds, and batches ledger reads within 200 keys", async () => {
    const many: FakeRequest[] = Array.from({ length: 450 }, (_, i) => ({
      id: BigInt(1_000_000 + i),
      ledger: 9_500 + i,
      round: BigInt(i),
      epoch: 1,
      fulfilled: i !== 449 ? true : undefined,
    }));
    const server = fakeServer(many);
    const pending = await findPendingRequests(server, 600);
    expect(pending.map((p) => p.requestId)).toEqual([1_000_449n]);
    expect(server.getEvents).toHaveBeenCalledTimes(3); // 200 + 200 + 50
    const sizes = server.getLedgerEntries.mock.calls.map((c: unknown[]) => c.length);
    expect(sizes).toEqual([200, 200, 200, 200, 100]);
  });

  it("returns nothing when there are no recent requests", async () => {
    const server = fakeServer([]);
    expect(await findPendingRequests(server, 600)).toEqual([]);
    expect(server.getLedgerEntries).not.toHaveBeenCalled();
  });

  it("counts as listener progress for /health", async () => {
    const before = Date.now();
    await findPendingRequests(fakeServer([]), 10);
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
