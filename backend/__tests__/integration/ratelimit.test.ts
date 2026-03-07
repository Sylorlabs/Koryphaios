/**
 * Rate Limiting Integration Tests
 * 
 * Tests the canonical rate limiting implementations from security/rate-limit.ts:
 * - Simple in-memory RateLimiter
 * - Tier configuration
 */

import { describe, it, expect } from 'bun:test';
import { RateLimiter, getTierConfig, DEFAULT_TIERS, ENDPOINT_LIMITS, getEndpointConfig } from '../../src/security/rate-limit';

describe('Rate Limiting', () => {
  describe('RateLimiter (in-memory)', () => {
    it('should allow requests within limit', () => {
      const limiter = new RateLimiter(5, 60_000);

      for (let i = 0; i < 5; i++) {
        const result = limiter.check('test:user:1');
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(4 - i);
      }

      limiter.destroy();
    });

    it('should block requests over limit', () => {
      const limiter = new RateLimiter(5, 60_000);

      for (let i = 0; i < 5; i++) {
        limiter.check('test:user:2');
      }

      const result = limiter.check('test:user:2');
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.resetIn).toBeGreaterThan(0);

      limiter.destroy();
    });

    it('should track different keys independently', () => {
      const limiter = new RateLimiter(5, 60_000);

      for (let i = 0; i < 5; i++) {
        limiter.check('test:user:3');
      }
      const result1 = limiter.check('test:user:3');
      expect(result1.allowed).toBe(false);

      const result2 = limiter.check('test:user:4');
      expect(result2.allowed).toBe(true);

      limiter.destroy();
    });

    it('should clean up on destroy', () => {
      const limiter = new RateLimiter(5, 60_000);
      limiter.check('test:user:5');
      limiter.destroy();
      // After destroy, a new check starts fresh
      const result = limiter.check('test:user:5');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
      limiter.destroy();
    });
  });

  describe('Tier Configuration', () => {
    it('should return free tier by default for unknown tiers', () => {
      const tier = getTierConfig('unknown');
      expect(tier.name).toBe('free');
    });

    it('should return correct tier config', () => {
      const tier = getTierConfig('premium');
      expect(tier.name).toBe('premium');
      expect(tier.limits.user?.maxRequests).toBe(300);
    });

    it('should have all default tiers', () => {
      expect(DEFAULT_TIERS.free).toBeDefined();
      expect(DEFAULT_TIERS.premium).toBeDefined();
      expect(DEFAULT_TIERS.pro).toBeDefined();
      expect(DEFAULT_TIERS.enterprise).toBeDefined();
    });

    it('should have endpoint limits', () => {
      expect(ENDPOINT_LIMITS['/api/v1/chat/completions']).toBeDefined();
      expect(ENDPOINT_LIMITS['/api/v1/models']).toBeDefined();
    });

    it('should return endpoint config', () => {
      const config = getEndpointConfig('/api/v1/chat/completions');
      expect(config).not.toBeNull();
      expect(config!.maxRequests).toBe(100);
    });

    it('should return null for unknown endpoints', () => {
      const config = getEndpointConfig('/unknown');
      expect(config).toBeNull();
    });
  });
});
