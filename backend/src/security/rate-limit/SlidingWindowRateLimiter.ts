// Sliding Window Rate Limiter
// Production-ready distributed rate limiting with Redis fallback

import { getRedisClient } from "../../redis";
import { randomBytes } from "node:crypto";
import { serverLog } from "../../logger";
import type { RateLimitConfig, RateLimitOptions, RateLimitResult } from "./types";
import { RateLimiter } from "./utils";

/**
 * Sliding window rate limiter using Redis sorted sets
 * Provides smooth rate limiting without the "burst at reset" problem
 *
 * SECURITY: Falls back to local in-memory limiting if Redis is unavailable
 * to prevent DoS when external services fail.
 */
export class SlidingWindowRateLimiter {
  private fallbackLimiters = new Map<string, RateLimiter>();
  private lastFailure = 0;
  private FAILURE_BACKOFF_MS = 60_000; // Wait 1 minute before retrying Redis after failure

  constructor(private config: RateLimitConfig) {}

  async check(options: RateLimitOptions): Promise<RateLimitResult> {
    const redis = getRedisClient();
    const { identifier, maxRequests, windowMs } = { ...this.config, ...options };
    const key = `${this.config.keyPrefix || "ratelimit"}:sliding:${identifier}`;
    const now = Date.now();
    const windowStart = now - windowMs;

    try {
      // Remove expired entries
      await redis.zremrangebyscore(key, "0", windowStart);

      // Count current requests in window
      const current = await redis.zcard(key);

      if (current < maxRequests) {
        // Add current request
        const score = now;
        const member = `${now}:${randomBytes(8).toString("hex")}`;
        await redis.zadd(key, score, member);
        await redis.expire(key, Math.ceil(windowMs / 1000) + 1);

        return {
          allowed: true,
          remaining: maxRequests - current - 1,
          resetAt: now + windowMs,
          limit: maxRequests,
        };
      } else {
        // Rate limit exceeded - find when the oldest request will expire
        const oldest = await redis.zrange(key, 0, 0, "WITHSCORES");
        const resetAt = oldest.length >= 2 ? Number(oldest[1]) + windowMs : now + windowMs;
        const retryAfter = Math.ceil((resetAt - now) / 1000);

        return {
          allowed: false,
          remaining: 0,
          resetAt,
          retryAfter,
          limit: maxRequests,
        };
      }
    } catch (err) {
      serverLog.warn({ err, key }, "Redis rate limiter unavailable, using fallback");

      // SECURITY: Use fallback in-memory limiter instead of fail-open
      // This prevents DoS when Redis is unavailable
      return this.checkWithFallback(identifier, maxRequests, windowMs, now);
    }
  }

  /**
   * Fallback in-memory rate limiting when Redis is unavailable.
   * Uses a simple fixed-window algorithm per identifier.
   */
  private checkWithFallback(
    identifier: string,
    maxRequests: number,
    windowMs: number,
    now: number
  ): RateLimitResult {
    let limiter = this.fallbackLimiters.get(identifier);

    if (!limiter) {
      limiter = new RateLimiter(maxRequests, windowMs);
      this.fallbackLimiters.set(identifier, limiter);
    }

    const result = limiter.check(identifier);

    serverLog.debug(
      { identifier, allowed: result.allowed, remaining: result.remaining },
      "Fallback rate limiter used"
    );

    return {
      allowed: result.allowed,
      remaining: result.remaining,
      resetAt: now + result.resetIn,
      limit: maxRequests,
      retryAfter: result.allowed ? undefined : Math.ceil(result.resetIn / 1000),
    };
  }

  async reset(identifier: string): Promise<void> {
    try {
      const redis = getRedisClient();
      const key = `${this.config.keyPrefix || "ratelimit"}:sliding:${identifier}`;
      await redis.del(key);
    } catch (err) {
      serverLog.error({ err, identifier }, "Failed to reset rate limit");
    }
  }
}
