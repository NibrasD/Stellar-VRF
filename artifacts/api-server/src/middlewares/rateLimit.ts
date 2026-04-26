/**
 * rateLimit.ts — Simple in-memory rate limiter middleware.
 *
 * Protects VRF endpoints from abuse (gas exhaustion, DB spam).
 * Uses a sliding-window counter per IP. For production deployments
 * behind a load balancer, swap this for a Redis-backed limiter.
 */

import type { Request, Response, NextFunction } from "express";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }
}, 5 * 60 * 1000);

export interface RateLimitOptions {
  /** Max requests per window */
  max: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

/**
 * Create a rate-limiting middleware with the given options.
 *
 * @example
 *   app.use("/api/vrf-requests", rateLimit({ max: 30, windowMs: 60_000 }));
 */
export function rateLimit(opts: RateLimitOptions) {
  const { max, windowMs } = opts;

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    let entry = store.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 1, resetAt: now + windowMs };
      store.set(key, entry);
    } else {
      entry.count++;
    }

    // Set standard rate-limit headers
    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, max - entry.count));
    res.setHeader("X-RateLimit-Reset", Math.ceil(entry.resetAt / 1000));

    if (entry.count > max) {
      res.status(429).json({
        error: "Too many requests",
        retryAfterMs: entry.resetAt - now,
      });
      return;
    }

    next();
  };
}
