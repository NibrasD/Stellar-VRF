import { describe, it, expect } from "vitest";
import { mapLimit, KeyedMutex } from "./concurrency.js";

const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));

describe("mapLimit", () => {
  it("never runs more than `limit` at once and visits every item", async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(2);
      seen.push(n);
      inFlight--;
    });
    expect(peak).toBe(3);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("a failing item does not stop the rest", async () => {
    const seen: number[] = [];
    await mapLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 3]);
  });
});

describe("KeyedMutex", () => {
  it("serializes work for one key in arrival order", async () => {
    const m = new KeyedMutex();
    const log: string[] = [];
    const job = (name: string, ms: number) =>
      m.run("acct", async () => {
        log.push(`start ${name}`);
        await tick(ms);
        log.push(`end ${name}`);
      });
    await Promise.all([job("a", 5), job("b", 1), job("c", 1)]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("different keys do not block each other", async () => {
    const m = new KeyedMutex();
    const log: string[] = [];
    await Promise.all([
      m.run("x", async () => { log.push("x1"); await tick(5); log.push("x2"); }),
      m.run("y", async () => { log.push("y1"); await tick(1); log.push("y2"); }),
    ]);
    expect(log.indexOf("y2")).toBeLessThan(log.indexOf("x2"));
  });

  it("a rejected job releases the lock", async () => {
    const m = new KeyedMutex();
    await expect(m.run("k", async () => { throw new Error("fail"); })).rejects.toThrow("fail");
    await expect(m.run("k", async () => 7)).resolves.toBe(7);
  });
});
