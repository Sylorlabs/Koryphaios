// NOTE: The original custom `Router` class (src/routes/router.ts) was removed when the
// backend migrated to ElysiaJS route modules (src/routes/v1/*.ts). Route behavior is now
// covered end-to-end by test/provider-routes.test.ts and backend/scripts/smoke-endpoints.ts
// (boots the real server and exercises the live HTTP endpoints). The obsolete Router-class
// tests were not portable; the rate-limiter tests below remain valid.

import { describe, test, expect } from 'bun:test';
import { RateLimiter } from '../../src/security/rate-limit';

describe('Rate Limiter', () => {
  test('should allow requests within limit', () => {
    const limiter = new RateLimiter(5, 60000);
    for (let i = 0; i < 5; i++) {
      expect(limiter.check('test-key').allowed).toBe(true);
    }
  });

  test('should block requests exceeding limit', () => {
    const limiter = new RateLimiter(3, 60000);
    for (let i = 0; i < 3; i++) limiter.check('test-key');
    expect(limiter.check('test-key').allowed).toBe(false);
  });

  test('should reset after window expires', async () => {
    const limiter = new RateLimiter(2, 100);
    limiter.check('test-key');
    limiter.check('test-key');
    expect(limiter.check('test-key').allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    expect(limiter.check('test-key').allowed).toBe(true);
  });

  test('tracks separate keys independently', () => {
    const limiter = new RateLimiter(1, 1000);
    expect(limiter.check('10.0.0.1').allowed).toBe(true);
    expect(limiter.check('10.0.0.2').allowed).toBe(true);
    expect(limiter.check('10.0.0.1').allowed).toBe(false);
  });
});
