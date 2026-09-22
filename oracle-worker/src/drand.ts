/**
 * drand.ts — Fetch and verify drand beacon rounds from the drand HTTP API
 *
 * Uses the "quicknet" chain (bls-unchained-g1-rfc9380):
 *   - Genesis: 1692803367
 *   - Period:  3 seconds
 *   - Signatures on G1, group key on G2 ("short signatures")
 *   - Unchained: the signed message is the round alone (no prev-sig chaining)
 *
 * The HTTP relay is NOT trusted. Every fetched beacon has its BLS signature
 * verified locally (`verifyDrandBeacon`) before it is handed to proof
 * generation. The contract re-verifies the same signature on-chain, so this
 * local check is not what makes the randomness sound — it exists so that a
 * compromised or buggy relay cannot make the worker spend CPU building a proof
 * and pay to submit a transaction that is certain to be rejected.
 */

import { bls12_381 } from "@noble/curves/bls12-381";
import { sha256 } from "@noble/hashes/sha256";
import {
  DRAND_API_URL,
  DRAND_CHAIN_HASH,
  DRAND_GENESIS_TIME,
  DRAND_PERIOD,
  DRAND_PUBLIC_KEY,
  DRAND_VERIFY_BEACONS,
  DRAND_DST,
} from "./config.js";
import { log, sleep } from "./utils.js";

export interface DrandBeacon {
  round: number;
  randomness: string;   // hex-encoded 32 bytes
  signature: string;    // hex-encoded 48 or 96 bytes (G1 point)
}

/** Thrown when a fetched beacon fails local cryptographic validation. */
export class DrandVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DrandVerificationError";
  }
}

/**
 * Cryptographically verify a drand beacon against the configured group key.
 *
 * quicknet (`bls-unchained-g1-rfc9380`) is an *unchained* scheme: the signed
 * message is only the round number, with no previous-signature chaining, and
 * signatures live on G1 while the group key lives on G2 ("short signatures").
 * The check is therefore:
 *
 *     e(sig, G2_gen) == e(H(sha256(round_be), DRAND_DST), drand_pk)
 *
 * which is exactly what the contract's `verify_drand_signature()` evaluates —
 * including hashing the big-endian round through sha256 first. Matching the
 * contract byte-for-byte is the point: a beacon accepted here is one the chain
 * will also accept, so we never pay for a doomed transaction.
 *
 * `randomness` is additionally checked to be `sha256(signature)`, per drand.
 *
 * @throws DrandVerificationError if the beacon is malformed, has the wrong
 *         round, or carries an invalid signature.
 */
export function verifyDrandBeacon(beacon: DrandBeacon, expectedRound?: number): void {
  if (typeof beacon?.round !== "number" || !Number.isFinite(beacon.round)) {
    throw new DrandVerificationError(`beacon has no valid round: ${JSON.stringify(beacon)}`);
  }
  if (typeof beacon.signature !== "string" || beacon.signature.length === 0) {
    throw new DrandVerificationError(`beacon ${beacon.round} has no signature`);
  }
  if (expectedRound !== undefined && beacon.round !== expectedRound) {
    // A relay answering with a different round would silently bind the proof to
    // the wrong beacon and fail the contract's required-round check.
    throw new DrandVerificationError(
      `beacon round mismatch: requested ${expectedRound}, received ${beacon.round}`
    );
  }

  // message = sha256(round as big-endian u64) — identical to the contract.
  const roundBe = new Uint8Array(8);
  new DataView(roundBe.buffer).setBigUint64(0, BigInt(beacon.round), false);
  const message = sha256(roundBe);

  let valid: boolean;
  try {
    const shortSigs = bls12_381.shortSignatures;
    const hashedMessage = shortSigs.hash(message, DRAND_DST);
    valid = shortSigs.verify(beacon.signature, hashedMessage, DRAND_PUBLIC_KEY);
  } catch (err) {
    // Malformed points (bad hex, not on curve, wrong length) land here.
    throw new DrandVerificationError(
      `beacon ${beacon.round} signature is malformed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (!valid) {
    throw new DrandVerificationError(
      `beacon ${beacon.round} BLS signature is INVALID under the configured drand group key ` +
        `(possible compromised/misconfigured relay)`
    );
  }

  // drand defines randomness = sha256(signature). Advisory only: the contract
  // derives alpha from the signature itself, so a wrong `randomness` field
  // cannot corrupt the proof — but it is a strong signal of a bad relay.
  if (typeof beacon.randomness === "string" && beacon.randomness.length > 0) {
    const sigBytes = hexToBytesStrict(beacon.signature);
    const expected = bytesToHexLower(sha256(sigBytes));
    if (expected !== beacon.randomness.toLowerCase()) {
      log.warn(
        `drand round ${beacon.round}: randomness field != sha256(signature) ` +
          `(ignored — proof binds to the signature, not this field)`
      );
    }
  }
}

function hexToBytesStrict(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHexLower(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const data = (await res.json()) as DrandBeacon;

        // Verify BEFORE returning: an untrusted relay must not be able to make
        // the worker build (and pay to submit) a proof over a forged beacon.
        if (DRAND_VERIFY_BEACONS) {
          verifyDrandBeacon(data, round);
          log.success(
            `Fetched + VERIFIED drand round ${data.round} (sig: ${data.signature.slice(0, 16)}…)`
          );
        } else {
          log.warn(
            `Fetched drand round ${data.round} WITHOUT verification ` +
              `(DRAND_VERIFY_BEACONS=false — not for production)`
          );
        }
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
      // A verification failure is retried (api.drand.sh is load-balanced, so a
      // different node may answer correctly), but it is surfaced loudly and the
      // error TYPE is preserved on exhaustion so callers/alerting can tell a
      // bad relay apart from ordinary network trouble.
      const isVerification = err instanceof DrandVerificationError;

      if (attempt === maxRetries) {
        const detail = err instanceof Error ? err.message : String(err);
        const summary =
          `Failed to fetch drand round ${round} after ${maxRetries + 1} attempts: ${detail}`;
        throw isVerification ? new DrandVerificationError(summary) : new Error(summary);
      }

      const waitMs = Math.min(1000 * 2 ** attempt, 10_000);
      const detail = err instanceof Error ? err.message : String(err);
      if (isVerification) {
        log.error(`drand BEACON VERIFICATION FAILED, retrying in ${waitMs}ms: ${detail}`);
      } else {
        log.warn(`drand fetch error, retrying in ${waitMs}ms: ${detail}`);
      }
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
