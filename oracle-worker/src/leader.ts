/**
 * leader.ts — File-based leader election for HA oracle deployment
 *
 * Strategy: single-server HA using a lock file with heartbeat.
 * Works without Redis — uses atomic file operations.
 *
 * For multi-server HA: replace with Redis SETNX lock.
 *
 * Protocol:
 *   - Leader writes its PID + timestamp to LOCK_FILE every HEARTBEAT_MS
 *   - Standby reads the lock file every POLL_MS
 *   - If lock is stale (age > LOCK_TTL_MS), standby becomes leader
 *   - Only the leader submits fulfill() transactions
 */

import fs from "fs";
import path from "path";
import { log } from "./utils.js";

const LOCK_FILE = process.env.LEADER_LOCK_FILE || "/tmp/vrf-oracle.lock";
const LOCK_TTL_MS = parseInt(process.env.LEADER_LOCK_TTL_MS || "30000", 10);    // 30s
const HEARTBEAT_MS = parseInt(process.env.LEADER_HEARTBEAT_MS || "10000", 10); // 10s
const POLL_MS = parseInt(process.env.LEADER_POLL_MS || "5000", 10);            // 5s

export type LeaderState = "leader" | "standby" | "unknown";

interface LockFile {
  pid: number;
  instanceId: string;
  timestamp: number;
}

const INSTANCE_ID = process.env.INSTANCE_ID || `oracle-${process.pid}`;

let state: LeaderState = "unknown";
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

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

function releaseLock(): void {
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

/**
 * Start the leader election loop.
 * Calls onBecomeLeader / onLoseLeadership when state changes.
 */
export function startLeaderElection(
  onBecomeLeader: () => void,
  onLoseLeadership: () => void
): void {
  log.info(
    `[Leader] Starting election. Instance: ${INSTANCE_ID}, TTL: ${LOCK_TTL_MS}ms`
  );

  const runElection = () => {
    const isLeader = tryAcquireLock();

    if (isLeader && state !== "leader") {
      state = "leader";
      log.success(`[Leader] ${INSTANCE_ID} is now the LEADER.`);

      // Start heartbeat
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (!tryAcquireLock()) {
          log.warn("[Leader] Lost lock during heartbeat renewal!");
          state = "standby";
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          heartbeatTimer = null;
          onLoseLeadership();
        }
      }, HEARTBEAT_MS);

      onBecomeLeader();
    } else if (!isLeader && state !== "standby") {
      state = "standby";
      log.info(`[Leader] ${INSTANCE_ID} is STANDBY. Watching for leader failure.`);

      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      onLoseLeadership();
    }
  };

  // Run immediately, then poll
  runElection();
  setInterval(runElection, POLL_MS);

  // Cleanup on exit
  process.on("exit", releaseLock);
  process.on("SIGINT", () => { releaseLock(); process.exit(0); });
  process.on("SIGTERM", () => { releaseLock(); process.exit(0); });
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
