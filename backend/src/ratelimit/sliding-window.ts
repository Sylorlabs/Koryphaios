// Sliding Window Rate Limiter
// Redis-backed with atomic Lua operations
// Provides accurate rate limiting without boundary issues

import { serverLog } from '../logger';
import type { RateLimitConfig, RateLimitResult } from './types';

// Lua script for atomic sliding window operation
// Removes old entries, counts current, adds new entry if allowed
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local window = tonumber(ARGV[1])
local max_requests = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local window_start = now - window

-- Remove old entries outside the window
redis.call('ZREMRANGEBYSCORE', key, 0, window_start)

-- Count current entries
local current = redis.call('ZCARD', key)

-- Check if allowed
if current < max_requests then
    -- Add current request with unique member (timestamp + random)
    local member = now .. ':' .. redis.call('INCR', key .. ':counter')
    redis.call('ZADD', key, now, member)
    
    -- Set expiration on the key
    redis.call('EXPIRE', key, math.ceil(window / 1000) + 1)
    
    -- Get the oldest entry for reset time calculation
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local reset_at = 0
    if #oldest >= 2 then
        reset_at = tonumber(oldest[2]) + window
    else
        reset_at = now + window
    end
    
    return {1, max_requests - current - 1, reset_at}
else
    -- Not allowed - get when the oldest entry expires
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local reset_at = now + window
    if #oldest >= 2 then
        reset_at = tonumber(oldest[2]) + window
    end
    
    return {0, 0, reset_at}
end
`;

export class SlidingWindowRateLimiter {
  private redis: any;
  private scriptSha: string | null = null;
  private localCache: Map<string, { count: number; resetAt: number }> = new Map();
  private config: RateLimitConfig;

  constructor(redis: any, config: RateLimitConfig) {
    this.redis = redis;
    this.config = config;
  }

  /**
   * Initialize the rate limiter
   * Loads Lua script into Redis
   */
  async initialize(): Promise<void> {
    try {
      // Load Lua script
      this.scriptSha = await this.redis.script('LOAD', SLIDING_WINDOW_SCRIPT);
      serverLog.info('Sliding window rate limiter initialized');
    } catch (error: any) {
      serverLog.error({ error }, 'Failed to initialize rate limiter');
      throw error;
    }
  }

  /**
   * Check if request is allowed
   * @param key - Unique identifier (user:123, ip:1.2.3.4, etc.)
   * @returns Rate limit result
   */
  async check(key: string): Promise<RateLimitResult> {
    const now = Date.now();
    const windowMs = this.config.windowSeconds * 1000;

    try {
      // Use Lua script for atomic operation
      const result = await this.redis.evalsha(
        this.scriptSha,
        1,  // Number of keys
        `ratelimit:${key}`,  // KEYS[1]
        windowMs,            // ARGV[1]
        this.config.maxRequests,  // ARGV[2]
        now                  // ARGV[3]
      );

      const allowed = result[0] === 1;
      const remaining = result[1];
      const resetTime = Math.ceil(result[2] / 1000); // Convert to seconds

      return {
        allowed,
        remaining: Math.max(0, remaining),
        resetTime,
        limit: this.config.maxRequests,
        retryAfter: allowed ? undefined : Math.ceil((resetTime * 1000 - now) / 1000),
      };
    } catch (error: any) {
      // If script not in cache, reload and retry
      if (error.message?.includes('NOSCRIPT')) {
        await this.initialize();
        return this.check(key);
      }

      serverLog.error({ error, key }, 'Rate limit check failed');
      
      // Fail open - allow request if Redis is down
      // This prevents Redis from being a single point of failure
      return {
        allowed: true,
        remaining: 1,
        resetTime: Math.ceil(now / 1000) + this.config.windowSeconds,
        limit: this.config.maxRequests,
      };
    }
  }

  /**
   * Get current count without incrementing
   */
  async peek(key: string): Promise<{ count: number; limit: number }> {
    const windowMs = this.config.windowSeconds * 1000;
    const now = Date.now();
    const windowStart = now - windowMs;

    try {
      // Remove old entries
      await this.redis.zremrangebyscore(`ratelimit:${key}`, 0, windowStart);
      
      // Count current
      const count = await this.redis.zcard(`ratelimit:${key}`);
      
      return {
        count: Math.min(count, this.config.maxRequests),
        limit: this.config.maxRequests,
      };
    } catch (error) {
      return { count: 0, limit: this.config.maxRequests };
    }
  }

  /**
   * Reset rate limit for a key
   * Useful for manual unblock or testing
   */
  async reset(key: string): Promise<void> {
    try {
      await this.redis.del(`ratelimit:${key}`);
      await this.redis.del(`ratelimit:${key}:counter`);
    } catch (error: any) {
      serverLog.error({ error, key }, 'Failed to reset rate limit');
    }
  }

  /**
   * Get all active rate limit keys (for monitoring)
   */
  async getActiveKeys(): Promise<string[]> {
    try {
      const keys = await this.redis.keys('ratelimit:*');
      return keys
        .filter((k: string) => !k.endsWith(':counter'))
        .map((k: string) => k.replace('ratelimit:', ''));
    } catch {
      return [];
    }
  }
}

/**
 * Create sliding window rate limiter
 */
export function createSlidingWindowLimiter(
  redis: any,
  config: RateLimitConfig
): SlidingWindowRateLimiter {
  return new SlidingWindowRateLimiter(redis, config);
}
