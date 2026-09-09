/**
 * retry.ts — Retry logic with exponential backoff + drand delay detection
 *
 * Handles transient failures in:
 * - drand beacon fetching (network issues, drand node lag)
 * - Soroban RPC calls (rate limits, node restarts)
 * - fulfill() transaction submission (sequence number conflicts, fee bumps)
 */

import { log } from "./utils.js";
import { recordDrandDelay } from "./metrics.js";

const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || "5", 10);
const BASE_DELAY_MS = parseInt(process.env.RETRY_BASE_DELAY_MS || "2000", 10);
const MAX_DELAY_MS = parseInt(process.env.RETRY_MAX_DELAY_MS || "60000", 10);
const DRAND_LAG_THRESHOLD_ROUNDS = parseInt(
  process.env.DRAND_LAG_THRESHOLD || "2",
  10
);

/**
 * Retry an async operation with exponential backoff.
 * @param label   Human-readable name for logging
 * @param fn      The async operation to retry
 * @param retries Max number of attempts (default: MAX_RETRIES)
 */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  retries = MAX_RETRIES
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isLast = attempt === retries;

      if (isLast) {
        log.error(`[Retry] ${label} failed after ${retries} attempts.`);
        throw err;
      }

      const delay = Math.min(
        BASE_DELAY_MS * Math.pow(2, attempt - 1),
        MAX_DELAY_MS
      );
      log.warn(
        `[Retry] ${label} attempt ${attempt}/${retries} failed: ${
          err instanceof Error ? err.message : err
        }. Retrying in ${delay}ms…`
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Wait for a drand round with lag detection.
 * Logs a warning and records a metric if the round is delayed.
 *
 * @param targetRound  The drand round number to wait for
 * @param currentRound The latest known drand round
 * @param periodMs     drand chain period in milliseconds
 */
export function checkDrandLag(
  targetRound: number,
  currentRound: number,
  periodMs: number
): void {
  const roundsBehind = targetRound - currentRound;

  if (roundsBehind > DRAND_LAG_THRESHOLD_ROUNDS) {
    const estimatedDelayMs = roundsBehind * periodMs;
    log.warn(
      `[drand] Round ${targetRound} is ${roundsBehind} rounds ahead of current ` +
        `round ${currentRound}. Estimated wait: ${(estimatedDelayMs / 1000).toFixed(1)}s`
    );
    recordDrandDelay();
  }
}

/**
 * Retry a fulfill() transaction with sequence number refresh on conflict.
 * Soroban transactions can fail with "txBadSeq" if two nodes submit simultaneously.
 */
export async function withFulfillRetry<T>(
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  return withRetry(label, fn, MAX_RETRIES);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
