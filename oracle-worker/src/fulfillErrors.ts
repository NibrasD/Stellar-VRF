/**
 * fulfillErrors.ts — decide whether a failed fulfill() is worth retrying.
 *
 * Before this, every failure was retried (inner retries × outer retries ×
 * reconciliation passes). That is right for transient problems (a stale
 * sequence number, an RPC timeout), but wrong for deterministic ones: a
 * request that was already fulfilled or refunded, a proof the contract
 * rejects, or a consumer callback that traps or exceeds resource limits
 * fails the same way every time. Retrying those only burns simulation
 * calls and, after simulation passes but apply fails, network fees.
 *
 * `terminal`  → stop now; the request is parked (or simply done).
 * `retryable` → transient; normal backoff applies.
 *
 * Anything unrecognised is retryable. The per-request send cap
 * (sendAttempts.ts) still bounds the cost of those.
 */

export type FulfillErrorKind = "terminal" | "retryable";

export interface FulfillErrorClass {
  kind: FulfillErrorKind;
  /** Short machine-friendly reason, e.g. `already_fulfilled`. */
  reason: string;
  /** True when the terminal state means the request needs no more work. */
  settled: boolean;
}

/**
 * Thrown for deterministic failures. Like FulfillAbortedError it must never be
 * retried; unlike it, it says the request itself cannot be served as-is.
 */
export class FulfillTerminalError extends Error {
  constructor(
    message: string,
    readonly reason: string,
    readonly settled: boolean
  ) {
    super(message);
    this.name = "FulfillTerminalError";
  }
}

/** Contract panic messages that no retry can change (see soroban-contract/src/lib.rs). */
const TERMINAL_PANICS: ReadonlyArray<[RegExp, string, boolean]> = [
  [/already fulfilled/, "already_fulfilled", true],
  [/request refunded|already refunded/, "request_refunded", true],
  [/request not found/, "request_not_found", false],
  [/oracle key mismatch/, "oracle_key_mismatch", false],
  [/drand round mismatch/, "drand_round_mismatch", false],
  [/drand signature verification failed/, "drand_signature_invalid", false],
  [/alpha seed mismatch/, "alpha_seed_mismatch", false],
  [/bls vrf verification failed/, "vrf_proof_invalid", false],
  [/beta output mismatch/, "beta_mismatch", false],
  [/callback contract missing|callback fn missing/, "callback_state_missing", false],
];

/** Transaction/operation result codes, as they appear in the XDR JSON form. */
const TERMINAL_RESULT_CODES: ReadonlyArray<[RegExp, string]> = [
  [/\btrapped\b|invokeHostFunctionTrapped/, "host_function_trapped"],
  [/resource_limit_exceeded|invokeHostFunctionResourceLimitExceeded/, "resource_limit_exceeded"],
  [/entry_archived|invokeHostFunctionEntryArchived/, "entry_archived"],
  [/tx_insufficient_balance|txInsufficientBalance/, "oracle_insufficient_balance"],
  [/tx_bad_auth|txBadAuth/, "bad_auth"],
];

const RETRYABLE_RESULT_CODES: ReadonlyArray<[RegExp, string]> = [
  [/tx_bad_seq|txBadSeq/, "bad_sequence"],
  [/tx_insufficient_fee|txInsufficientFee/, "insufficient_fee"],
  [/insufficient_refundable_fee|InsufficientRefundableFee/, "insufficient_refundable_fee"],
  [/tx_too_late|txTooLate|tx_too_early|txTooEarly/, "time_bounds"],
];

/** Stable string form of an XDR result object (or anything else). */
export function describeResult(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return String(value);
  }
}

/** Classify a free-form failure description (message, simulation error, result JSON). */
export function classifyFulfillFailure(text: string): FulfillErrorClass {
  for (const [re, reason, settled] of TERMINAL_PANICS) {
    if (re.test(text)) return { kind: "terminal", reason, settled };
  }
  for (const [re, reason] of RETRYABLE_RESULT_CODES) {
    if (re.test(text)) return { kind: "retryable", reason, settled: false };
  }
  for (const [re, reason] of TERMINAL_RESULT_CODES) {
    if (re.test(text)) return { kind: "terminal", reason, settled: false };
  }
  return { kind: "retryable", reason: "unclassified", settled: false };
}

/** Classify a thrown error. FulfillTerminalError keeps its own classification. */
export function classifyFulfillError(err: unknown): FulfillErrorClass {
  if (err instanceof FulfillTerminalError) {
    return { kind: "terminal", reason: err.reason, settled: err.settled };
  }
  const msg = err instanceof Error ? err.message : describeResult(err);
  return classifyFulfillFailure(msg);
}

/**
 * Throw a FulfillTerminalError when `detail` describes a deterministic failure,
 * otherwise a plain Error (which the retry loops treat as transient).
 */
export function failureError(prefix: string, detail: unknown): Error {
  const text = describeResult(detail);
  const cls = classifyFulfillFailure(text);
  const message = `${prefix}: ${text}`;
  return cls.kind === "terminal"
    ? new FulfillTerminalError(message, cls.reason, cls.settled)
    : new Error(message);
}

/** True for errors the retry loops must rethrow immediately. */
export function isNonRetryable(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "FulfillAbortedError" || err.name === "FulfillTerminalError")
  );
}
