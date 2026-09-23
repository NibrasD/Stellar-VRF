/**
 * sendAttempts.ts — hard cap on fulfill() sendTransaction() calls per request.
 *
 * Why: a request can be made to fail AFTER simulation (e.g. a consumer whose
 * `on_vrf()` behaves differently at apply time, or exhausts the host budget,
 * which Soroban cannot isolate). Each such send still costs the oracle a
 * network fee. Without a cap the worker retries up to
 * `withFulfillRetry × submitFulfillment` times per pass, and reconciliation
 * starts a new pass every RECONCILE_INTERVAL_MS, forever — an unbounded fee
 * drain driven by a third party.
 *
 * The cap counts SENDS (not passes), so inner retries, outer retries and
 * reconciliation passes all draw from the same allowance. Once exhausted the
 * request is parked: the worker stops spending on it and the requester can
 * still recover their fee with `timeout_refund()`.
 *
 * Scope: in-memory, per process. A restart or failover grants a fresh
 * allowance, so the worst case is `MAX_SENDS_PER_REQUEST × restarts` — bounded,
 * unlike before. The unpaid-spend budget in feeGuard.ts remains the
 * deployment-wide hard ceiling.
 */

export interface SendAttemptOptions {
  /** Maximum sendTransaction() calls per request id. Must be >= 1. */
  maxSendsPerRequest: number;
  /** Upper bound on tracked ids; oldest entries are evicted first. */
  maxTrackedRequests: number;
}

export function sendAttemptOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): SendAttemptOptions {
  const maxSends = parseInt(env.MAX_SENDS_PER_REQUEST || "6", 10);
  if (!Number.isInteger(maxSends) || maxSends < 1) {
    throw new Error(`MAX_SENDS_PER_REQUEST must be an integer >= 1, got "${env.MAX_SENDS_PER_REQUEST}"`);
  }
  return { maxSendsPerRequest: maxSends, maxTrackedRequests: 10_000 };
}

export class SendAttemptTracker {
  private readonly sends = new Map<string, number>();

  constructor(private readonly opts: SendAttemptOptions) {
    if (!Number.isInteger(opts.maxSendsPerRequest) || opts.maxSendsPerRequest < 1) {
      throw new Error("maxSendsPerRequest must be an integer >= 1");
    }
  }

  get limit(): number {
    return this.opts.maxSendsPerRequest;
  }

  /** Sends already made for this request. */
  count(requestId: bigint): number {
    return this.sends.get(requestId.toString()) ?? 0;
  }

  /** True once the request has used its whole allowance. */
  isExhausted(requestId: bigint): boolean {
    return this.count(requestId) >= this.opts.maxSendsPerRequest;
  }

  /**
   * Reserve one send. Call immediately before sendTransaction(); a reserved
   * slot is consumed whether or not the send later succeeds, because the
   * network fee is charged either way.
   */
  tryReserve(requestId: bigint): { ok: true } | { ok: false; reason: string } {
    const key = requestId.toString();
    const used = this.sends.get(key) ?? 0;
    if (used >= this.opts.maxSendsPerRequest) {
      return {
        ok: false,
        reason:
          `send cap reached for request ${requestId} (${used}/${this.opts.maxSendsPerRequest} ` +
          `sends); parked — requester can timeout_refund()`,
      };
    }
    // Re-insert so Map order reflects recency, then evict the oldest if over bound.
    this.sends.delete(key);
    this.sends.set(key, used + 1);
    while (this.sends.size > this.opts.maxTrackedRequests) {
      const oldest = this.sends.keys().next().value as string;
      this.sends.delete(oldest);
    }
    return { ok: true };
  }

  /**
   * Use up the rest of a request's allowance at once. Called after a
   * deterministic (terminal) failure: retrying cannot succeed, so later
   * reconciliation passes must skip it without spending anything.
   */
  park(requestId: bigint): void {
    const key = requestId.toString();
    this.sends.delete(key);
    this.sends.set(key, this.opts.maxSendsPerRequest);
    while (this.sends.size > this.opts.maxTrackedRequests) {
      const oldest = this.sends.keys().next().value as string;
      this.sends.delete(oldest);
    }
  }

  /** Forget a request (e.g. once it is fulfilled or refunded on-chain). */
  clear(requestId: bigint): void {
    this.sends.delete(requestId.toString());
  }
}
