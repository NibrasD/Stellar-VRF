/**
 * drand.ts — Fetch drand beacon rounds from the drand HTTP API
 *
 * Uses the "quicknet" chain (bls-unchained-g1-rfc9380):
 *   - Genesis: 1692803367
 *   - Period:  3 seconds
 *   - Signatures on G1
 */

import { DRAND_API_URL, DRAND_CHAIN_HASH, DRAND_GENESIS_TIME, DRAND_PERIOD } from "./config.js";
import { log, sleep } from "./utils.js";

export interface DrandBeacon {
  round: number;
  randomness: string;   // hex-encoded 32 bytes
  signature: string;    // hex-encoded 48 or 96 bytes (G1 point)
}

/**
 * Compute the current drand round number from a timestamp.
 */
export function computeCurrentRound(timestampSec: number): number {
  if (timestampSec <= DRAND_GENESIS_TIME) return 0;
  return Math.floor((timestampSec - DRAND_GENESIS_TIME) / DRAND_PERIOD);
}

/**
 * Compute the estimated timestamp when a drand round will be published.
 */
export function roundTimestamp(round: number): number {
  return DRAND_GENESIS_TIME + round * DRAND_PERIOD;
}

/**
 * Fetch a specific drand round from the API.
 * Retries up to `maxRetries` times with exponential backoff.
 */
export async function fetchDrandBeacon(
  round: number,
  maxRetries = 5
): Promise<DrandBeacon> {
  const url = `${DRAND_API_URL}/${DRAND_CHAIN_HASH}/public/${round}`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as DrandBeacon;
        log.success(`Fetched drand round ${data.round} (sig: ${data.signature.slice(0, 16)}…)`);
        return data;
      }

      // Round not yet available — wait and retry
      if (res.status === 404 || res.status === 503) {
        if (attempt < maxRetries) {
          const waitMs = Math.min(1000 * 2 ** attempt, 10_000);
          log.info(`drand round ${round} not yet available, retrying in ${waitMs}ms…`);
          await sleep(waitMs);
          continue;
        }
      }

      throw new Error(`drand API error ${res.status}: ${await res.text()}`);
    } catch (err: unknown) {
      if (attempt === maxRetries) {
        throw new Error(
          `Failed to fetch drand round ${round} after ${maxRetries + 1} attempts: ${
            err instanceof Error ? err.message : err
          }`
        );
      }
      const waitMs = Math.min(1000 * 2 ** attempt, 10_000);
      log.warn(`drand fetch error, retrying in ${waitMs}ms: ${err instanceof Error ? err.message : err}`);
      await sleep(waitMs);
    }
  }

  throw new Error(`Unreachable: failed to fetch drand round ${round}`);
}

/**
 * Wait until a specific drand round is expected to be available,
 * then fetch it. Adds a small buffer to account for propagation delay.
 */
export async function waitAndFetchBeacon(round: number): Promise<DrandBeacon> {
  const expectedTime = roundTimestamp(round);
  const now = Math.floor(Date.now() / 1000);

  if (now < expectedTime) {
    const waitSec = expectedTime - now + 2; // 2s propagation buffer
    log.info(`Waiting ${waitSec}s for drand round ${round} (expected at ${new Date(expectedTime * 1000).toISOString()})…`);
    await sleep(waitSec * 1000);
  }

  return fetchDrandBeacon(round);
}
