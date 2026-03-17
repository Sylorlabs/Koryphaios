// Fixed Window Rate Limiter
// Production-ready distributed rate limiting with Redis fallback

import { getRedisClient } from "../../redis";
import { serverLog } from "../../logger";
import type { RateLimitConfig, RateLimitOptions, RateLimitResult } from "./types";
import { RateLimiter } from "./utils";

/**
 * Fixed window rate limiter using Redis
 * Simple and efficient, but can have burst-at-reset behavior
 *
 * SECURITY: Falls back to local in-memory limiting if Redis is unavailable
 * to prevent DoS when external services fail.
 */
export class FixedWindowRateLimiter {
  private fallbackLimiters = new Map<string, RateLimiter>();

  constructor(private config: RateLimitConfig) {}

  async check(options: RateLimitOptions): Promise<RateLimitResult> {
    const redis = getRedisClient();
    const { identifier, maxRequests, windowMs } = { ...this.config, ...options };
    const now = Date.now();
    const windowId = Math.floor(now / windowMs);
    const key = `${this.config.keyPrefix || "ratelimit"}:fixed:${identifier}:${windowId}`;

    try {
      // Increment counter
      const current = await redis.incr(key);

      // Set expiration on first request
      if (current === 1) {
        await redis.expire(key, Math.ceil(windowMs / 1000) + 1);
      }

      if (current <= maxRequests) {
        return {
          allowed: true,
          remaining: maxRequests - current,
          resetAt: (windowId + 1) * windowMs,
          limit: maxRequests,
        };
      } else {
        const resetAt = (windowId + 1) * windowMs;
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
      serverLog.warn({ err, key }, "Redis fixed window limiter unavailable, using fallback");

      // SECURITY: Use fallback in-memory limiter instead of fail-open
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
      // Clear all windows for this identifier
      const pattern = `${this.config.keyPrefix || "ratelimit"}:fixed:${identifier}:*`;
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (err) {
      serverLog.error({ err, identifier }, "Failed to reset rate limit");
    }
  }
}
