/**
 * fileMutex.test.ts — in-process behaviour of the file mutex.
 * The cross-process race test (real child processes) is file_mutex_drill.mjs,
 * run in CI after the build.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { withFileMutex } from "./fileMutex.js";

function tmp(name: string): string {
  return path.join(os.tmpdir(), `vrf-mutex-${name}-${process.pid}-${Math.random().toString(36).slice(2)}`);
}

describe("withFileMutex", () => {
  it("excludes a second holder while the first is inside", () => {
    const target = tmp("nested");
    const inner = withFileMutex(target, () => {
      expect(() => withFileMutex(target, () => 1, { timeoutMs: 30 })).toThrow(/could not acquire/);
      return "outer";
    });
    expect(inner).toBe("outer");
    expect(fs.existsSync(`${target}.mutex`)).toBe(false);
  });

  it("breaks a mutex abandoned by a crashed holder, but only once it is stale", () => {
    const target = tmp("stale");
    fs.writeFileSync(`${target}.mutex`, "dead-holder");
    let clock = Date.now();
    // Fresh abandoned file: not broken, acquisition times out.
    expect(() => withFileMutex(target, () => 1, { timeoutMs: 30, staleMs: 60_000 })).toThrow(/could not acquire/);
    // Once older than staleMs it is broken and we get in.
    clock += 120_000;
    expect(withFileMutex(target, () => 42, { staleMs: 60_000, now: () => clock })).toBe(42);
    expect(fs.existsSync(`${target}.mutex`)).toBe(false);
  });

  it("releases the mutex even when the critical section throws", () => {
    const target = tmp("throw");
    expect(() => withFileMutex(target, () => { throw new Error("boom"); })).toThrow("boom");
    expect(fs.existsSync(`${target}.mutex`)).toBe(false);
    expect(withFileMutex(target, () => "again")).toBe("again");
  });
});
