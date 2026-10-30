import type { FastifyReply } from "fastify";
import type { Config } from "../config.js";
import { TooManyRequestsError } from "../lib/errors.js";

/**
 * In-memory sliding-window-log rate limiter for the login / OTP endpoints
 * (brute force + credential stuffing). Each key keeps the timestamps of its
 * attempts inside the window; an attempt is admitted while fewer than
 * `limit` remain. State is per process: correct for the single API replica
 * this platform runs (see webhooks/dispatcher.ts "only ever run ONE api
 * replica"); a multi-replica deploy needs a shared store (Postgres/Redis).
 *
 * Memory is bounded: at most `maxKeys` keys are tracked; when full, the
 * least-recently-inserted key is evicted (Map preserves insertion order).
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 100_000,
  ) {}

  /** Records an attempt for `key` if allowed. limit <= 0 disables the limiter. */
  hit(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    if (this.limit <= 0) return { allowed: true };
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const oldest = recent[0]!;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.hits.delete(key); // re-insert so eviction order tracks recency
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) {
      const oldestKey = this.hits.keys().next().value;
      if (oldestKey !== undefined) this.hits.delete(oldestKey);
    }
    return { allowed: true };
  }
}

export type AuthRateLimitConfig = Pick<
  Config,
  | "authRateLimitWindowSeconds"
  | "authLoginMaxPerIp"
  | "authLoginMaxPerAccount"
  | "authOtpVerifyMaxPerIp"
  | "authOtpVerifyMaxPerAccount"
  | "authOtpResendMaxPerIp"
  | "authOtpResendMaxPerAccount"
>;

/** One set of limiters per login plane (merchant / admin), created when the
 *  routes are registered, so each `buildApp()` has its own state. */
export interface AuthRateLimiters {
  loginIp: SlidingWindowLimiter;
  loginAccount: SlidingWindowLimiter;
  otpVerifyIp: SlidingWindowLimiter;
  otpVerifyAccount: SlidingWindowLimiter;
  otpResendIp: SlidingWindowLimiter;
  otpResendAccount: SlidingWindowLimiter;
}

export function createAuthRateLimiters(config: AuthRateLimitConfig, now: () => number = Date.now): AuthRateLimiters {
  const windowMs = config.authRateLimitWindowSeconds * 1000;
  const make = (limit: number) => new SlidingWindowLimiter(limit, windowMs, now);
  return {
    loginIp: make(config.authLoginMaxPerIp),
    loginAccount: make(config.authLoginMaxPerAccount),
    otpVerifyIp: make(config.authOtpVerifyMaxPerIp),
    otpVerifyAccount: make(config.authOtpVerifyMaxPerAccount),
    otpResendIp: make(config.authOtpResendMaxPerIp),
    otpResendAccount: make(config.authOtpResendMaxPerAccount),
  };
}

/**
 * Throws 429 `rate_limited` with a Retry-After header if `key` is over the
 * limit. Call before any expensive work (argon2, DB) so a flood costs little.
 */
export function enforceRateLimit(reply: FastifyReply, limiter: SlidingWindowLimiter, key: string): void {
  const result = limiter.hit(key);
  if (!result.allowed) {
    reply.header("retry-after", String(result.retryAfterSeconds));
    throw new TooManyRequestsError("rate_limited", "too many attempts; retry later");
  }
}
