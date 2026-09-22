/**
 * supervisor.ts — keeps the leader's event listener alive, or hands off.
 *
 * Problem this solves
 * ───────────────────
 * Leadership (a Redis lease renewed by a timer) and the listener (an async
 * polling loop) are independent. If the listener crashes, the lease keeps
 * being renewed, so this node stays "leader" — and the standby is locked out —
 * while nothing processes requests. Previously the crash was just logged.
 *
 * Policy
 * ──────
 *   crash → restart with exponential backoff (a fresh RPC client / cursor
 *           often fixes transient faults)
 *   crash repeatedly (≥ maxRestarts within restartWindowMs)
 *         → relinquish leadership so a healthy standby takes over
 *
 * Sessions
 * ────────
 * Every run gets a session number. `isCurrent(session)` is what the listener
 * uses as its "keep going?" predicate, so a loop from an older session (e.g.
 * one still unwinding after a leadership flap) can never keep running next to
 * its replacement. The old boolean `listenerActive` flag allowed exactly that:
 * lose + regain leadership within one poll interval and two loops ran at once.
 */

export interface SupervisorDeps {
  /** Run one listener session. Resolve = clean stop, reject = crash. */
  runSession: (isCurrent: () => boolean) => Promise<void>;
  isLeader: () => boolean;
  relinquish: (reason: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: {
    info: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
  };
  onSessionStart?: () => void;
  onSessionEnd?: (error?: string) => void;
  onRestart?: () => void;
}

export interface SupervisorOptions {
  maxRestarts: number;
  restartWindowMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_SUPERVISOR_OPTIONS: SupervisorOptions = {
  maxRestarts: parseInt(process.env.LISTENER_MAX_RESTARTS || "5", 10),
  restartWindowMs: parseInt(process.env.LISTENER_RESTART_WINDOW_MS || "600000", 10), // 10 min
  baseBackoffMs: parseInt(process.env.LISTENER_RESTART_BASE_MS || "2000", 10),
  maxBackoffMs: parseInt(process.env.LISTENER_RESTART_MAX_MS || "60000", 10),
};

export class ListenerSupervisor {
  private session = 0;
  private running = false;
  private crashTimes: number[] = [];

  constructor(
    private deps: SupervisorDeps,
    private opts: SupervisorOptions = DEFAULT_SUPERVISOR_OPTIONS
  ) {}

  /** Called on becoming leader. Idempotent while a supervisor loop is live. */
  start(): Promise<void> {
    const mySession = ++this.session;
    if (this.running) {
      // The live loop re-reads `this.session` and adopts the new session on
      // its next iteration; the old session's listener stops itself.
      return Promise.resolve();
    }
    return this.loop(mySession);
  }

  /** Called on losing leadership. Invalidates the current session. */
  stop(): void {
    this.session++;
  }

  isRunning(): boolean {
    return this.running;
  }

  private async loop(initialSession: number): Promise<void> {
    this.running = true;
    let session = initialSession;
    try {
      while (this.deps.isLeader()) {
        // Adopt the newest session (covers stop()+start() while we slept).
        session = this.session;
        const isCurrent = () => this.session === session && this.deps.isLeader();

        this.deps.onSessionStart?.();
        let crash: string | null = null;
        try {
          await this.deps.runSession(isCurrent);
        } catch (err) {
          crash = err instanceof Error ? err.message : String(err);
        }
        this.deps.onSessionEnd?.(crash ?? undefined);

        if (crash === null) {
          // Clean exit: leadership lost or session superseded.
          if (this.session !== session && this.deps.isLeader()) {
            continue; // superseded by a fresh start() — run the new session
          }
          return;
        }

        // ── crash handling ──
        const now = this.deps.now();
        this.crashTimes = this.crashTimes.filter((t) => now - t < this.opts.restartWindowMs);
        this.crashTimes.push(now);
        const recent = this.crashTimes.length;

        if (recent > this.opts.maxRestarts) {
          this.deps.log.error(
            `[Supervisor] Listener crashed ${recent} times within ` +
              `${Math.round(this.opts.restartWindowMs / 1000)}s (last: ${crash}). ` +
              `Relinquishing leadership so the standby can take over.`
          );
          this.crashTimes = [];
          await this.deps.relinquish(`listener crashed ${recent} times: ${crash}`);
          return;
        }

        const backoff = Math.min(
          this.opts.baseBackoffMs * 2 ** (recent - 1),
          this.opts.maxBackoffMs
        );
        this.deps.log.warn(
          `[Supervisor] Listener crashed (${crash}). Restart ${recent}/${this.opts.maxRestarts} in ${backoff}ms.`
        );
        await this.deps.sleep(backoff);
        if (!this.deps.isLeader()) {
          this.deps.log.info("[Supervisor] Lost leadership during restart backoff; not restarting.");
          return;
        }
        this.deps.onRestart?.();
      }
    } finally {
      this.running = false;
    }
  }
}
