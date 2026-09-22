/**
 * feeGuard.ts — bounds what the oracle spends on requests that don't pay for
 * themselves.
 *
 * Problem this solves
 * ───────────────────
 * `request()` is permissionless and the requester pays the on-chain
 * `FeeAmount`, while the oracle pays the network fee of `fulfill()`
 * (~0.14 XLM on Mainnet). When `FeeAmount` is below that cost (the live
 * Mainnet instance has `FeeAmount = 0`, and it is immutable), anyone can make
 * the oracle spend real XLM per request for the price of a cheap `request()`.
 *
 * Two checkpoints
 * ───────────────
 * 1. `check()` — admission, before any drand wait or proof work:
 *      a. Balance floor (fail closed if unreadable).
 *      b. Paid: the fee token is **native XLM** and `FeeAmount >= cost`.
 *         Any other fee token is treated as unpaid: its units are not stroops
 *         and the worker has no price for it.
 *      c. Allowlisted requester: served, not charged to the budget.
 *      d. Anyone else: admitted only if the shared budget still has room for
 *         one more fulfillment.
 *
 * 2. `authorizeSend()` — immediately before EVERY `sendTransaction()`,
 *    including internal and outer retries:
 *      - balance floor again, against the transaction's maximum fee;
 *      - for budget-limited requests, atomically reserve that maximum fee in
 *        the SpendLedger, or refuse to send.
 *
 * Because each transaction reserves its maximum possible fee before it is
 * sent, retries, ambiguous timeouts and resubmissions all count, and the sum
 * can never exceed `unpaidBudgetStroops` per rolling hour. The ledger is shared
 * through Redis in HA and persisted in a file otherwise, so the budget is
 * per deployment, not per process, and survives restarts and failover.
 *
 * What this does NOT give: liveness for non-allowlisted requesters on a
 * zero-fee contract. Once the budget is used (by an attacker or anyone),
 * their requests wait and may end in `timeout_refund()`. Only a deployment
 * with `FeeAmount >= cost` in XLM fixes that.
 */

import type { SpendLedger } from "./spendLedger.js";

export const STROOPS_PER_XLM = 10_000_000n;

export interface FeeGuardOptions {
  /** Estimated network fee of one `fulfill()` transaction, in stroops. */
  fulfillCostStroops: bigint;
  /** Never submit if the balance after paying would drop below this (stroops). */
  minBalanceStroops: bigint;
  /**
   * Max total of transaction max-fees (stroops) spent on unpaid,
   * non-allowlisted requests per rolling hour, across ALL instances. 0 = none.
   */
  unpaidBudgetStroops: bigint;
  /** Requesters (G…/C… addresses) exempt from the budget. */
  allowlist: ReadonlySet<string>;
  /** How long a balance reading is reused at admission (ms). */
  balanceCacheMs: number;
  /** Contract ID of the native XLM SAC on this network. */
  nativeTokenId: string;
}

export interface FeeGuardDeps {
  /** On-chain `FeeAmount` (smallest unit of the fee token). */
  readFeeAmount: () => Promise<bigint>;
  /** On-chain `FeeToken` contract ID. */
  readFeeToken: () => Promise<string>;
  /** Oracle account native balance, in stroops. */
  readBalance: () => Promise<bigint>;
  /** Requester of a request, or null if unknown / expired. */
  readRequester: (requestId: bigint) => Promise<string | null>;
  ledger: SpendLedger;
  now: () => number;
  /** Observability hooks. */
  onBalance?: (stroops: bigint) => void;
  onUnpaidSpend?: (windowTotalStroops: bigint) => void;
}

/** How a request is funded. Only "budget" requests draw on the shared budget. */
export type Funding = "paid" | "allowlisted" | "budget";

export type FeeDecision =
  | { allow: true; funding: Funding; reason: string }
  | { allow: false; reason: string };

export type SendDecision = { ok: true } | { ok: false; reason: string };

/** Parse a decimal XLM amount ("5", "0.15") into stroops without float error. */
export function xlmToStroops(xlm: string): bigint {
  const m = /^(\d+)(?:\.(\d{0,7}))?$/.exec(xlm.trim());
  if (!m) throw new Error(`invalid XLM amount: "${xlm}" (expected e.g. "5" or "0.15")`);
  return BigInt(m[1]) * STROOPS_PER_XLM + BigInt((m[2] ?? "").padEnd(7, "0"));
}

export function formatXlm(stroops: bigint): string {
  const neg = stroops < 0n;
  const abs = neg ? -stroops : stroops;
  const frac = (abs % STROOPS_PER_XLM).toString().padStart(7, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${abs / STROOPS_PER_XLM}${frac ? "." + frac : ""} XLM`;
}

/**
 * Build options from environment variables (see .env.example).
 * `nativeTokenId` comes from the caller (it depends on the network).
 */
export function feeGuardOptionsFromEnv(
  nativeTokenId: string,
  env: NodeJS.ProcessEnv = process.env
): FeeGuardOptions {
  const cost = env.FULFILL_COST_STROOPS ?? "1500000";
  if (!/^\d+$/.test(cost)) throw new Error("FULFILL_COST_STROOPS must be an integer (stroops)");
  const fulfillCostStroops = BigInt(cost);

  let unpaidBudgetStroops: bigint;
  if (env.UNPAID_BUDGET_XLM_PER_HOUR !== undefined) {
    unpaidBudgetStroops = xlmToStroops(env.UNPAID_BUDGET_XLM_PER_HOUR);
  } else if (env.UNPAID_FULFILL_MAX_PER_HOUR !== undefined) {
    // Legacy knob (a request count). Converted to a spend budget.
    const n = Number(env.UNPAID_FULFILL_MAX_PER_HOUR);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error("UNPAID_FULFILL_MAX_PER_HOUR must be an integer >= 0");
    }
    unpaidBudgetStroops = BigInt(n) * fulfillCostStroops;
  } else {
    unpaidBudgetStroops = xlmToStroops("1.5");
  }

  const allowlist = new Set(
    (env.UNPAID_REQUESTER_ALLOWLIST ?? "").split(",").map((a) => a.trim()).filter(Boolean)
  );
  return {
    fulfillCostStroops,
    minBalanceStroops: xlmToStroops(env.MIN_ORACLE_BALANCE_XLM ?? "5"),
    unpaidBudgetStroops,
    allowlist,
    balanceCacheMs: parseInt(env.FEE_GUARD_BALANCE_CACHE_MS ?? "15000", 10),
    nativeTokenId,
  };
}

export class FeeGuard {
  private feeInfo: { amount: bigint; token: string } | null = null;
  private balance: { value: bigint; at: number } | null = null;

  constructor(private deps: FeeGuardDeps, private opts: FeeGuardOptions) {}

  /**
   * Admission: decide whether to start working on `requestId` at all.
   * Records nothing. Spend is only recorded by `authorizeSend()`.
   */
  async check(requestId: bigint, knownRequester: string | null): Promise<FeeDecision> {
    const { fulfillCostStroops: cost, minBalanceStroops: floor } = this.opts;

    // a. Balance floor, which applies to paid requests too.
    let balance: bigint;
    try {
      balance = await this.getBalance(false);
    } catch (err) {
      return { allow: false, reason: `could not read oracle balance (${errMsg(err)}); failing closed` };
    }
    if (balance - cost < floor) {
      return { allow: false, reason: floorReason(balance, cost, floor) };
    }

    // b. Paid by the on-chain fee, only if it is denominated in XLM.
    const fee = await this.getFeeInfo();
    if (fee && fee.token === this.opts.nativeTokenId && fee.amount >= cost) {
      return { allow: true, funding: "paid", reason: `on-chain fee ${fee.amount} stroops (XLM) >= cost ${cost}` };
    }

    // c. Allowlisted requester.
    if (this.opts.allowlist.size > 0) {
      let requester = knownRequester;
      if (!requester) {
        try {
          requester = await this.deps.readRequester(requestId);
        } catch {
          requester = null;
        }
      }
      if (requester && this.opts.allowlist.has(requester)) {
        return { allow: true, funding: "allowlisted", reason: `requester ${requester} is allowlisted` };
      }
    }

    // d. Shared budget must have room for at least one fulfillment.
    let spent: bigint;
    try {
      spent = await this.deps.ledger.spent(this.deps.now());
    } catch (err) {
      return { allow: false, reason: `could not read the unpaid spend ledger (${errMsg(err)}); failing closed` };
    }
    this.deps.onUnpaidSpend?.(spent);
    if (spent + cost > this.opts.unpaidBudgetStroops) {
      return {
        allow: false,
        reason:
          `${describeFee(fee, this.opts.nativeTokenId)} does not cover the fulfill cost and the ` +
          `unpaid budget is used up (${formatXlm(spent)} of ${formatXlm(this.opts.unpaidBudgetStroops)} ` +
          `this hour, UNPAID_BUDGET_XLM_PER_HOUR)`,
      };
    }
    return {
      allow: true,
      funding: "budget",
      reason: `unpaid; ${formatXlm(spent)} of ${formatXlm(this.opts.unpaidBudgetStroops)} budget used this hour`,
    };
  }

  /**
   * Call immediately before EVERY `sendTransaction()`, with the transaction's
   * maximum fee in stroops. For budget-funded requests this atomically
   * reserves `maxFeeStroops` in the shared ledger; if that would exceed the
   * budget, the transaction must not be sent.
   */
  async authorizeSend(funding: Funding, maxFeeStroops: bigint): Promise<SendDecision> {
    let balance: bigint;
    try {
      balance = await this.getBalance(true); // fresh: money is about to move
    } catch (err) {
      return { ok: false, reason: `could not read oracle balance (${errMsg(err)}); failing closed` };
    }
    if (balance - maxFeeStroops < this.opts.minBalanceStroops) {
      return { ok: false, reason: floorReason(balance, maxFeeStroops, this.opts.minBalanceStroops) };
    }
    if (funding !== "budget") return { ok: true };

    const now = this.deps.now();
    let reserved: boolean;
    try {
      reserved = await this.deps.ledger.tryReserve(maxFeeStroops, now, this.opts.unpaidBudgetStroops);
    } catch (err) {
      return { ok: false, reason: `could not update the unpaid spend ledger (${errMsg(err)}); failing closed` };
    }
    if (!reserved) {
      return {
        ok: false,
        reason:
          `sending would exceed the unpaid budget of ${formatXlm(this.opts.unpaidBudgetStroops)}/hour ` +
          `(tx max fee ${formatXlm(maxFeeStroops)})`,
      };
    }
    try {
      this.deps.onUnpaidSpend?.(await this.deps.ledger.spent(now));
    } catch {
      /* metric only */
    }
    return { ok: true };
  }

  /** Forget the cached balance, e.g. after a submission changed it. */
  invalidateBalance(): void {
    this.balance = null;
  }

  private async getBalance(fresh: boolean): Promise<bigint> {
    const now = this.deps.now();
    if (!fresh && this.balance && now - this.balance.at < this.opts.balanceCacheMs) {
      return this.balance.value;
    }
    const value = await this.deps.readBalance();
    this.balance = { value, at: now };
    this.deps.onBalance?.(value);
    return value;
  }

  /** FeeToken/FeeAmount are immutable after init(), so a successful read is cached forever. */
  private async getFeeInfo(): Promise<{ amount: bigint; token: string } | null> {
    if (this.feeInfo) return this.feeInfo;
    try {
      const [amount, token] = await Promise.all([this.deps.readFeeAmount(), this.deps.readFeeToken()]);
      this.feeInfo = { amount, token };
      return this.feeInfo;
    } catch {
      return null; // unknown → treated as unpaid (the conservative choice)
    }
  }
}

function describeFee(fee: { amount: bigint; token: string } | null, native: string): string {
  if (!fee) return "on-chain fee (unknown)";
  if (fee.token !== native) return `on-chain fee ${fee.amount} of non-XLM token ${fee.token} (not priced)`;
  return `on-chain fee ${fee.amount} stroops`;
}

function floorReason(balance: bigint, cost: bigint, floor: bigint): string {
  return (
    `oracle balance ${formatXlm(balance)} minus fee ${formatXlm(cost)} would drop below the floor ` +
    `of ${formatXlm(floor)} (MIN_ORACLE_BALANCE_XLM). Top up the oracle account`
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

