// Token Bucket Rate Limiter
// Production-ready distributed rate limiting with Redis fallback

import { getRedisClient } from "../../redis";
import { serverLog } from "../../logger";
import type { RateLimitConfig, RateLimitOptions, RateLimitResult } from "./types";
import { RateLimiter } from "./utils";

/**
 * Token bucket rate limiter using Redis
 * Good for API rate limiting with burst capacity
 *
 * SECURITY: Falls back to local in-memory limiting if Redis is unavailable
 * to prevent DoS when external services fail.
 */
export class TokenBucketRateLimiter {
  private fallbackLimiters = new Map<string, RateLimiter>();

  constructor(
    private config: RateLimitConfig & {
      bucketSize?: number;
      refillRate?: number;
    }
  ) {}

  async check(options: RateLimitOptions): Promise<RateLimitResult> {
    const redis = getRedisClient();
    const merged = { ...this.config, ...options };
    const { identifier, maxRequests, windowMs } = merged;
    const bucketSize = merged.bucketSize ?? maxRequests;
    const refillRate = merged.refillRate ?? maxRequests / (windowMs / 1000);
    const key = `${this.config.keyPrefix || "ratelimit"}:tokenbucket:${identifier}`;
    const now = Date.now();
    const cost = 1; // Cost per request

    try {
      // Lua script for atomic token bucket operation
      const luaScript = `
        local key = KEYS[1]
        local bucket_size = tonumber(ARGV[1])
        local refill_rate = tonumber(ARGV[2])
        local now = tonumber(ARGV[3])
        local cost = tonumber(ARGV[4])
        local ttl = tonumber(ARGV[5])

        -- Get current state
        local tokens = tonumber(redis.call('HGET', key, 'tokens')) or bucket_size
        local last_refill = tonumber(redis.call('HGET', key, 'last_refill')) or now

        -- Refill tokens
        local time_passed = math.max(0, now - last_refill) / 1000
        tokens = math.min(bucket_size, tokens + time_passed * refill_rate)

        -- Check if enough tokens
        local allowed = 0
        local remaining = 0
        local retry_after = 0

        if tokens >= cost then
          tokens = tokens - cost
          allowed = 1
          remaining = math.floor(tokens)
        else
          remaining = 0
          retry_after = math.ceil((cost - tokens) / refill_rate)
        end

        -- Save state
        redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
        redis.call('EXPIRE', key, ttl)

        return {allowed, remaining, retry_after}
      `;

      const scriptHash = String(await redis.script("LOAD", luaScript));
      const ttl = Math.ceil(windowMs / 1000) + 60; // TTL + 1 minute buffer

      const result = await redis.evalsha(
        scriptHash,
        1,
        key,
        String(bucketSize),
        String(refillRate),
        String(now),
        String(cost),
        String(ttl)
      );

      const [allowed, remaining, retryAfter] = result as [number, number, number];

      return {
        allowed: allowed === 1,
        remaining,
        resetAt: now + windowMs,
        retryAfter: retryAfter > 0 ? retryAfter : undefined,
        limit: bucketSize,
      };
    } catch (err) {
      serverLog.warn({ err, key }, "Redis token bucket limiter unavailable, using fallback");

      // SECURITY: Use fallback in-memory limiter instead of fail-open
      const bucketSize = merged.bucketSize ?? maxRequests;
      return this.checkWithFallback(identifier, bucketSize, windowMs, now);
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
      const key = `${this.config.keyPrefix || "ratelimit"}:tokenbucket:${identifier}`;
      await redis.del(key);
    } catch (err) {
      serverLog.error({ err, identifier }, "Failed to reset rate limit");
    }
  }
}
