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
  /**
   * Per-command deadline. Defaults to a third of the TTL (max 5s) so a hung
   * Redis is detected well before the lease could expire underneath us.
   */
  commandTimeoutMs?: number;
}

type RespValue = string | number | null;

/**
 * Minimal RESP client.
 *
 * Two properties matter for leader election and are enforced here:
 *
 *  1. **One command in flight at a time.** RESP replies carry no request ID;
 *     they are matched to commands purely by order. The election loop and the
 *     heartbeat timer both issue commands, so without serialisation two
 *     concurrent `rawCommand()` calls would each attach a `data` listener and
 *     could both consume the same reply — e.g. a heartbeat reading the result
 *     of someone else's `SET NX` and concluding it still holds the lease.
 *
 *  2. **Every command has a deadline.** A command that never gets a reply
 *     would otherwise leave the caller awaiting forever. For the lease that is
 *     the dangerous case: the renewal never completes, so this process keeps
 *     believing it is leader while the key quietly expires in Redis and a
 *     standby takes over. On timeout the socket is destroyed (its reply stream
 *     can no longer be trusted to be in order) and the caller gets an error,
 *     which leader.ts treats as "not leader".
 */
export class RedisClient {
  private sock: net.Socket | tls.TLSSocket | null = null;
  private connecting: Promise<void> | null = null;
  private host: string;
  private port: number;
  private password: string | null;
  private useTls: boolean;
  private timeoutMs: number;
  /** Tail of the command queue; each command chains onto the previous one. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(url: string, timeoutMs = 5000) {
    const u = new URL(url);
    this.host = u.hostname;
    this.port = u.port ? parseInt(u.port, 10) : 6379;
    this.password = u.password ? decodeURIComponent(u.password) : null;
    this.useTls = u.protocol === "rediss:";
    this.timeoutMs = timeoutMs;
  }

  private async connect(): Promise<void> {
    if (this.sock && !this.sock.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const onConnect = async () => {
        try {
          // Safe to call rawCommand directly: connect() only ever runs inside a
          // queued command, so nothing else is using the socket yet.
          if (this.password) await this.rawCommand(["AUTH", this.password]);
          resolve();
        } catch (e) {
          this.destroySocket();
          reject(e as Error);
        } finally {
          this.connecting = null;
        }
      };
      const sock = this.useTls
        ? tls.connect({ host: this.host, port: this.port, servername: this.host }, onConnect)
        : net.connect({ host: this.host, port: this.port }, onConnect);
      this.sock = sock;
      // Persistent handler so a late socket error can never become an
      // unhandled 'error' event (which would crash the process).
      sock.on("error", (err: Error) => {
        if (this.sock === sock) this.connecting = null;
        reject(err);
      });
      sock.once("close", () => {
        if (this.sock === sock) {
          this.sock = null;
          this.connecting = null;
        }
        reject(new Error("Redis connection closed"));
      });
      sock.setKeepAlive(true, 10_000);
    });
    return this.connecting;
  }

  private rawCommand(args: string[]): Promise<RespValue> {
    return new Promise<RespValue>((resolve, reject) => {
      const sock = this.sock;
      if (!sock || sock.destroyed) return reject(new Error("Redis socket not connected"));
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        try {
          const parsed = tryParse(buf);
          if (parsed !== undefined) { cleanup(); resolve(parsed.value); }
        } catch (e) { cleanup(); reject(e as Error); }
      };
      const onErr = (e: Error) => { cleanup(); reject(e); };
      const onClose = () => { cleanup(); reject(new Error("Redis connection closed mid-command")); };
      const cleanup = () => {
        sock.removeListener("data", onData);
        sock.removeListener("error", onErr);
        sock.removeListener("close", onClose);
      };
      sock.on("data", onData);
      sock.once("error", onErr);
      sock.once("close", onClose);
      sock.write(encodeCommand(args));
    });
  }

  /**
   * Run a command. Commands are strictly serialised (see class doc) and each
   * one — including the connect/AUTH it may trigger — must finish within the
   * configured deadline.
   */
  command(args: string[]): Promise<RespValue> {
    const run = () =>
      this.withDeadline(args[0], async () => {
        await this.connect();
        return this.rawCommand(args);
      });
    // Chain regardless of whether the previous command succeeded.
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private withDeadline<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        // The reply for this command may still arrive later. Leaving the socket
        // open would let the NEXT command read it, so the stream is discarded.
        this.destroySocket();
        reject(new Error(`Redis ${label} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      fn().then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
  }

  private destroySocket(): void {
    const sock = this.sock;
    this.sock = null;
    this.connecting = null;
    try { sock?.destroy(); } catch { /* noop */ }
  }

  close(): void {
    this.destroySocket();
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
    const timeout =
      cfg.commandTimeoutMs ?? Math.min(5000, Math.max(250, Math.floor(cfg.ttlMs / 3)));
    this.client = new RedisClient(cfg.url, timeout);
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
