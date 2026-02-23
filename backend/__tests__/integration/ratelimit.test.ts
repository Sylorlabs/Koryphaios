/**
 * Rate Limiting Integration Tests
 * 
 * Tests rate limiting algorithms:
 * - Sliding window
 * - Token bucket
 * - Multi-layer protection
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { SlidingWindowRateLimiter } from '../../src/ratelimit/sliding-window';
import { TokenBucketRateLimiter } from '../../src/ratelimit/token-bucket';
import { InMemoryRedis } from '../../src/redis/client';
import type { RateLimitConfig } from '../../src/ratelimit/types';

describe('Rate Limiting', () => {
  const redis = new InMemoryRedis();

  describe('SlidingWindowRateLimiter', () => {
    let limiter: SlidingWindowRateLimiter;
    const config: RateLimitConfig = {
      windowSeconds: 60,
      maxRequests: 5,
      algorithm: 'sliding-window',
    };

    beforeAll(async () => {
      limiter = new SlidingWindowRateLimiter(redis, config);
      await limiter.initialize();
    });

    beforeAll(async () => {
      await redis.flushall();
    });

    it('should allow requests within limit', async () => {
      const key = 'test:user:1';
      
      for (let i = 0; i < 5; i++) {
        const result = await limiter.check(key);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(4 - i);
      }
    });

    it('should block requests over limit', async () => {
      const key = 'test:user:2';
      
      // Use up all requests
      for (let i = 0; i < 5; i++) {
        await limiter.check(key);
      }

      // Next request should be blocked
      const result = await limiter.check(key);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('should track different keys independently', async () => {
      const key1 = 'test:user:3';
      const key2 = 'test:user:4';

      // Use up key1
      for (let i = 0; i < 5; i++) {
        await limiter.check(key1);
      }
      const result1 = await limiter.check(key1);
      expect(result1.allowed).toBe(false);

      // Key2 should still work
      const result2 = await limiter.check(key2);
      expect(result2.allowed).toBe(true);
    });

    it('should reset limit', async () => {
      const key = 'test:user:5';

      // Use up limit
      for (let i = 0; i < 5; i++) {
        await limiter.check(key);
      }

      await limiter.reset(key);

      // Should work again
      const result = await limiter.check(key);
      expect(result.allowed).toBe(true);
    });

    it('should peek without consuming', async () => {
      const key = 'test:user:6';

      // Add some requests
      await limiter.check(key);
      await limiter.check(key);

      const peek = await limiter.peek(key);
      expect(peek.count).toBe(2);
      expect(peek.limit).toBe(5);

      // Peek should not consume
      const peek2 = await limiter.peek(key);
      expect(peek2.count).toBe(2);
    });
  });

  describe('TokenBucketRateLimiter', () => {
    let limiter: TokenBucketRateLimiter;
    const config: RateLimitConfig = {
      windowSeconds: 60,
      maxRequests: 10, // bucket size
      algorithm: 'token-bucket',
      burstSize: 10,
    };

    beforeAll(async () => {
      limiter = new TokenBucketRateLimiter(redis, config);
      await limiter.initialize();
    });

    beforeAll(async () => {
      await redis.flushall();
    });

    it('should allow burst up to bucket size', async () => {
      const key = 'bucket:user:1';

      // Should allow 10 requests (bucket size)
      for (let i = 0; i < 10; i++) {
        const result = await limiter.consume(key);
        expect(result.allowed).toBe(true);
      }

      // 11th should be blocked
      const result = await limiter.consume(key);
      expect(result.allowed).toBe(false);
    });

    it('should track tokens remaining', async () => {
      const key = 'bucket:user:2';

      const result1 = await limiter.consume(key);
      expect(result1.remaining).toBe(9);

      const result2 = await limiter.consume(key);
      expect(result2.remaining).toBe(8);
    });

    it('should peek without consuming tokens', async () => {
      const key = 'bucket:user:3';

      await limiter.consume(key);
      await limiter.consume(key);

      const peek = await limiter.peek(key);
      expect(peek.tokens).toBe(8);
      expect(peek.limit).toBe(10);

      // Still 8 tokens after peek
      const peek2 = await limiter.peek(key);
      expect(peek2.tokens).toBe(8);
    });

    it('should handle different costs', async () => {
      const key = 'bucket:user:4';

      // Consume 5 tokens at once
      const result = await limiter.consume(key, 5);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(5);

      // Try to consume 6 more (should fail)
      const result2 = await limiter.consume(key, 6);
      expect(result2.allowed).toBe(false);
    });

    it('should reset bucket', async () => {
      const key = 'bucket:user:5';

      // Use up all tokens
      for (let i = 0; i < 10; i++) {
        await limiter.consume(key);
      }

      await limiter.reset(key);

      // Should have full bucket
      const peek = await limiter.peek(key);
      expect(peek.tokens).toBe(10);
    });
  });

  describe('Rate Limit Headers', () => {
    let limiter: SlidingWindowRateLimiter;
    const config: RateLimitConfig = {
      windowSeconds: 60,
      maxRequests: 5,
      algorithm: 'sliding-window',
    };

    beforeAll(async () => {
      limiter = new SlidingWindowRateLimiter(redis, config);
      await limiter.initialize();
    });

    it('should include all required fields in result', async () => {
      const key = 'headers:user:1';

      const result = await limiter.check(key);

      expect(result.allowed).toBeDefined();
      expect(result.remaining).toBeDefined();
      expect(result.resetTime).toBeDefined();
      expect(result.limit).toBeDefined();
      expect(result.limit).toBe(5);
    });

    it('should include retryAfter when blocked', async () => {
      const key = 'headers:user:2';

      // Use up all requests
      for (let i = 0; i < 5; i++) {
        await limiter.check(key);
      }

      const result = await limiter.check(key);
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeDefined();
      expect(result.retryAfter).toBeGreaterThan(0);
    });
  });
});
