/**
 * feeGuard.test.ts — the oracle's spend on requests that don't pay for
 * themselves is bounded.
 *
 * Regression target: with FeeAmount = 0 on Mainnet, every permissionless
 * request() made the oracle pay ~0.14 XLM for fulfill(), without limit.
 */

import { describe, it, expect, vi } from "vitest";
import {
  FeeGuard,
  feeGuardOptionsFromEnv,
  xlmToStroops,
  formatXlm,
  type FeeGuardDeps,
  type FeeGuardOptions,
} from "./feeGuard.js";

const XLM = 10_000_000n;
const COST = 1_500_000n; // 0.15 XLM
const ALICE = "GA6HYAVWPVOVB4XJHGUZSDHRVYOKLPU4JAHYPXZRSJWO2PM4HSCNKP5P";
const MALLORY = "GBMALLORYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

function setup(over: Partial<FeeGuardOptions> = {}, deps: Partial<FeeGuardDeps> = {}) {
  let clock = 0;
  const d = {
    readFeeAmount: vi.fn(async () => 0n),
    readBalance: vi.fn(async () => 100n * XLM),
    readRequester: vi.fn(async (_id: bigint) => null as string | null),
    now: () => clock,
    onBalance: vi.fn(),
    ...deps,
  };
  const opts: FeeGuardOptions = {
    fulfillCostStroops: COST,
    minBalanceStroops: 5n * XLM,
    maxUnpaidPerHour: 3,
    allowlist: new Set<string>(),
    balanceCacheMs: 15_000,
    ...over,
  };
  return { guard: new FeeGuard(d, opts), deps: d, advance: (ms: number) => (clock += ms) };
}

describe("FeeGuard — zero-fee contract (current Mainnet)", () => {
  it("caps unpaid fulfillments per hour, then defers", async () => {
    const { guard } = setup();
    const results = [];
    for (let i = 1n; i <= 5n; i++) results.push(await guard.check(i, MALLORY));
    expect(results.map((r) => r.allow)).toEqual([true, true, true, false, false]);
    expect(results[3].reason).toMatch(/UNPAID_FULFILL_MAX_PER_HOUR/);
  });

  it("frees budget as the rolling hour passes", async () => {
    const { guard, advance } = setup({ maxUnpaidPerHour: 1 });
    expect((await guard.check(1n, MALLORY)).allow).toBe(true);
    expect((await guard.check(2n, MALLORY)).allow).toBe(false);
    advance(3_600_000);
    expect((await guard.check(3n, MALLORY)).allow).toBe(true);
  });

  it("maxUnpaidPerHour = 0 serves nobody unpaid", async () => {
    const { guard } = setup({ maxUnpaidPerHour: 0 });
    expect((await guard.check(1n, MALLORY)).allow).toBe(false);
  });

  it("serves allowlisted requesters without consuming the cap", async () => {
    const { guard } = setup({ maxUnpaidPerHour: 0, allowlist: new Set([ALICE]) });
    for (let i = 1n; i <= 10n; i++) {
      expect(await guard.check(i, ALICE)).toMatchObject({ allow: true, paid: false });
    }
    expect((await guard.check(11n, MALLORY)).allow).toBe(false);
  });

  it("looks up the requester on-chain when the event didn't carry it (reconciliation)", async () => {
    const { guard, deps } = setup(
      { maxUnpaidPerHour: 0, allowlist: new Set([ALICE]) },
      { readRequester: vi.fn(async () => ALICE) }
    );
    expect((await guard.check(7n, null)).allow).toBe(true);
    expect(deps.readRequester).toHaveBeenCalledWith(7n);
  });

  it("refundUnpaidSlot() returns a slot that was never spent", async () => {
    const { guard } = setup({ maxUnpaidPerHour: 1 });
    expect((await guard.check(1n, MALLORY)).allow).toBe(true);
    guard.refundUnpaidSlot();
    expect((await guard.check(2n, MALLORY)).allow).toBe(true);
  });

  it("treats an unreadable FeeAmount as unpaid (conservative)", async () => {
    const { guard } = setup(
      { maxUnpaidPerHour: 0 },
      { readFeeAmount: vi.fn(async () => { throw new Error("rpc down"); }) }
    );
    expect((await guard.check(1n, MALLORY)).allow).toBe(false);
  });
});

describe("FeeGuard — fee-paying contract (redeployment)", () => {
  it("allows every request whose on-chain fee covers the cost, with no cap", async () => {
    const { guard, deps } = setup({ maxUnpaidPerHour: 0 }, { readFeeAmount: vi.fn(async () => COST) });
    for (let i = 1n; i <= 20n; i++) {
      expect(await guard.check(i, MALLORY)).toMatchObject({ allow: true, paid: true });
    }
    expect(deps.readFeeAmount).toHaveBeenCalledTimes(1); // immutable → cached
  });

  it("a fee below the cost is still unpaid", async () => {
    const { guard } = setup({ maxUnpaidPerHour: 0 }, { readFeeAmount: vi.fn(async () => COST - 1n) });
    expect((await guard.check(1n, MALLORY)).allow).toBe(false);
  });
});

describe("FeeGuard — balance floor", () => {
  it("refuses even paid requests when paying would cross the floor", async () => {
    const { guard } = setup({}, {
      readFeeAmount: vi.fn(async () => COST),
      readBalance: vi.fn(async () => 5n * XLM + COST - 1n),
    });
    const d = await guard.check(1n, ALICE);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/MIN_ORACLE_BALANCE_XLM/);
  });

  it("fails closed when the balance cannot be read", async () => {
    const { guard } = setup({}, { readBalance: vi.fn(async () => { throw new Error("timeout"); }) });
    const d = await guard.check(1n, ALICE);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/failing closed/);
  });

  it("caches the balance briefly, and invalidateBalance() forces a re-read", async () => {
    const { guard, deps, advance } = setup({ maxUnpaidPerHour: 100 });
    await guard.check(1n, MALLORY);
    await guard.check(2n, MALLORY);
    expect(deps.readBalance).toHaveBeenCalledTimes(1);
    guard.invalidateBalance();
    await guard.check(3n, MALLORY);
    expect(deps.readBalance).toHaveBeenCalledTimes(2);
    advance(15_000);
    await guard.check(4n, MALLORY);
    expect(deps.readBalance).toHaveBeenCalledTimes(3);
    expect(deps.onBalance).toHaveBeenCalledWith(100n * XLM);
  });
});

describe("configuration parsing", () => {
  it("parses XLM amounts exactly", () => {
    expect(xlmToStroops("5")).toBe(50_000_000n);
    expect(xlmToStroops("0.15")).toBe(1_500_000n);
    expect(xlmToStroops("0.0000001")).toBe(1n);
    expect(() => xlmToStroops("-1")).toThrow();
    expect(() => xlmToStroops("1.00000001")).toThrow();
    expect(formatXlm(1_500_000n)).toBe("0.15 XLM");
    expect(formatXlm(50_000_000n)).toBe("5 XLM");
  });

  it("has safe defaults and reads the allowlist", () => {
    const d = feeGuardOptionsFromEnv({});
    expect(d).toMatchObject({ fulfillCostStroops: 1_500_000n, minBalanceStroops: 50_000_000n, maxUnpaidPerHour: 10 });
    const o = feeGuardOptionsFromEnv({ UNPAID_REQUESTER_ALLOWLIST: ` ${ALICE} , ,CABC `, UNPAID_FULFILL_MAX_PER_HOUR: "0" });
    expect([...o.allowlist]).toEqual([ALICE, "CABC"]);
    expect(o.maxUnpaidPerHour).toBe(0);
  });

  it("rejects malformed values instead of silently disabling the guard", () => {
    expect(() => feeGuardOptionsFromEnv({ UNPAID_FULFILL_MAX_PER_HOUR: "lots" })).toThrow();
    expect(() => feeGuardOptionsFromEnv({ UNPAID_FULFILL_MAX_PER_HOUR: "-1" })).toThrow();
    expect(() => feeGuardOptionsFromEnv({ FULFILL_COST_STROOPS: "0.15" })).toThrow();
  });
});
