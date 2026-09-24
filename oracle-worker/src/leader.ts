/**
 * leader.ts — Leader election for HA oracle deployment.
 *
 * Two backends, selected automatically:
 *
 *   1. DISTRIBUTED (multi-server) — used when REDIS_URL is set.
 *      Primary and hot-standby run on SEPARATE hosts and coordinate through a
 *      shared Redis lease (SET NX PX + fenced renew/release via Lua). This is
 *      the production topology required for Mainnet HA.
 *
 *   2. FILE-BASED (single-server) — fallback when REDIS_URL is absent.
 *      Uses an atomic lock file; only valid when both instances share a
 *      filesystem (e.g. one host, or a shared volume). Fine for local dev.
 *
 * In both modes only the current leader submits fulfill() transactions, which
 * — together with the contract's on-chain idempotency guard — prevents
 * double-submission from redundant nodes.
 */

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { performance } from "perf_hooks";
import { log } from "./utils.js";
import { RedisLease } from "./redisLock.js";
import { withFileMutex } from "./fileMutex.js";

const LOCK_FILE = process.env.LEADER_LOCK_FILE || path.join(os.tmpdir(), "vrf-oracle.lock");
const LOCK_TTL_MS = parseInt(process.env.LEADER_LOCK_TTL_MS || "30000", 10);    // 30s
const HEARTBEAT_MS = parseInt(process.env.LEADER_HEARTBEAT_MS || "10000", 10); // 10s
const POLL_MS = parseInt(process.env.LEADER_POLL_MS || "5000", 10);            // 5s

const REDIS_URL = process.env.REDIS_URL || "";
const REDIS_LOCK_KEY = process.env.LEADER_REDIS_KEY || "vrf-oracle:leader";

export type LeaderState = "leader" | "standby" | "unknown";

interface LockFile {
  pid: number;
  instanceId: string;
  timestamp: number;
}

/**
 * Human-readable identifier for this instance (for logging and the file lock).
 * Can be customised via INSTANCE_ID env var.
 */
const INSTANCE_ID = process.env.INSTANCE_ID || `oracle-${process.pid}`;

/**
 * Per-boot cryptographically random token used as the Redis lock *value* (fencing token).
 *
 * This is separate from INSTANCE_ID (used for human-readable logging):
 * - INSTANCE_ID is stable across restarts (e.g. "oracle-primary").
 * - INSTANCE_TOKEN is unique per process lifetime.  A zombie process that
 *   still holds a Redis key after restart can't masquerade as the new leader,
 *   because the new process generates a fresh token that doesn't match the
 *   value stored in Redis from the old boot.
 */
const INSTANCE_TOKEN = crypto.randomBytes(16).toString("hex");

/**
 * Safety margin subtracted from the TTL when computing how long we may keep
 * acting as leader after the last *confirmed* renewal. Covers clock-rate drift
 * between this host and Redis plus event-loop scheduling delay.
 */
const LEASE_SAFETY_MS = parseInt(
  process.env.LEADER_LEASE_SAFETY_MS || String(Math.floor(LOCK_TTL_MS / 5)),
  10
);

/**
 * After voluntarily giving up leadership (e.g. the listener is broken), wait
 * this long before competing again so a healthy standby gets the lease.
 */
const RELINQUISH_COOLDOWN_MS = parseInt(
  process.env.LEADER_RELINQUISH_COOLDOWN_MS || String(LOCK_TTL_MS * 2),
  10
);

let state: LeaderState = "unknown";
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Local deadline for our lease, measured in `performance.now()` milliseconds
 * (monotonic — unaffected by NTP or wall-clock adjustments).
 *
 * Set to `sentAt + TTL − safety` after each successful acquire/renew.
 * `isLeader()` returns false once this passes, even if Redis never answers.
 * Using a monotonic clock prevents a forward NTP jump from silently extending
 * the lease, and a backward jump from prematurely expiring it.
 */
let leaseValidUntil = 0; // performance.now() value
let cooldownUntil = 0;   // performance.now() value
let loseLeadershipCb: (() => void) | null = null;

// Distributed backend (only instantiated when REDIS_URL is present).
const useRedis = REDIS_URL.length > 0;
const redisLease: RedisLease | null = useRedis
  ? new RedisLease({ url: REDIS_URL, key: REDIS_LOCK_KEY, instanceId: INSTANCE_TOKEN, ttlMs: LOCK_TTL_MS })
  : null;

/**
 * Backend-agnostic acquire/renew. Returns true if this instance holds
 * leadership afterwards. Redis errors fail closed (returns false → standby),
 * so a Redis outage never causes two leaders.
 */
async function tryAcquire(): Promise<boolean> {
  const sentAt = performance.now(); // monotonic — unaffected by NTP adjustments
  let ok: boolean;
  if (redisLease) {
    try {
      ok = await redisLease.acquireOrRenew();
    } catch (err) {
      log.error(`[Leader] Redis lease error (failing closed to standby): ${err}`);
      ok = false;
    }
  } else {
    ok = tryAcquireLock();
  }
  leaseValidUntil = ok ? sentAt + LOCK_TTL_MS - LEASE_SAFETY_MS : 0;
  return ok;
}

/**
 * Try to acquire the leader lock.
 * Uses atomic file operations to prevent TOCTOU race conditions.
 * Returns true if this instance is now the leader.
 */
function tryAcquireLock(): boolean {
  // The whole read → decide → write runs under a cross-process mutex. Before,
  // two standbys that both saw a stale lock could both call writeLock() and
  // both believe they were leader.
  try {
    return withFileMutex(LOCK_FILE, tryAcquireLockUnlocked);
  } catch (err) {
    log.error(`[Leader] Could not take the lock mutex (failing closed): ${err}`);
    return false;
  }
}

function tryAcquireLockUnlocked(): boolean {
  try {
    // If lock file exists, check if it's ours or stale
    let raw: string;
    try {
      raw = fs.readFileSync(LOCK_FILE, "utf-8");
    } catch {
      // Lock file doesn't exist — try to create it atomically
      return tryCreateLockAtomically();
    }

    let lock: LockFile;
    try {
      lock = JSON.parse(raw);
    } catch {
      // Corrupted lock — try to take over
      log.warn("[Leader] Corrupted lock file. Attempting takeover.");
      return tryCreateLockAtomically();
    }

    const age = Date.now() - lock.timestamp;

    // Lock is fresh and held by another instance
    if (age < LOCK_TTL_MS && lock.instanceId !== INSTANCE_ID) {
      return false;
    }

    // Lock is held by us — renew it
    if (lock.instanceId === INSTANCE_ID) {
      writeLock();
      return true;
    }

    // Lock is stale — take over atomically
    log.warn(
      `[Leader] Lock stale (age=${age}ms, held by ${lock.instanceId}). Taking over.`
    );
    writeLock();
    return true;
  } catch (err) {
    log.error(`[Leader] Error in tryAcquireLock: ${err}`);
    return false;
  }
}

/**
 * Atomically try to create the lock file using exclusive flag 'wx'.
 * Only one process can succeed — the OS guarantees exclusivity.
 */
function tryCreateLockAtomically(): boolean {
  try {
    const lock: LockFile = {
      pid: process.pid,
      instanceId: INSTANCE_ID,
      timestamp: Date.now(),
    };
    // 'wx' flag: create exclusively — fails if file already exists
    fs.writeFileSync(LOCK_FILE, JSON.stringify(lock), { encoding: "utf-8", flag: "wx" });
    return true;
  } catch (err: any) {
    if (err.code === "EEXIST") {
      // Another process created the lock between our read attempt and this write
      return false;
    }
    log.error(`[Leader] Failed to create lock atomically: ${err}`);
    return false;
  }
}

function writeLock(): void {
  const lock: LockFile = {
    pid: process.pid,
    instanceId: INSTANCE_ID,
    timestamp: Date.now(),
  };
  // Atomic write: write to temp file, then rename
  const tmp = LOCK_FILE + ".tmp." + INSTANCE_ID;
  fs.writeFileSync(tmp, JSON.stringify(lock), "utf-8");
  fs.renameSync(tmp, LOCK_FILE);
}

function releaseFileLock(): void {
  try {
    withFileMutex(LOCK_FILE, () => {
      if (fs.existsSync(LOCK_FILE)) {
        const raw = fs.readFileSync(LOCK_FILE, "utf-8");
        const lock: LockFile = JSON.parse(raw);
        if (lock.instanceId === INSTANCE_ID) {
          fs.unlinkSync(LOCK_FILE);
          log.info("[Leader] Lock released.");
        }
      }
    });
  } catch {
    // Best-effort
  }
}

/** Backend-agnostic release: give up leadership so a standby can take over fast. */
async function release(): Promise<void> {
  if (redisLease) {
    await redisLease.release();
    redisLease.close();
    return;
  }
  releaseFileLock();
}

/**
 * Start the leader election loop.
 * Calls onBecomeLeader / onLoseLeadership when state changes.
 */
function demote(reason: string): void {
  const wasLeader = state === "leader";
  state = "standby";
  leaseValidUntil = 0;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (wasLeader) log.warn(`[Leader] ${INSTANCE_ID} stepping down: ${reason}`);
  loseLeadershipCb?.();
}

/**
 * Voluntarily give up leadership, release the lease so a standby can take over
 * immediately, and stay out of the election for RELINQUISH_COOLDOWN_MS.
 *
 * Used when this node holds the lease but cannot do the leader's job (e.g. its
 * event listener keeps crashing). Keeping the lease in that state would block
 * a healthy standby forever, because the lease heartbeat is independent of the
 * listener and would keep renewing.
 */
export async function relinquishLeadership(reason: string): Promise<void> {
  if (state !== "leader") return;
  cooldownUntil = performance.now() + RELINQUISH_COOLDOWN_MS;
  demote(`relinquished — ${reason}`);
  try {
    await release();
  } catch (err) {
    // Lease will simply expire after TTL instead.
    log.error(`[Leader] Failed to release lease: ${err}`);
  }
  log.warn(
    `[Leader] Not competing for leadership for ${RELINQUISH_COOLDOWN_MS}ms so a standby can take over.`
  );
}

export function startLeaderElection(
  onBecomeLeader: () => void,
  onLoseLeadership: () => void
): void {
  log.info(
    `[Leader] Starting election. Instance: ${INSTANCE_ID}, backend: ${useRedis ? "redis (multi-server)" : "file (single-server)"}, TTL: ${LOCK_TTL_MS}ms`
  );
  loseLeadershipCb = onLoseLeadership;

  // One guard shared by the election tick AND the heartbeat. Previously the
  // heartbeat was an unguarded async setInterval, so a slow Redis round-trip
  // let renewals pile up on top of each other and of the election tick.
  let running = false;

  const runElection = async () => {
    if (running) return;
    running = true;
    try {
      if (performance.now() < cooldownUntil) {
        if (state !== "standby") demote("in post-relinquish cooldown");
        return;
      }

      const leader = await tryAcquire();

      if (leader && state !== "leader") {
        state = "leader";
        log.success(`[Leader] ${INSTANCE_ID} is now the LEADER.`);

        // Renew the lease well before it expires.
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => { void runElection(); }, HEARTBEAT_MS);

        onBecomeLeader();
      } else if (!leader && state !== "standby") {
        if (state === "leader") {
          demote("lease renewal failed");
        } else {
          state = "standby";
          log.info(`[Leader] ${INSTANCE_ID} is STANDBY. Watching for leader failure.`);
          onLoseLeadership();
        }
      }
    } finally {
      running = false;
    }
  };

  // Run immediately, then poll
  void runElection();
  setInterval(() => { void runElection(); }, POLL_MS);

  // Cleanup on exit (release leadership so failover is immediate)
  process.on("exit", () => { void release(); });
  process.on("SIGINT", async () => { await release(); process.exit(0); });
  process.on("SIGTERM", async () => { await release(); process.exit(0); });
}

/**
 * True only while we hold the lease AND its local deadline has not passed.
 *
 * The deadline check uses the monotonic clock (`performance.now()`) so it is
 * unaffected by wall-clock adjustments. It does not depend on the last renewal
 * having *returned*, so it fires promptly on Redis/network stalls.
 */
export function isLeader(): boolean {
  if (state !== "leader") return false;
  if (performance.now() >= leaseValidUntil) {
    // Lease may already be gone in Redis. Demote now rather than waiting for
    // the next tick, so callbacks fire and the listener stops.
    demote("lease deadline passed without a confirmed renewal");
    return false;
  }
  return true;
}

export function getLeaderState(): LeaderState {
  // Report the effective state, so /health never claims "leader" on a lease
  // that has locally expired.
  if (state === "leader" && !isLeader()) return "standby";
  return state;
}

export function getInstanceId(): string {
  return INSTANCE_ID;
}

/** The per-boot fencing token stored in Redis as the lock value. */
export function getInstanceToken(): string {
  return INSTANCE_TOKEN;
}
