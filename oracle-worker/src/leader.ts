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
import { log } from "./utils.js";
import { RedisLease } from "./redisLock.js";

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

const INSTANCE_ID = process.env.INSTANCE_ID || `oracle-${process.pid}`;

let state: LeaderState = "unknown";
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// Distributed backend (only instantiated when REDIS_URL is present).
const useRedis = REDIS_URL.length > 0;
const redisLease: RedisLease | null = useRedis
  ? new RedisLease({ url: REDIS_URL, key: REDIS_LOCK_KEY, instanceId: INSTANCE_ID, ttlMs: LOCK_TTL_MS })
  : null;

/**
 * Backend-agnostic acquire/renew. Returns true if this instance holds
 * leadership afterwards. Redis errors fail closed (returns false → standby),
 * so a Redis outage never causes two leaders.
 */
async function tryAcquire(): Promise<boolean> {
  if (redisLease) {
    try {
      return await redisLease.acquireOrRenew();
    } catch (err) {
      log.error(`[Leader] Redis lease error (failing closed to standby): ${err}`);
      return false;
    }
  }
  return tryAcquireLock();
}

/**
 * Try to acquire the leader lock.
 * Uses atomic file operations to prevent TOCTOU race conditions.
 * Returns true if this instance is now the leader.
 */
function tryAcquireLock(): boolean {
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
    if (fs.existsSync(LOCK_FILE)) {
      const raw = fs.readFileSync(LOCK_FILE, "utf-8");
      const lock: LockFile = JSON.parse(raw);
      if (lock.instanceId === INSTANCE_ID) {
        fs.unlinkSync(LOCK_FILE);
        log.info("[Leader] Lock released.");
      }
    }
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
export function startLeaderElection(
  onBecomeLeader: () => void,
  onLoseLeadership: () => void
): void {
  log.info(
    `[Leader] Starting election. Instance: ${INSTANCE_ID}, backend: ${useRedis ? "redis (multi-server)" : "file (single-server)"}, TTL: ${LOCK_TTL_MS}ms`
  );

  let running = false; // prevent overlapping async ticks

  const runElection = async () => {
    if (running) return;
    running = true;
    try {
      const leader = await tryAcquire();

      if (leader && state !== "leader") {
        state = "leader";
        log.success(`[Leader] ${INSTANCE_ID} is now the LEADER.`);

        // Start heartbeat (renew the lease well before it expires)
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(async () => {
          const stillLeader = await tryAcquire();
          if (!stillLeader) {
            log.warn("[Leader] Lost leadership during heartbeat renewal!");
            state = "standby";
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            heartbeatTimer = null;
            onLoseLeadership();
          }
        }, HEARTBEAT_MS);

        onBecomeLeader();
      } else if (!leader && state !== "standby") {
        state = "standby";
        log.info(`[Leader] ${INSTANCE_ID} is STANDBY. Watching for leader failure.`);
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        onLoseLeadership();
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

export function isLeader(): boolean {
  return state === "leader";
}

export function getLeaderState(): LeaderState {
  return state;
}

export function getInstanceId(): string {
  return INSTANCE_ID;
}
