/**
 * feeGuard.test.ts — the oracle's spend on requests that don't pay for
 * themselves is a hard cap, per deployment.
 *
 * Regression targets:
 *  - FeeAmount = 0 on Mainnet: every permissionless request() made the oracle
 *    pay ~0.14 XLM for fulfill(), without limit.
 *  - The first guard counted ADMITTED REQUESTS per PROCESS: retries/timeouts
 *    of one request cost several fees, and each HA instance (or a restart) got
 *    its own fresh budget.
 *  - FeeAmount was assumed to be stroops even for a non-XLM fee token.
 */

import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  FeeGuard,
  feeGuardOptionsFromEnv,
  xlmToStroops,
  formatXlm,
  type FeeGuardDeps,
  type FeeGuardOptions,
} from "./feeGuard.js";
import { MemorySpendLedger, FileSpendLedger, ledgerMember, type SpendLedger } from "./spendLedger.js";

const XLM = 10_000_000n;
const COST = 1_500_000n; // 0.15 XLM
const NATIVE = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const ALICE = "GA6HYAVWPVOVB4XJHGUZSDHRVYOKLPU4JAHYPXZRSJWO2PM4HSCNKP5P";
const MALLORY = "GBMALLORYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

function setup(
  over: Partial<FeeGuardOptions> = {},
  deps: Partial<FeeGuardDeps> = {},
  clockRef = { t: 0 }
) {
  const d: FeeGuardDeps = {
    readFeeAmount: vi.fn(async () => 0n),
    readFeeToken: vi.fn(async () => NATIVE),
    readBalance: vi.fn(async () => 100n * XLM),
    readRequester: vi.fn(async (_id: bigint) => null as string | null),
    ledger: new MemorySpendLedger(),
    paidLedger: new MemorySpendLedger(),
    now: () => clockRef.t,
    onBalance: vi.fn(),
    onUnpaidSpend: vi.fn(),
    ...deps,
  };
  const opts: FeeGuardOptions = {
    paidFailureBudgetStroops: 100n * XLM,
    fulfillCostStroops: COST,
    minBalanceStroops: 5n * XLM,
    unpaidBudgetStroops: 3n * COST,
    allowlist: new Set<string>(),
    balanceCacheMs: 15_000,
    nativeTokenId: NATIVE,
    ...over,
  };
  return { guard: new FeeGuard(d, opts), deps: d, advance: (ms: number) => (clockRef.t += ms) };
}

/** Simulates the worker: admission, then one authorizeSend per send attempt. */
async function fulfillWithAttempts(guard: FeeGuard, id: bigint, attempts: number, fee = COST) {
  const d = await guard.check(id, MALLORY);
  if (!d.allow) return { admitted: false, sent: 0 };
  let sent = 0;
  for (let i = 0; i < attempts; i++) {
    if (!(await guard.authorizeSend(d.funding, fee)).ok) break;
    sent++;
  }
  return { admitted: true, sent };
}

describe("FeeGuard — unpaid budget is a hard cap on transaction fees", () => {
  it("admits until the budget cannot fit one more fulfillment", async () => {
    const { guard } = setup();
    const out = [];
    for (let i = 1n; i <= 5n; i++) out.push(await fulfillWithAttempts(guard, i, 1));
    expect(out.map((o) => o.admitted)).toEqual([true, true, true, false, false]);
  });

  it("counts every send, so retries of ONE request use up the budget", async () => {
    const { guard } = setup(); // budget = 3 × cost
    const r = await fulfillWithAttempts(guard, 1n, 10);
    expect(r.sent).toBe(3); // the 4th send is refused
    expect((await guard.check(2n, MALLORY)).allow).toBe(false);
  });

  it("reserves the transaction's real max fee, not the estimate", async () => {
    const { guard } = setup({ unpaidBudgetStroops: 10n * COST });
    const r = await fulfillWithAttempts(guard, 1n, 10, 4n * COST);
    expect(r.sent).toBe(2); // a third 4×COST send would exceed 10×COST
  });

  it("never lets the total exceed the budget, whatever the attempt pattern", async () => {
    const ledger = new MemorySpendLedger();
    const budget = 7n * COST;
    const { guard } = setup({ unpaidBudgetStroops: budget }, { ledger });
    for (let i = 1n; i <= 20n; i++) await fulfillWithAttempts(guard, i, Number(i % 4n) + 1, COST + i);
    expect(await ledger.spent(0)).toBeLessThanOrEqual(budget);
  });

  it("frees budget as the rolling hour passes", async () => {
    const { guard, advance } = setup({ unpaidBudgetStroops: COST });
    expect((await fulfillWithAttempts(guard, 1n, 1)).sent).toBe(1);
    expect((await guard.check(2n, MALLORY)).allow).toBe(false);
    advance(3_600_000);
    expect((await fulfillWithAttempts(guard, 3n, 1)).sent).toBe(1);
  });

  it("budget 0 serves nobody unpaid", async () => {
    const { guard } = setup({ unpaidBudgetStroops: 0n });
    expect((await guard.check(1n, MALLORY)).allow).toBe(false);
  });
});

describe("FeeGuard — the budget is per deployment, not per process", () => {
  it("primary + standby sharing one ledger share one budget (failover)", async () => {
    const shared = new MemorySpendLedger(); // stands in for the Redis ledger
    const clock = { t: 0 };
    const primary = setup({}, { ledger: shared }, clock).guard;
    const standby = setup({}, { ledger: shared }, clock).guard;

    expect((await fulfillWithAttempts(primary, 1n, 1)).sent).toBe(1);
    expect((await fulfillWithAttempts(primary, 2n, 1)).sent).toBe(1);
    expect((await fulfillWithAttempts(standby, 3n, 1)).sent).toBe(1);
    expect((await standby.check(4n, MALLORY)).allow).toBe(false);
    expect((await primary.check(5n, MALLORY)).allow).toBe(false);
  });

  it("a restart does not reset the budget (file ledger)", async () => {
    const file = path.join(os.tmpdir(), `vrf-spend-test-${process.pid}-${Date.now()}.json`);
    try {
      const first = setup({ unpaidBudgetStroops: 2n * COST }, { ledger: new FileSpendLedger(file) });
      expect((await fulfillWithAttempts(first.guard, 1n, 2)).sent).toBe(2);
      const second = setup({ unpaidBudgetStroops: 2n * COST }, { ledger: new FileSpendLedger(file) });
      expect((await second.guard.check(2n, MALLORY)).allow).toBe(false);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("fails closed when the ledger is unavailable", async () => {
    const broken: SpendLedger = {
      spent: async () => { throw new Error("redis down"); },
      tryReserve: async () => { throw new Error("redis down"); },
      release: async () => { throw new Error("redis down"); },
      describe: () => "broken",
    };
    const { guard } = setup({}, { ledger: broken });
    expect((await guard.check(1n, MALLORY)).allow).toBe(false);
    expect(await guard.authorizeSend("budget", COST)).toMatchObject({ ok: false });
    // Paid requests fail closed too when their ledger is down.
    const paid = setup({}, { paidLedger: broken, readFeeAmount: vi.fn(async () => COST) });
    expect((await paid.guard.check(1n, MALLORY)).allow).toBe(false);
    expect(await paid.guard.authorizeSend("paid", COST, "p")).toMatchObject({ ok: false });
  });

  it("a corrupt ledger file fails closed instead of granting a full budget", async () => {
    const file = path.join(os.tmpdir(), `vrf-spend-corrupt-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(file, "{not json");
    try {
      const { guard } = setup({}, { ledger: new FileSpendLedger(file) });
      expect((await guard.check(1n, MALLORY)).allow).toBe(false);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

describe("FeeGuard — allowlist", () => {
  it("serves allowlisted requesters without touching the budget", async () => {
    const ledger = new MemorySpendLedger();
    const { guard } = setup({ unpaidBudgetStroops: 0n, allowlist: new Set([ALICE]) }, { ledger });
    for (let i = 1n; i <= 10n; i++) {
      expect(await guard.check(i, ALICE)).toMatchObject({ allow: true, funding: "allowlisted" });
      expect(await guard.authorizeSend("allowlisted", COST)).toEqual({ ok: true });
    }
    expect(await ledger.spent(0)).toBe(0n);
    expect((await guard.check(11n, MALLORY)).allow).toBe(false);
  });

  it("looks up the requester on-chain when the event didn't carry it", async () => {
    const { guard, deps } = setup(
      { unpaidBudgetStroops: 0n, allowlist: new Set([ALICE]) },
      { readRequester: vi.fn(async () => ALICE) }
    );
    expect((await guard.check(7n, null)).allow).toBe(true);
    expect(deps.readRequester).toHaveBeenCalledWith(7n);
  });
});

describe("FeeGuard — fee token", () => {
  it("a fee in native XLM that covers the cost is paid, with no budget use", async () => {
    const ledger = new MemorySpendLedger();
    const { guard, deps } = setup(
      { unpaidBudgetStroops: 0n },
      { ledger, readFeeAmount: vi.fn(async () => COST) }
    );
    for (let i = 1n; i <= 20n; i++) {
      expect(await guard.check(i, MALLORY)).toMatchObject({ allow: true, funding: "paid" });
      const d = await guard.authorizeSend("paid", COST, `tx${i}`);
      expect(d.ok).toBe(true);
      if (d.ok && d.reservation) await guard.settleSend(d.reservation, "success");
    }
    expect(await ledger.spent(0)).toBe(0n);
    expect(deps.readFeeAmount).toHaveBeenCalledTimes(1); // immutable → cached
  });

  it("a paid request whose max tx fee exceeds the on-chain fee charges only the shortfall", async () => {
    const ledger = new MemorySpendLedger();
    const { guard } = setup(
      { unpaidBudgetStroops: 2n * COST },
      { ledger, readFeeAmount: vi.fn(async () => COST) }
    );
    expect(await guard.check(1n, MALLORY)).toMatchObject({ allow: true, funding: "paid" });
    // Max fee 0.4 XLM, fee covers 0.15 XLM: 0.25 XLM is unreimbursed.
    const a = await guard.authorizeSend("paid", 4_000_000n, "a");
    expect(a).toMatchObject({ ok: true, reservation: { unpaid: 4_000_000n - COST, covered: COST } });
    if (a.ok && a.reservation) await guard.settleSend(a.reservation, "success");
    // Success releases only the covered part; the shortfall is a real loss.
    expect(await ledger.spent(0)).toBe(4_000_000n - COST);
    // A max fee within the on-chain fee costs the unpaid budget nothing.
    const b = await guard.authorizeSend("paid", COST, "b");
    if (b.ok && b.reservation) await guard.settleSend(b.reservation, "success");
    expect(await ledger.spent(0)).toBe(4_000_000n - COST);
    // Shortfalls are capped by the same budget: 2.5M + 2.5M > 3M.
    expect(await guard.authorizeSend("paid", 4_000_000n, "c")).toMatchObject({ ok: false });
  });

  it("a large FeeAmount in a NON-XLM token is NOT treated as paid", async () => {
    const { guard } = setup(
      { unpaidBudgetStroops: 0n },
      { readFeeAmount: vi.fn(async () => 1_000_000_000n), readFeeToken: vi.fn(async () => USDC) }
    );
    const d = await guard.check(1n, MALLORY);
    expect(d.allow).toBe(false);
    expect(!d.allow && d.reason).toMatch(/non-XLM token/);
  });

  it("a fee below the cost is unpaid", async () => {
    const { guard } = setup({ unpaidBudgetStroops: 0n }, { readFeeAmount: vi.fn(async () => COST - 1n) });
    expect((await guard.check(1n, MALLORY)).allow).toBe(false);
  });

  it("an unreadable fee token is treated as unpaid", async () => {
    const { guard } = setup(
      { unpaidBudgetStroops: 0n },
      { readFeeAmount: vi.fn(async () => COST), readFeeToken: vi.fn(async () => { throw new Error("rpc"); }) }
    );
    expect((await guard.check(1n, MALLORY)).allow).toBe(false);
  });
});


describe("FeeGuard — paid requests whose fee covers the max fee are no longer a bypass", () => {
  // FeeAmount = maxFee = 6 XLM; paid-failure budget 12 XLM.
  const SIX = 6n * XLM;
  function paidSetup() {
    const paidLedger = new MemorySpendLedger();
    const ledger = new MemorySpendLedger();
    const { guard } = setup(
      { paidFailureBudgetStroops: 2n * SIX, unpaidBudgetStroops: 0n },
      { ledger, paidLedger, readFeeAmount: vi.fn(async () => SIX) }
    );
    const send = async (id: string, outcome?: "success" | "not_included" | "failed" | "unknown") => {
      const d = await guard.authorizeSend("paid", SIX, id);
      if (d.ok && d.reservation && outcome) await guard.settleSend(d.reservation, outcome, { hash: id });
      return d;
    };
    return { guard, paidLedger, ledger, send };
  }

  it("failed sends consume the budget: 6 + 6, then the third is refused", async () => {
    const { paidLedger, ledger, send } = paidSetup();
    expect((await send("t1", "failed")).ok).toBe(true);
    expect(await paidLedger.spent(0)).toBe(SIX);
    expect((await send("t2", "failed")).ok).toBe(true);
    expect(await paidLedger.spent(0)).toBe(2n * SIX);
    const third = await send("t3");
    expect(third.ok).toBe(false);
    expect(!third.ok && third.reason).toMatch(/PAID_FAILURE_BUDGET_XLM_PER_HOUR/);
    expect(await ledger.spent(0)).toBe(0n); // the unpaid budget is untouched
  });

  it("a successful send is released, so the next one is allowed", async () => {
    const { paidLedger, send } = paidSetup();
    for (let i = 0; i < 10; i++) expect((await send(`ok${i}`, "success")).ok).toBe(true);
    expect(await paidLedger.spent(0)).toBe(0n);
  });

  it("a pre-inclusion rejection (tx_bad_seq) is released, NOT counted as spent", async () => {
    const { paidLedger, send } = paidSetup();
    expect((await send("bad-seq-1", "not_included")).ok).toBe(true);
    expect(await paidLedger.spent(0)).toBe(0n);
    for (let i = 0; i < 5; i++) expect((await send(`bad-seq-r${i}`, "not_included")).ok).toBe(true);
    expect(await paidLedger.spent(0)).toBe(0n); // transient RPC trouble never blocks paid requests
    expect((await send("real", "success")).ok).toBe(true);
  });

  it("an unknown outcome stays reserved until resolved", async () => {
    const { guard, paidLedger, send } = paidSetup();
    await send("u-ok", "unknown");
    await send("u-fail", "unknown");
    expect(await paidLedger.spent(0)).toBe(2n * SIX);
    expect((await send("blocked")).ok).toBe(false);
    expect(guard.pendingCount()).toBe(2);

    // Still NOT_FOUND inside its validity window: nothing changes.
    const status: Record<string, "SUCCESS" | "FAILED" | "NOT_FOUND"> = { "u-ok": "NOT_FOUND", "u-fail": "FAILED" };
    await guard.resolvePending(async (h) => ({ status: status[h], latestLedgerCloseTimeMs: 0 }));
    expect(await paidLedger.spent(0)).toBe(2n * SIX); // FAILED stays spent
    expect(guard.pendingCount()).toBe(1);
    // Later found SUCCESS → released.
    status["u-ok"] = "SUCCESS";
    expect(await guard.resolvePending(async (h) => ({ status: status[h], latestLedgerCloseTimeMs: 0 }))).toBe(1);
    expect(await paidLedger.spent(0)).toBe(SIX);
    expect(guard.pendingCount()).toBe(0);
  });

  it("an unknown send that provably expired unseen is released", async () => {
    const { guard, paidLedger } = paidSetup();
    const d = await guard.authorizeSend("paid", SIX, "expired");
    if (d.ok && d.reservation) {
      await guard.settleSend(d.reservation, "unknown", { hash: "expired", validUntilMs: 1_000 });
    }
    await guard.resolvePending(async () => ({ status: "NOT_FOUND", latestLedgerCloseTimeMs: 999 }));
    expect(await paidLedger.spent(0)).toBe(SIX); // not past maxTime yet
    await guard.resolvePending(async () => ({ status: "NOT_FOUND", latestLedgerCloseTimeMs: 1_001 }));
    expect(await paidLedger.spent(0)).toBe(0n);
  });

  it("admission defers paid requests while the failure budget is used up", async () => {
    const { guard, send } = paidSetup();
    await send("f1", "failed");
    await send("f2", "failed");
    const d = await guard.check(9n, MALLORY);
    expect(d.allow).toBe(false);
    expect(!d.allow && d.reason).toMatch(/failure budget/);
  });

  it("a refused paid-exposure reservation undoes the unpaid part (all or nothing)", async () => {
    const ledger = new MemorySpendLedger();
    const { guard } = setup(
      { paidFailureBudgetStroops: 0n, unpaidBudgetStroops: 10n * XLM },
      { ledger, readFeeAmount: vi.fn(async () => COST) }
    );
    expect((await guard.authorizeSend("paid", 4_000_000n, "x")).ok).toBe(false);
    expect(await ledger.spent(0)).toBe(0n);
  });
});

describe("SpendLedger reservations (release by exact id + amount)", () => {
  it("member string puts the amount first, as RESERVE_LUA parses it", () => {
    expect(ledgerMember(6_000_000n, "fulfill:abc")).toBe("6000000:fulfill:abc");
    expect(/^(\d+):/.exec(ledgerMember(6_000_000n, "fulfill:abc"))?.[1]).toBe("6000000");
  });

  for (const [name, make] of [
    ["memory", () => new MemorySpendLedger()],
    ["file", () => new FileSpendLedger(path.join(os.tmpdir(), `vrf-ledger-${process.pid}-${Math.random()}.json`))],
  ] as const) {
    it(`${name}: release removes exactly one matching reservation`, async () => {
      const l: SpendLedger = make();
      expect(await l.tryReserve(5n, 0, 100n, "a")).toBe(true);
      expect(await l.tryReserve(7n, 0, 100n, "b")).toBe(true);
      expect(await l.tryReserve(3n, 0, 100n)).toBe(true); // permanent, no id
      expect(await l.release("a", 6n, 0)).toBe(false); // wrong amount: no match
      expect(await l.release("a", 5n, 0)).toBe(true);
      expect(await l.release("a", 5n, 0)).toBe(false); // idempotent
      expect(await l.spent(0)).toBe(10n);
    });
  }

  it("rejects ids that could break the Redis member format", async () => {
    const l = new MemorySpendLedger();
    await expect(l.tryReserve(1n, 0, 10n, "bad id with spaces")).rejects.toThrow(/reservation id/);
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
    expect(!d.allow && d.reason).toMatch(/MIN_ORACLE_BALANCE_XLM/);
  });

  it("re-checks the floor at send time with a FRESH balance", async () => {
    let balance = 100n * XLM;
    const { guard, deps } = setup({}, { readBalance: vi.fn(async () => balance) });
    expect((await guard.check(1n, MALLORY)).allow).toBe(true);
    balance = 5n * XLM; // drained between admission and send
    expect(await guard.authorizeSend("paid", COST)).toMatchObject({ ok: false });
    expect(deps.readBalance).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the balance cannot be read", async () => {
    const { guard } = setup({}, { readBalance: vi.fn(async () => { throw new Error("timeout"); }) });
    const d = await guard.check(1n, ALICE);
    expect(d.allow).toBe(false);
    expect(!d.allow && d.reason).toMatch(/failing closed/);
  });

  it("caches the balance at admission; invalidateBalance() forces a re-read", async () => {
    const { guard, deps, advance } = setup({ unpaidBudgetStroops: 100n * COST });
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
    expect(feeGuardOptionsFromEnv(NATIVE, {})).toMatchObject({
      fulfillCostStroops: 1_500_000n,
      minBalanceStroops: 50_000_000n,
      unpaidBudgetStroops: 15_000_000n, // 1.5 XLM/hour
      nativeTokenId: NATIVE,
    });
    const o = feeGuardOptionsFromEnv(NATIVE, {
      UNPAID_REQUESTER_ALLOWLIST: ` ${ALICE} , ,CABC `,
      UNPAID_BUDGET_XLM_PER_HOUR: "0",
    });
    expect([...o.allowlist]).toEqual([ALICE, "CABC"]);
    expect(o.unpaidBudgetStroops).toBe(0n);
  });

  it("converts the legacy UNPAID_FULFILL_MAX_PER_HOUR count into a spend budget", () => {
    expect(feeGuardOptionsFromEnv(NATIVE, { UNPAID_FULFILL_MAX_PER_HOUR: "4" }).unpaidBudgetStroops).toBe(4n * COST);
    expect(
      feeGuardOptionsFromEnv(NATIVE, { UNPAID_FULFILL_MAX_PER_HOUR: "4", UNPAID_BUDGET_XLM_PER_HOUR: "1" })
        .unpaidBudgetStroops
    ).toBe(XLM); // the explicit budget wins
  });

  it("rejects malformed values instead of silently disabling the guard", () => {
    expect(() => feeGuardOptionsFromEnv(NATIVE, { UNPAID_FULFILL_MAX_PER_HOUR: "lots" })).toThrow();
    expect(() => feeGuardOptionsFromEnv(NATIVE, { UNPAID_FULFILL_MAX_PER_HOUR: "-1" })).toThrow();
    expect(() => feeGuardOptionsFromEnv(NATIVE, { UNPAID_BUDGET_XLM_PER_HOUR: "-1" })).toThrow();
    expect(() => feeGuardOptionsFromEnv(NATIVE, { FULFILL_COST_STROOPS: "0.15" })).toThrow();
  });
});

