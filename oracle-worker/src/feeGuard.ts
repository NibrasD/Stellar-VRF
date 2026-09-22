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
 * Unbounded, that drains the oracle account and takes the service down.
 *
 * Policy (evaluated before any drand wait / proof work / submission)
 * ──────────────────────────────────────────────────────────────────
 *   1. Balance floor, ALWAYS. Never submit if doing so would take the oracle
 *      account below `minBalanceStroops`. Fail closed if the balance can't be
 *      read.
 *   2. Paid request (on-chain `FeeAmount >= fulfillCostStroops`): allowed. The
 *      escrowed fee is released to the oracle by `fulfill()` itself.
 *   3. Unpaid request, requester on the allowlist: allowed.
 *   4. Unpaid request, anyone else: allowed up to `maxUnpaidPerHour`
 *      (rolling window). Beyond that, deferred.
 *
 * A deferred request is NOT lost: it stays pending on-chain, periodic
 * reconciliation re-offers it, and the requester can always call
 * `timeout_refund()`. The worst case changes from "drain the whole account" to
 * "at most `maxUnpaidPerHour × cost` per hour, and never below the floor".
 *
 * This is an operational mitigation. The structural fix is a deployment whose
 * `FeeAmount` covers the fulfillment cost; then rule 2 covers every request.
 */

export const STROOPS_PER_XLM = 10_000_000n;

export interface FeeGuardOptions {
  /** Estimated network fee of one `fulfill()` transaction, in stroops. */
  fulfillCostStroops: bigint;
  /** Never submit if the balance after paying would drop below this (stroops). */
  minBalanceStroops: bigint;
  /** Max unpaid, non-allowlisted fulfillments per rolling hour. 0 = none. */
  maxUnpaidPerHour: number;
  /** Requesters (G…/C… addresses) exempt from the hourly cap. */
  allowlist: ReadonlySet<string>;
  /** How long a balance reading is reused, to avoid one RPC call per request. */
  balanceCacheMs: number;
}

export interface FeeGuardDeps {
  /** On-chain `FeeAmount` (stroops of the fee token). */
  readFeeAmount: () => Promise<bigint>;
  /** Oracle account native balance, in stroops. */
  readBalance: () => Promise<bigint>;
  /** Requester of a request, or null if unknown / expired. */
  readRequester: (requestId: bigint) => Promise<string | null>;
  now: () => number;
  /** Observability hook, called with every fresh balance reading. */
  onBalance?: (stroops: bigint) => void;
}

export type FeeDecision =
  | { allow: true; paid: boolean; reason: string }
  | { allow: false; reason: string };

const HOUR_MS = 3_600_000;

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

/** Build options from environment variables (see .env.example). */
export function feeGuardOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): FeeGuardOptions {
  const maxUnpaid = Number(env.UNPAID_FULFILL_MAX_PER_HOUR ?? "10");
  if (!Number.isInteger(maxUnpaid) || maxUnpaid < 0) {
    throw new Error("UNPAID_FULFILL_MAX_PER_HOUR must be an integer >= 0");
  }
  const cost = env.FULFILL_COST_STROOPS ?? "1500000";
  if (!/^\d+$/.test(cost)) throw new Error("FULFILL_COST_STROOPS must be an integer (stroops)");
  const allowlist = new Set(
    (env.UNPAID_REQUESTER_ALLOWLIST ?? "").split(",").map((a) => a.trim()).filter(Boolean)
  );
  return {
    fulfillCostStroops: BigInt(cost),
    minBalanceStroops: xlmToStroops(env.MIN_ORACLE_BALANCE_XLM ?? "5"),
    maxUnpaidPerHour: maxUnpaid,
    allowlist,
    balanceCacheMs: parseInt(env.FEE_GUARD_BALANCE_CACHE_MS ?? "15000", 10),
  };
}

export class FeeGuard {
  private feeAmount: bigint | null = null;
  private unpaidTimes: number[] = [];
  private balance: { value: bigint; at: number } | null = null;

  constructor(private deps: FeeGuardDeps, private opts: FeeGuardOptions) {}

  /**
   * Decide whether to spend money fulfilling `requestId`.
   * `knownRequester` avoids an RPC read when the event already carried it.
   * Consumes an hourly slot when it allows an unpaid request; give it back with
   * `refundUnpaidSlot()` if nothing was spent.
   */
  async check(requestId: bigint, knownRequester: string | null): Promise<FeeDecision> {
    const { fulfillCostStroops: cost, minBalanceStroops: floor } = this.opts;

    // 1. Balance floor, which applies to paid requests too.
    let balance: bigint;
    try {
      balance = await this.getBalance();
    } catch (err) {
      return { allow: false, reason: `could not read oracle balance (${errMsg(err)}); failing closed` };
    }
    if (balance - cost < floor) {
      return {
        allow: false,
        reason:
          `oracle balance ${formatXlm(balance)} minus fulfill cost ${formatXlm(cost)} would drop ` +
          `below the floor of ${formatXlm(floor)} (MIN_ORACLE_BALANCE_XLM). Top up the oracle account`,
      };
    }

    // 2. Paid by the on-chain fee.
    const fee = await this.getFeeAmount();
    if (fee !== null && fee >= cost) {
      return { allow: true, paid: true, reason: `on-chain fee ${fee} >= cost ${cost} stroops` };
    }

    // 3. Allowlisted requester.
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
        return { allow: true, paid: false, reason: `requester ${requester} is allowlisted` };
      }
    }

    // 4. Rolling hourly cap on unpaid fulfillments.
    const now = this.deps.now();
    this.unpaidTimes = this.unpaidTimes.filter((t) => now - t < HOUR_MS);
    if (this.unpaidTimes.length >= this.opts.maxUnpaidPerHour) {
      return {
        allow: false,
        reason:
          `on-chain fee (${fee ?? "unknown"}) does not cover the fulfill cost (${cost} stroops) and ` +
          `the unpaid budget of ${this.opts.maxUnpaidPerHour}/hour (UNPAID_FULFILL_MAX_PER_HOUR) is used up`,
      };
    }
    this.unpaidTimes.push(now);
    return {
      allow: true,
      paid: false,
      reason: `unpaid ${this.unpaidTimes.length}/${this.opts.maxUnpaidPerHour} this hour`,
    };
  }

  /**
   * Return the most recent unpaid slot when the fulfillment was abandoned
   * before any transaction was sent (e.g. leadership lost, already fulfilled).
   */
  refundUnpaidSlot(): void {
    this.unpaidTimes.pop();
  }

  /** Forget the cached balance, e.g. after a submission changed it. */
  invalidateBalance(): void {
    this.balance = null;
  }

  private async getBalance(): Promise<bigint> {
    const now = this.deps.now();
    if (this.balance && now - this.balance.at < this.opts.balanceCacheMs) {
      return this.balance.value;
    }
    const value = await this.deps.readBalance();
    this.balance = { value, at: now };
    this.deps.onBalance?.(value);
    return value;
  }

  /** FeeAmount is immutable after init(), so a successful read is cached forever. */
  private async getFeeAmount(): Promise<bigint | null> {
    if (this.feeAmount !== null) return this.feeAmount;
    try {
      this.feeAmount = await this.deps.readFeeAmount();
      return this.feeAmount;
    } catch {
      return null; // unknown → treated as unpaid (the conservative choice)
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
