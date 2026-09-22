/**
 * spendLedger.ts — rolling one-hour record of what the oracle has committed to
 * spend on requests that don't pay for themselves.
 *
 * Why a separate ledger
 * ─────────────────────
 * The fee guard's budget must hold for the *deployment*, not for one process:
 *
 *   - In HA, primary and standby are separate processes. An in-memory counter
 *     gives each its own budget, and failover hands the new leader a fresh one.
 *   - A restart (crash, deploy, PM2 reload) would otherwise reset the budget.
 *
 * So the ledger lives where the leader lease lives:
 *
 *   - `REDIS_URL` set  → Redis sorted set, updated by one atomic Lua script
 *     that uses Redis' own clock. Shared by all instances, survives restarts.
 *   - otherwise        → a JSON file (same single-host scope as the file lock).
 *
 * Amounts recorded are the **maximum fee** of each transaction actually sent
 * (the envelope `fee` after simulation/assembly). Stellar can never charge
 * more than that, so the sum is a hard upper bound on real spend, including
 * retries and ambiguous timeouts that are later resubmitted.
 */

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { RedisClient } from "./redisLock.js";

export const HOUR_MS = 3_600_000;

export interface SpendLedger {
  /** Total reserved in the rolling window ending now. */
  spent(nowMs: number): Promise<bigint>;
  /**
   * Atomically record `amount` if `spent + amount <= limit`.
   * Returns false (and records nothing) otherwise.
   */
  tryReserve(amount: bigint, nowMs: number, limit: bigint): Promise<boolean>;
  /** Human-readable scope, for the startup log. */
  describe(): string;
}

interface Entry {
  t: number;
  amount: string; // bigint as a decimal string (JSON-safe)
}

function prune(entries: Entry[], nowMs: number, windowMs: number): Entry[] {
  return entries.filter((e) => nowMs - e.t < windowMs);
}

function sum(entries: Entry[]): bigint {
  return entries.reduce((acc, e) => acc + BigInt(e.amount), 0n);
}

/** Process-local ledger. For tests only: it has exactly the scope problem above. */
export class MemorySpendLedger implements SpendLedger {
  private entries: Entry[] = [];
  constructor(private windowMs = HOUR_MS) {}

  async spent(nowMs: number): Promise<bigint> {
    this.entries = prune(this.entries, nowMs, this.windowMs);
    return sum(this.entries);
  }

  async tryReserve(amount: bigint, nowMs: number, limit: bigint): Promise<boolean> {
    if ((await this.spent(nowMs)) + amount > limit) return false;
    this.entries.push({ t: nowMs, amount: amount.toString() });
    return true;
  }

  describe(): string {
    return "in-memory (this process only)";
  }
}

/**
 * File-backed ledger: survives restarts on one host. Writes are atomic
 * (temp file + rename). Like the file-based leader lock, it is only correct
 * when every instance shares this filesystem.
 */
export class FileSpendLedger implements SpendLedger {
  constructor(private file: string, private windowMs = HOUR_MS) {}

  private load(nowMs: number): Entry[] {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      // A corrupt ledger must not silently turn into an empty (= full) budget.
      throw new Error(`unreadable spend ledger ${this.file}: ${(err as Error).message}`);
    }
    if (!Array.isArray(raw)) throw new Error(`malformed spend ledger ${this.file}`);
    return prune(raw as Entry[], nowMs, this.windowMs);
  }

  private save(entries: Entry[]): void {
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries));
    fs.renameSync(tmp, this.file);
  }

  async spent(nowMs: number): Promise<bigint> {
    return sum(this.load(nowMs));
  }

  async tryReserve(amount: bigint, nowMs: number, limit: bigint): Promise<boolean> {
    const entries = this.load(nowMs);
    if (sum(entries) + amount > limit) return false;
    entries.push({ t: nowMs, amount: amount.toString() });
    this.save(entries);
    return true;
  }

  describe(): string {
    return `file ${this.file} (single host only; survives restarts)`;
  }
}

/**
 * KEYS[1] = ledger key
 * ARGV[1] = window ms, ARGV[2] = amount (-1 = read only), ARGV[3] = limit,
 * ARGV[4] = unique member suffix
 * Returns the window total (read), the new total (reserved), or -1 (refused).
 * Uses Redis' clock, so hosts with skewed clocks still share one window.
 * Totals are stroops; Lua numbers are doubles, exact up to 2^53 stroops
 * (~900M XLM), far above any hourly budget.
 */
const RESERVE_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local total = 0
for _, m in ipairs(redis.call('ZRANGE', KEYS[1], 0, -1)) do
  total = total + tonumber(string.match(m, '^(%d+):'))
end
local amount = tonumber(ARGV[2])
if amount < 0 then return total end
if total + amount > tonumber(ARGV[3]) then return -1 end
redis.call('ZADD', KEYS[1], now, ARGV[2] .. ':' .. ARGV[4])
redis.call('PEXPIRE', KEYS[1], window)
return total + amount
`;

/** Shared ledger for multi-host HA (same Redis as the leader lease). */
export class RedisSpendLedger implements SpendLedger {
  private client: RedisClient;

  constructor(url: string, private key: string, private windowMs = HOUR_MS, timeoutMs = 5000) {
    this.client = new RedisClient(url, timeoutMs);
  }

  private async run(amount: bigint, limit: bigint): Promise<number> {
    const reply = await this.client.command([
      "EVAL",
      RESERVE_LUA,
      "1",
      this.key,
      String(this.windowMs),
      amount.toString(),
      limit.toString(),
      `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`,
    ]);
    if (typeof reply !== "number") throw new Error(`unexpected Redis reply: ${String(reply)}`);
    return reply;
  }

  async spent(): Promise<bigint> {
    return BigInt(await this.run(-1n, 0n));
  }

  async tryReserve(amount: bigint, _nowMs: number, limit: bigint): Promise<boolean> {
    if (amount < 0n) throw new Error("amount must be >= 0");
    return (await this.run(amount, limit)) >= 0;
  }

  describe(): string {
    return `redis key "${this.key}" (shared by all instances; survives restarts)`;
  }

  close(): void {
    this.client.close();
  }
}

/** Pick the ledger that matches the leader-election backend (see leader.ts). */
export function createSpendLedger(env: NodeJS.ProcessEnv = process.env): SpendLedger {
  if (env.REDIS_URL) {
    return new RedisSpendLedger(env.REDIS_URL, env.FEE_GUARD_REDIS_KEY || "vrf-oracle:unpaid-spend");
  }
  return new FileSpendLedger(
    env.FEE_GUARD_STATE_FILE || path.join(os.tmpdir(), "vrf-oracle-unpaid-spend.json")
  );
}

