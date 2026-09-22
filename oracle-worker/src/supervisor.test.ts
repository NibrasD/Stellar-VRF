/**
 * supervisor.test.ts — listener crash recovery and failover policy.
 *
 * Covers the reviewer's finding that a crashed listener left the node holding
 * the lease ("leader") while nothing processed requests.
 */

import { describe, it, expect, vi } from "vitest";
import { ListenerSupervisor, type SupervisorDeps } from "./supervisor.js";

function makeDeps(overrides: Partial<SupervisorDeps> = {}) {
  let leader = true;
  let clock = 0;
  const deps: SupervisorDeps & { setLeader: (v: boolean) => void } = {
    runSession: vi.fn().mockResolvedValue(undefined),
    isLeader: () => leader,
    relinquish: vi.fn(async () => { leader = false; }),
    sleep: vi.fn(async (ms: number) => { clock += ms; }),
    now: () => clock,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onSessionStart: vi.fn(),
    onSessionEnd: vi.fn(),
    onRestart: vi.fn(),
    setLeader: (v: boolean) => { leader = v; },
    ...overrides,
  };
  return deps;
}

const OPTS = { maxRestarts: 3, restartWindowMs: 600_000, baseBackoffMs: 1000, maxBackoffMs: 8000 };

describe("ListenerSupervisor", () => {
  it("restarts a crashed listener and keeps leadership when the restart succeeds", async () => {
    const deps = makeDeps();
    let calls = 0;
    deps.runSession = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("RPC exploded");
      deps.setLeader(false); // second session runs until leadership ends normally
    });

    await new ListenerSupervisor(deps, OPTS).start();

    expect(deps.runSession).toHaveBeenCalledTimes(2);
    expect(deps.onRestart).toHaveBeenCalledTimes(1);
    expect(deps.relinquish).not.toHaveBeenCalled();
    expect(deps.onSessionEnd).toHaveBeenNthCalledWith(1, "RPC exploded");
  });

  it("backs off exponentially between restarts", async () => {
    const deps = makeDeps();
    let calls = 0;
    deps.runSession = vi.fn(async () => {
      if (++calls <= 3) throw new Error("boom");
      deps.setLeader(false);
    });

    await new ListenerSupervisor(deps, OPTS).start();

    expect((deps.sleep as any).mock.calls.map((c: number[]) => c[0])).toEqual([1000, 2000, 4000]);
  });

  it("relinquishes leadership when the listener keeps crashing, so the standby takes over", async () => {
    const deps = makeDeps();
    deps.runSession = vi.fn().mockRejectedValue(new Error("permanently broken"));

    await new ListenerSupervisor(deps, OPTS).start();

    // 1 initial run + maxRestarts restarts, then give up
    expect(deps.runSession).toHaveBeenCalledTimes(OPTS.maxRestarts + 1);
    expect(deps.relinquish).toHaveBeenCalledTimes(1);
    expect((deps.relinquish as any).mock.calls[0][0]).toMatch(/permanently broken/);
  });

  it("does not count crashes outside the restart window", async () => {
    const deps = makeDeps();
    let calls = 0;
    deps.runSession = vi.fn(async () => {
      calls++;
      if (calls <= 6) throw new Error("rare crash");
      deps.setLeader(false);
    });
    // Each backoff advances the clock by far more than the window.
    deps.sleep = vi.fn(async () => { clock += 10_000_000; });
    let clock = 0;
    deps.now = () => clock;

    await new ListenerSupervisor(deps, OPTS).start();

    expect(deps.relinquish).not.toHaveBeenCalled();
    expect(deps.runSession).toHaveBeenCalledTimes(7);
  });

  it("does not restart if leadership was lost during the backoff", async () => {
    const deps = makeDeps();
    deps.runSession = vi.fn().mockRejectedValue(new Error("boom"));
    deps.sleep = vi.fn(async () => { deps.setLeader(false); });

    await new ListenerSupervisor(deps, OPTS).start();

    expect(deps.runSession).toHaveBeenCalledTimes(1);
    expect(deps.relinquish).not.toHaveBeenCalled();
  });

  it("stop() makes the running session's isCurrent() false", async () => {
    const deps = makeDeps();
    const sup = new ListenerSupervisor(deps, OPTS);
    let seen: boolean[] = [];
    deps.runSession = vi.fn(async (isCurrent) => {
      seen.push(isCurrent());
      sup.stop();
      seen.push(isCurrent());
      deps.setLeader(false);
    });

    await sup.start();

    expect(seen).toEqual([true, false]);
  });

  it("never runs two sessions at once across a lose/regain leadership flap", async () => {
    const deps = makeDeps();
    const sup = new ListenerSupervisor(deps, OPTS);
    let concurrent = 0;
    let maxConcurrent = 0;
    let sessions = 0;
    let release!: () => void;

    deps.runSession = vi.fn(async (isCurrent) => {
      sessions++;
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      if (sessions === 1) {
        // Simulate the old loop still unwinding while leadership flaps.
        await new Promise<void>((r) => { release = r; });
        expect(isCurrent()).toBe(false); // superseded
      } else {
        deps.setLeader(false);
      }
      concurrent--;
    });

    const first = sup.start();
    await Promise.resolve();
    sup.stop();            // lost leadership
    const second = sup.start(); // regained before the old loop noticed
    release();
    await Promise.all([first, second]);

    expect(maxConcurrent).toBe(1);
    expect(sessions).toBe(2); // the supervisor ran the new session after the old one ended
  });
});
