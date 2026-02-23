// Token Bucket Rate Limiter
// Allows bursts while maintaining steady rate
// Good for APIs that can handle occasional spikes

import { serverLog } from '../logger';
import type { RateLimitConfig, RateLimitResult } from './types';

// Lua script for atomic token bucket operation
const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local bucket_size = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])  -- tokens per second
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])  -- usually 1

-- Get current bucket state
local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(bucket[1]) or bucket_size
local last_refill = tonumber(bucket[2]) or now

-- Calculate tokens to add based on time elapsed
local time_passed = math.max(0, now - last_refill) / 1000  -- convert to seconds
local tokens_to_add = time_passed * refill_rate
tokens = math.min(bucket_size, tokens + tokens_to_add)

-- Try to consume tokens
local allowed = 0
local remaining = 0

if tokens >= cost then
    tokens = tokens - cost
    allowed = 1
    remaining = math.floor(tokens)
else
    remaining = 0
end

-- Save bucket state
redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
redis.call('EXPIRE', key, 3600)  -- 1 hour TTL

-- Calculate time until enough tokens
local retry_after = 0
if allowed == 0 then
    retry_after = math.ceil((cost - tokens) / refill_rate)
end

return {allowed, remaining, retry_after}
`;

export class TokenBucketRateLimiter {
  private redis: any;
  private scriptSha: string | null = null;
  private bucketSize: number;
  private refillRate: number;  // tokens per second

  constructor(redis: any, config: RateLimitConfig) {
    this.redis = redis;
    this.bucketSize = config.burstSize || config.maxRequests;
    this.refillRate = config.maxRequests / config.windowSeconds;
  }

  async initialize(): Promise<void> {
    try {
      this.scriptSha = await this.redis.script('LOAD', TOKEN_BUCKET_SCRIPT);
      serverLog.info({ bucketSize: this.bucketSize, refillRate: this.refillRate }, 'Token bucket rate limiter initialized');
    } catch (error: any) {
      serverLog.error({ error }, 'Failed to initialize token bucket');
      throw error;
    }
  }

  /**
   * Consume tokens from the bucket
   * @param key - Unique identifier
   * @param cost - Number of tokens to consume (default 1)
   */
  async consume(key: string, cost: number = 1): Promise<RateLimitResult> {
    const now = Date.now();

    try {
      const result = await this.redis.evalsha(
        this.scriptSha,
        1,
        `bucket:${key}`,
        this.bucketSize,
        this.refillRate,
        now,
        cost
      );

      const allowed = result[0] === 1;
      const remaining = result[1];
      const retryAfter = result[2];

      // Calculate reset time based on refill rate
      const tokensNeeded = this.bucketSize - remaining;
      const resetTime = Math.ceil(now / 1000) + Math.ceil(tokensNeeded / this.refillRate);

      return {
        allowed,
        remaining,
        resetTime,
        limit: this.bucketSize,
        retryAfter: allowed ? undefined : retryAfter,
      };
    } catch (error: any) {
      if (error.message?.includes('NOSCRIPT')) {
        await this.initialize();
        return this.consume(key, cost);
      }

      serverLog.error({ error, key }, 'Token bucket consume failed');
      
      // Fail open
      return {
        allowed: true,
        remaining: 1,
        resetTime: Math.ceil(now / 1000) + 60,
        limit: this.bucketSize,
      };
    }
  }

  /**
   * Check without consuming tokens
   */
  async peek(key: string): Promise<{ tokens: number; limit: number }> {
    try {
      const bucket = await this.redis.hmget(`bucket:${key}`, 'tokens', 'last_refill');
      const tokens = parseFloat(bucket[0]) || this.bucketSize;
      
      return {
        tokens: Math.floor(tokens),
        limit: this.bucketSize,
      };
    } catch {
      return { tokens: this.bucketSize, limit: this.bucketSize };
    }
  }

  /**
   * Reset bucket
   */
  async reset(key: string): Promise<void> {
    try {
      await this.redis.del(`bucket:${key}`);
    } catch (error: any) {
      serverLog.error({ error, key }, 'Failed to reset bucket');
    }
  }
}

export function createTokenBucketLimiter(
  redis: any,
  config: RateLimitConfig
): TokenBucketRateLimiter {
  return new TokenBucketRateLimiter(redis, config);
}
