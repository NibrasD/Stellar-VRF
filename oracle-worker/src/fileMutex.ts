/**
 * fileMutex.ts — short-lived cross-process mutex on a local filesystem.
 *
 * Used by the single-host fallbacks (file leader lock, file spend ledger) to
 * make their read → modify → write steps atomic between processes. The mutex
 * is an exclusively-created (`wx`) file; `wx` is atomic on local filesystems,
 * so only one process holds it at a time.
 *
 * A holder that crashes leaves the file behind. It is broken after
 * `staleMs` (default 10s); critical sections here take milliseconds, so a
 * live holder never gets anywhere near that. Breaking uses rename-then-check,
 * so two processes breaking the same stale file can't both win.
 *
 * Scope: one host, or a shared volume with atomic `O_EXCL` + rename (not all
 * network filesystems give that). Production must use Redis (policy.ts).
 */

import fs from "fs";

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

export interface FileMutexOptions {
  /** Give up (throw) after waiting this long. */
  timeoutMs?: number;
  /** Treat a mutex file older than this as abandoned. */
  staleMs?: number;
  now?: () => number;
}

/** Run `fn` while holding `${target}.mutex`. Throws if it can't be acquired. */
export function withFileMutex<T>(target: string, fn: () => T, opts: FileMutexOptions = {}): T {
  const mutex = `${target}.mutex`;
  const timeoutMs = opts.timeoutMs ?? 2000;
  const staleMs = opts.staleMs ?? 10_000;
  const now = opts.now ?? Date.now;
  const token = `${process.pid}:${Math.random().toString(36).slice(2)}:${now()}`;
  const deadline = now() + timeoutMs;

  for (;;) {
    try {
      fs.writeFileSync(mutex, token, { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    breakIfStale(mutex, staleMs, now);
    if (now() >= deadline) {
      throw new Error(`could not acquire ${mutex} within ${timeoutMs}ms`);
    }
    sleepSync(5 + Math.floor(Math.random() * 10));
  }

  try {
    return fn();
  } finally {
    try {
      if (fs.readFileSync(mutex, "utf8") === token) fs.unlinkSync(mutex);
    } catch {
      // Already gone (broken as stale by someone else): nothing to release.
    }
  }
}

function breakIfStale(mutex: string, staleMs: number, now: () => number): void {
  let st: fs.Stats;
  try {
    st = fs.statSync(mutex);
  } catch {
    return; // released meanwhile
  }
  if (now() - st.mtimeMs < staleMs) return;
  // Rename is atomic: of several processes breaking the same stale file, only
  // one rename succeeds; the rest get ENOENT and simply retry `wx`.
  const grave = `${mutex}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    fs.renameSync(mutex, grave);
  } catch {
    return;
  }
  // If a fresh holder raced in between stat and rename, we just moved THEIR
  // file: put it back. (Their mtime is new, so it's not stale.)
  try {
    const moved = fs.statSync(grave);
    if (now() - moved.mtimeMs < staleMs) {
      try {
        fs.linkSync(grave, mutex); // fails if someone already re-created it
      } catch {
        /* someone else holds it now; the fresh holder's unlink check will skip */
      }
    }
  } finally {
    try {
      fs.unlinkSync(grave);
    } catch {
      /* ignore */
    }
  }
}
