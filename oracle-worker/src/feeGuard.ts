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
  /**
   * Max total of max-fees (stroops) that may be at risk on PAID requests per
   * rolling hour: reserved before each send, released when the fulfill
   * succeeds (the on-chain fee reimburses it) or never entered a ledger.
   * Failed and unresolved sends stay counted. Separate from the unpaid budget.
   */
  paidFailureBudgetStroops: bigint;
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
  /** Unpaid spend (budget-funded requests and paid shortfalls). */
  ledger: SpendLedger;
  /** Temporary reservations for the reimbursable part of paid sends. */
  paidLedger: SpendLedger;
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

/** What one send reserved, so its outcome can release the right parts. */
export interface SendReservation {
  id: string;
  /** In `ledger`: never reimbursed. Released only if the tx never entered a ledger. */
  unpaid: bigint;
  /** In `paidLedger`: reimbursed on success. Released on success or non-inclusion. */
  covered: bigint;
}

export type SendDecision =
  | { ok: true; reservation?: SendReservation }
  | { ok: false; reason: string };

/**
 * How a sent transaction ended, as far as fees go:
 *  - `success`      applied; the contract paid the oracle from escrow.
 *  - `not_included` rejected by the RPC/core before entering any ledger
 *                   (sendTransaction status ERROR / TRY_AGAIN_LATER, or
 *                   provably expired unseen): no fee was charged.
 *  - `failed`       applied and failed: the fee was charged.
 *  - `unknown`      no answer (RPC error, confirmation timeout).
 */
export type SendOutcome = "success" | "not_included" | "failed" | "unknown";

/** Resolver answer for an `unknown` send, from getTransaction. */
export interface TxLookup {
  status: "SUCCESS" | "FAILED" | "NOT_FOUND";
  /** Close time (ms) of the RPC's latest ledger. */
  latestLedgerCloseTimeMs: number;
}

interface PendingUnknown {
  reservation: SendReservation;
  hash: string;
  /** After a ledger past this time closes without the tx, it can never land. */
  validUntilMs: number;
}

/** Fallback validity when the tx's maxTime is unknown: > the 120 s tx timeout + margin. */
const UNKNOWN_VALIDITY_FALLBACK_MS = 5 * 60_000;

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
    paidFailureBudgetStroops: xlmToStroops(env.PAID_FAILURE_BUDGET_XLM_PER_HOUR ?? "10"),
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
  private pending = new Map<string, PendingUnknown>();
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
      // Don't start drand/proof work if paid sends can't be authorized anyway.
      let atRisk: bigint;
      try {
        atRisk = await this.deps.paidLedger.spent(this.deps.now());
      } catch (err) {
        return { allow: false, reason: `could not read the paid-exposure ledger (${errMsg(err)}); failing closed` };
      }
      if (atRisk + cost > this.opts.paidFailureBudgetStroops) {
        return {
          allow: false,
          reason:
            `paid-request failure budget used up (${formatXlm(atRisk)} of ` +
            `${formatXlm(this.opts.paidFailureBudgetStroops)} at risk this hour, PAID_FAILURE_BUDGET_XLM_PER_HOUR)`,
        };
      }
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
   * maximum fee in stroops and a unique id for this send (the tx hash). Both
   * parts of the max fee are reserved atomically, all or nothing:
   *  - unpaid part → unpaid budget (`UNPAID_BUDGET_XLM_PER_HOUR`);
   *  - covered part → paid-exposure budget (`PAID_FAILURE_BUDGET_XLM_PER_HOUR`).
   * If either doesn't fit, nothing is reserved and nothing must be sent.
   * Report how the send ended with `settleSend()`.
   */
  async authorizeSend(funding: Funding, maxFeeStroops: bigint, id?: string): Promise<SendDecision> {
    let balance: bigint;
    try {
      balance = await this.getBalance(true); // fresh: money is about to move
    } catch (err) {
      return { ok: false, reason: `could not read oracle balance (${errMsg(err)}); failing closed` };
    }
    if (balance - maxFeeStroops < this.opts.minBalanceStroops) {
      return { ok: false, reason: floorReason(balance, maxFeeStroops, this.opts.minBalanceStroops) };
    }
    if (funding === "allowlisted") return { ok: true };

    // Split the max fee. `unpaid` is never reimbursed: the whole max fee of a
    // budget-funded request, or the part of a paid request's max fee ABOVE the
    // on-chain fee. `covered` is reimbursed from escrow, but only if the
    // fulfill succeeds. A paid request whose fee covered the max fee used to
    // skip the ledgers entirely, so failing paid sends were unbounded.
    let covered = 0n;
    if (funding === "paid") {
      const fee = await this.getFeeInfo();
      const onChain = fee && fee.token === this.opts.nativeTokenId ? fee.amount : 0n;
      covered = onChain < maxFeeStroops ? onChain : maxFeeStroops;
    }
    const unpaid = maxFeeStroops - covered;
    const rid = id ?? `s-${this.deps.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const now = this.deps.now();

    if (unpaid > 0n) {
      let ok: boolean;
      try {
        ok = await this.deps.ledger.tryReserve(unpaid, now, this.opts.unpaidBudgetStroops, rid);
      } catch (err) {
        return { ok: false, reason: `could not update the unpaid spend ledger (${errMsg(err)}); failing closed` };
      }
      if (!ok) {
        return {
          ok: false,
          reason:
            `sending would exceed the unpaid budget of ${formatXlm(this.opts.unpaidBudgetStroops)}/hour ` +
            `(tx max fee ${formatXlm(maxFeeStroops)}, unreimbursed ${formatXlm(unpaid)})`,
        };
      }
    }
    if (covered > 0n) {
      let ok = false;
      let failure: unknown = null;
      try {
        ok = await this.deps.paidLedger.tryReserve(covered, now, this.opts.paidFailureBudgetStroops, rid);
      } catch (err) {
        failure = err;
      }
      if (!ok) {
        // All or nothing: undo the unpaid part so a refused send costs nothing.
        if (unpaid > 0n) await this.safeRelease(this.deps.ledger, rid, unpaid, now);
        return {
          ok: false,
          reason: failure
            ? `could not update the paid-exposure ledger (${errMsg(failure)}); failing closed`
            : `sending would exceed the paid-request failure budget of ` +
              `${formatXlm(this.opts.paidFailureBudgetStroops)}/hour (PAID_FAILURE_BUDGET_XLM_PER_HOUR): ` +
              `too many recent paid fulfills failed or are unresolved`,
        };
      }
    }
    if (unpaid > 0n) {
      try {
        this.deps.onUnpaidSpend?.(await this.deps.ledger.spent(now));
      } catch {
        /* metric only */
      }
    }
    return { ok: true, reservation: { id: rid, unpaid, covered } };
  }

  /**
   * Record how a send ended. What was charged decides what is released:
   *
   *   outcome        unpaid part   covered part   why
   *   success        kept          released       escrow reimbursed the covered part
   *   not_included   released      released       never in a ledger: no fee charged
   *   failed         kept          kept           fee charged, nothing reimbursed
   *   unknown        kept          kept           resolved later by resolvePending()
   *
   * Keeping the full max fee for `failed` over-counts (the real fee can be
   * lower). That's deliberate: this is a risk bound, not accounting.
   */
  async settleSend(
    res: SendReservation,
    outcome: SendOutcome,
    tx?: { hash: string; validUntilMs?: number }
  ): Promise<void> {
    const now = this.deps.now();
    if ((outcome === "success" || outcome === "not_included") && res.covered > 0n) {
      await this.safeRelease(this.deps.paidLedger, res.id, res.covered, now);
    }
    if (outcome === "not_included" && res.unpaid > 0n) {
      await this.safeRelease(this.deps.ledger, res.id, res.unpaid, now);
    }
    if (outcome === "unknown" && tx?.hash) {
      this.pending.set(res.id, {
        reservation: res,
        hash: tx.hash,
        validUntilMs: tx.validUntilMs ?? now + UNKNOWN_VALIDITY_FALLBACK_MS,
      });
    }
  }

  /**
   * Settle sends whose outcome was `unknown` (RPC error, confirmation
   * timeout). Called from the periodic reconciliation pass:
   *  - `SUCCESS` → settled as success;
   *  - `FAILED` → settled as failed (kept);
   *  - `NOT_FOUND` after a ledger closed past the tx's `maxTime` → it can
   *    never be included, so settled as not included;
   *  - `NOT_FOUND` before that, or a lookup error → stays pending.
   * In-memory only: after a restart those reservations stay counted until
   * they leave the one-hour window (conservative). Returns the number settled.
   */
  async resolvePending(lookup: (hash: string) => Promise<TxLookup>): Promise<number> {
    let settled = 0;
    for (const [id, p] of [...this.pending]) {
      let r: TxLookup;
      try {
        r = await lookup(p.hash);
      } catch {
        continue;
      }
      let outcome: SendOutcome | null = null;
      if (r.status === "SUCCESS") outcome = "success";
      else if (r.status === "FAILED") outcome = "failed";
      else if (r.latestLedgerCloseTimeMs > p.validUntilMs) outcome = "not_included";
      if (!outcome) continue;
      this.pending.delete(id);
      await this.settleSend(p.reservation, outcome);
      settled++;
    }
    return settled;
  }

  /** Sends awaiting `resolvePending()`. */
  pendingCount(): number {
    return this.pending.size;
  }

  /** A release error must never break the send path; the entry then just expires. */
  private async safeRelease(ledger: SpendLedger, id: string, amount: bigint, now: number): Promise<void> {
    try {
      await ledger.release(id, amount, now);
    } catch {
      /* stays counted until it leaves the window: conservative */
    }
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

