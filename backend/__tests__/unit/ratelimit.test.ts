/**
 * Unit Tests: Rate Limiting Algorithms
 */

import { describe, it, expect } from 'bun:test';

// Simple in-memory sliding window implementation for testing
class TestSlidingWindow {
  private requests: Map<string, number[]> = new Map();
  private windowMs: number;
  private maxRequests: number;

  constructor(windowMs: number, maxRequests: number) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  check(key: string): { allowed: boolean; remaining: number } {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    
    let timestamps = this.requests.get(key) || [];
    
    // Remove old requests
    timestamps = timestamps.filter(t => t > windowStart);
    
    // Check if allowed
    const allowed = timestamps.length < this.maxRequests;
    
    if (allowed) {
      timestamps.push(now);
      this.requests.set(key, timestamps);
    }
    
    return {
      allowed,
      remaining: Math.max(0, this.maxRequests - timestamps.length),
    };
  }

  reset(key: string): void {
    this.requests.delete(key);
  }
}

// Simple token bucket for testing
class TestTokenBucket {
  private tokens: Map<string, { count: number; lastRefill: number }> = new Map();
  private bucketSize: number;
  private refillRate: number; // tokens per ms

  constructor(bucketSize: number, refillRatePerSecond: number) {
    this.bucketSize = bucketSize;
    this.refillRate = refillRatePerSecond / 1000;
  }

  consume(key: string, cost: number = 1): { allowed: boolean; remaining: number } {
    const now = Date.now();
    
    let bucket = this.tokens.get(key);
    if (!bucket) {
      bucket = { count: this.bucketSize, lastRefill: now };
    }
    
    // Calculate refill
    const elapsed = now - bucket.lastRefill;
    const refill = elapsed * this.refillRate;
    bucket.count = Math.min(this.bucketSize, bucket.count + refill);
    bucket.lastRefill = now;
    
    // Try to consume
    if (bucket.count >= cost) {
      bucket.count -= cost;
      this.tokens.set(key, bucket);
      return { allowed: true, remaining: Math.floor(bucket.count) };
    }
    
    this.tokens.set(key, bucket);
    return { allowed: false, remaining: Math.floor(bucket.count) };
  }

  reset(key: string): void {
    this.tokens.delete(key);
  }
}

describe('Rate Limiting Algorithms', () => {
  describe('Sliding Window', () => {
    it('should allow requests within limit', () => {
      const limiter = new TestSlidingWindow(60000, 5);
      
      for (let i = 0; i < 5; i++) {
        const result = limiter.check('user:1');
        expect(result.allowed).toBe(true);
      }
    });
    
    it('should block requests over limit', () => {
      const limiter = new TestSlidingWindow(60000, 5);
      
      // Use up all requests
      for (let i = 0; i < 5; i++) {
        limiter.check('user:1');
      }
      
      // Next should be blocked
      const result = limiter.check('user:1');
      expect(result.allowed).toBe(false);
    });
    
    it('should track remaining correctly', () => {
      const limiter = new TestSlidingWindow(60000, 5);
      
      const result1 = limiter.check('user:1');
      expect(result1.remaining).toBe(4);
      
      const result2 = limiter.check('user:1');
      expect(result2.remaining).toBe(3);
    });
    
    it('should isolate different keys', () => {
      const limiter = new TestSlidingWindow(60000, 5);
      
      // Use up user:1's limit
      for (let i = 0; i < 5; i++) {
        limiter.check('user:1');
      }
      
      // user:2 should still have requests
      const result = limiter.check('user:2');
      expect(result.allowed).toBe(true);
    });
    
    it('should reset correctly', () => {
      const limiter = new TestSlidingWindow(60000, 5);
      
      // Use up limit
      for (let i = 0; i < 5; i++) {
        limiter.check('user:1');
      }
      
      // Reset
      limiter.reset('user:1');
      
      // Should work again
      const result = limiter.check('user:1');
      expect(result.allowed).toBe(true);
    });
  });
  
  describe('Token Bucket', () => {
    it('should allow burst up to bucket size', () => {
      const limiter = new TestTokenBucket(10, 1);
      
      // Should allow 10 requests
      for (let i = 0; i < 10; i++) {
        const result = limiter.consume('user:1');
        expect(result.allowed).toBe(true);
      }
      
      // 11th should be blocked
      const result = limiter.consume('user:1');
      expect(result.allowed).toBe(false);
    });
    
    it('should track remaining tokens', () => {
      const limiter = new TestTokenBucket(10, 1);
      
      const result1 = limiter.consume('user:1');
      expect(result1.remaining).toBe(9);
      
      const result2 = limiter.consume('user:1');
      expect(result2.remaining).toBe(8);
    });
    
    it('should handle different costs', () => {
      const limiter = new TestTokenBucket(10, 1);
      
      // Consume 5 at once
      const result1 = limiter.consume('user:1', 5);
      expect(result1.allowed).toBe(true);
      expect(result1.remaining).toBe(5);
      
      // Try to consume 6 more
      const result2 = limiter.consume('user:1', 6);
      expect(result2.allowed).toBe(false);
    });
    
    it('should isolate different keys', () => {
      const limiter = new TestTokenBucket(10, 1);
      
      // Use up user:1's tokens
      for (let i = 0; i < 10; i++) {
        limiter.consume('user:1');
      }
      
      // user:2 should still have tokens
      const result = limiter.consume('user:2');
      expect(result.allowed).toBe(true);
    });
  });
});
