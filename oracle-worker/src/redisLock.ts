/**
 * redisLock.ts — Minimal distributed lease using Redis over a raw TCP RESP
 * client (no external dependency).
 *
 * Enables TRUE multi-server HA: primary and hot-standby run on SEPARATE hosts
 * and coordinate through a shared Redis instance. The file-based lock in
 * leader.ts only works when both instances share a filesystem (single host);
 * this module removes that limitation.
 *
 * Connection string: REDIS_URL, e.g.
 *   redis://:password@my-redis-host:6379
 *   rediss://…  (TLS) is also supported.
 */

import net from "net";
import tls from "tls";
import { URL } from "url";

export interface RedisLockConfig {
  url: string;
  key: string;
  instanceId: string;
  ttlMs: number;
}

type RespValue = string | number | null;

class RedisClient {
  private sock: net.Socket | tls.TLSSocket | null = null;
  private connecting: Promise<void> | null = null;
  private host: string;
  private port: number;
  private password: string | null;
  private useTls: boolean;

  constructor(url: string) {
    const u = new URL(url);
    this.host = u.hostname;
    this.port = u.port ? parseInt(u.port, 10) : 6379;
    this.password = u.password ? decodeURIComponent(u.password) : null;
    this.useTls = u.protocol === "rediss:";
  }

  private async connect(): Promise<void> {
    if (this.sock && !this.sock.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const onConnect = async () => {
        try {
          if (this.password) await this.rawCommand(["AUTH", this.password]);
          resolve();
        } catch (e) {
          reject(e as Error);
        } finally {
          this.connecting = null;
        }
      };
      this.sock = this.useTls
        ? tls.connect({ host: this.host, port: this.port, servername: this.host }, onConnect)
        : net.connect({ host: this.host, port: this.port }, onConnect);
      this.sock.once("error", (err: Error) => { this.connecting = null; reject(err); });
      this.sock.setKeepAlive(true, 10_000);
    });
    return this.connecting;
  }

  private rawCommand(args: string[]): Promise<RespValue> {
    return new Promise<RespValue>((resolve, reject) => {
      const sock = this.sock;
      if (!sock) return reject(new Error("Redis socket not connected"));
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        try {
          const parsed = tryParse(buf);
          if (parsed !== undefined) { cleanup(); resolve(parsed.value); }
        } catch (e) { cleanup(); reject(e as Error); }
      };
      const onErr = (e: Error) => { cleanup(); reject(e); };
      const cleanup = () => {
        sock.removeListener("data", onData);
        sock.removeListener("error", onErr);
      };
      sock.on("data", onData);
      sock.once("error", onErr);
      sock.write(encodeCommand(args));
    });
  }

  async command(args: string[]): Promise<RespValue> {
    await this.connect();
    return this.rawCommand(args);
  }

  close(): void {
    try { this.sock?.destroy(); } catch { /* noop */ }
    this.sock = null;
  }
}

function encodeCommand(args: string[]): string {
  let out = `*${args.length}\r\n`;
  for (const a of args) {
    const s = String(a);
    out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
  }
  return out;
}

/** Returns { value } if a full reply is present, else undefined. */
function tryParse(buf: Buffer): { value: RespValue } | undefined {
  const nl = buf.indexOf("\r\n");
  if (nl < 0) return undefined;
  const type = String.fromCharCode(buf[0]);
  const line = buf.slice(1, nl).toString("utf-8");
  switch (type) {
    case "+": return { value: line };
    case "-": throw new Error("Redis error: " + line);
    case ":": return { value: parseInt(line, 10) };
    case "$": {
      const len = parseInt(line, 10);
      if (len === -1) return { value: null };
      const start = nl + 2;
      if (buf.length < start + len + 2) return undefined;
      return { value: buf.slice(start, start + len).toString("utf-8") };
    }
    default: return { value: line };
  }
}


// ── Distributed lease ────────────────────────────────────────────────────────

const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const RENEW_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

export class RedisLease {
  private client: RedisClient;
  private cfg: RedisLockConfig;

  constructor(cfg: RedisLockConfig) {
    this.cfg = cfg;
    this.client = new RedisClient(cfg.url);
  }

  /**
   * Acquire the lease if free, or renew it if we already hold it.
   * Returns true if we hold the lease afterwards.
   */
  async acquireOrRenew(): Promise<boolean> {
    const { key, instanceId, ttlMs } = this.cfg;
    // Fast path: renew if we already own it (fencing check via Lua).
    const renewed = await this.client.command([
      "EVAL", RENEW_LUA, "1", key, instanceId, String(ttlMs),
    ]);
    if (renewed === 1) return true;
    // Otherwise acquire atomically only if the key is free.
    const acquired = await this.client.command([
      "SET", key, instanceId, "PX", String(ttlMs), "NX",
    ]);
    return acquired === "OK";
  }

  /** Release the lease only if we still own it (atomic compare-and-delete). */
  async release(): Promise<void> {
    try {
      await this.client.command([
        "EVAL", RELEASE_LUA, "1", this.cfg.key, this.cfg.instanceId,
      ]);
    } catch { /* best-effort */ }
  }

  close(): void {
    this.client.close();
  }
}
