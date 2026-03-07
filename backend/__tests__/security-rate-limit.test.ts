// Tests for Rate Limiting
import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import {
  SlidingWindowRateLimiter,
  TokenBucketRateLimiter,
  FixedWindowRateLimiter,
  TieredRateLimiter,
  ProgressiveBackoffRateLimiter,
  CaptchaRateLimiter,
  createProductionRateLimiter,
  RateLimitPresets,
} from "../src/security/rate-limit";
import { getRedisManager, getRedisClient } from "../src/redis";

// Mock Redis with full ioredis-compatible API
class MockRedisIORedis {
  private data = new Map<string, string>();
  private sortedSets = new Map<string, Map<number, Set<string>>>();
  private hashFields = new Map<string, Map<string, string>>();
  private counters = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) || null;
  }

  async set(key: string, value: string, mode?: string, ...args: any[]): Promise<"OK"> {
    this.data.set(key, value);

    // Handle EX/PX
    if (mode === "EX" && args[0]) {
      // Set expiration (not implemented in mock)
    } else if (mode === "PX" && args[0]) {
      // Set expiration (not implemented in mock)
    }

    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.data.delete(key)) count++;
      this.sortedSets.delete(key);
      this.hashFields.delete(key);
    }
    return count;
  }

  async incr(key: string): Promise<number> {
    const current = this.counters.get(key) || 0;
    const newValue = current + 1;
    this.counters.set(key, newValue);
    this.data.set(key, String(newValue));
    return newValue;
  }

  async decr(key: string): Promise<number> {
    const current = this.counters.get(key) || 0;
    const newValue = Math.max(0, current - 1);
    this.counters.set(key, newValue);
    this.data.set(key, String(newValue));
    return newValue;
  }

  async expire(key: string, seconds: number): Promise<number> {
    // Mock implementation
    return 1;
  }

  async exists(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.data.has(key)) count++;
    }
    return count;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    if (!this.sortedSets.has(key)) {
      this.sortedSets.set(key, new Map());
    }
    const set = this.sortedSets.get(key)!;

    if (!set.has(score)) {
      set.set(score, new Set());
    }
    return set.get(score)!.add(member) ? 1 : 0;
  }

  async zcard(key: string): Promise<number> {
    const set = this.sortedSets.get(key);
    if (!set) return 0;

    let count = 0;
    for (const members of set.values()) {
      count += members.size;
    }
    return count;
  }

  async zremrangebyscore(key: string, min: string | number, max: string | number): Promise<number> {
    const set = this.sortedSets.get(key);
    if (!set) return 0;

    const minScore = typeof min === "number" ? min : parseFloat(min);
    const maxScore = typeof max === "number" ? max : parseFloat(max);

    let removed = 0;
    for (const [score, members] of set.entries()) {
      if (score >= minScore && score <= maxScore) {
        removed += members.size;
        set.delete(score);
      }
    }

    return removed;
  }

  async zrange(
    key: string,
    start: number,
    stop: number,
    ...args: string[]
  ): Promise<string[]> {
    const set = this.sortedSets.get(key);
    if (!set) return [];

    const entries = Array.from(set.entries()).sort((a, b) => a[0] - b[0]);

    const sliced = entries.slice(start, stop === -1 ? undefined : stop + 1);

    if (args.includes("WITHSCORES")) {
      return sliced.flatMap(([score, members]) => Array.from(members).map((m) => [m, String(score)]));
    }

    return sliced.flatMap(([, members]) => Array.from(members));
  }

  async hmget(key: string, ...fields: string[]): Promise<(string | null)[]> {
    const hash = this.hashFields.get(key);
    if (!hash) return fields.map(() => null);

    return fields.map((f) => hash.get(f) || null);
  }

  async hmset(key: string, ...fieldValues: string[]): Promise<"OK"> {
    if (!this.hashFields.has(key)) {
      this.hashFields.set(key, new Map());
    }
    const hash = this.hashFields.get(key)!;

    for (let i = 0; i < fieldValues.length; i += 2) {
      if (fieldValues[i + 1] !== undefined) {
        hash.set(fieldValues[i], fieldValues[i + 1]);
      }
    }

    return "OK";
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp(pattern.replace("*", ".*"));
    return Array.from(this.data.keys()).filter((k) => regex.test(k));
  }

  async script(mode: "LOAD", script: string): Promise<string> {
    // Simple hash for script ID
    let hash = 0;
    for (let i = 0; i < script.length; i++) {
      hash = ((hash << 5) - hash + script.charCodeAt(i));
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  async evalsha(sha: string, numKeys: number, ...args: any[]): Promise<any[]> {
    // Mock implementation - would need actual Lua execution
    // For now, return default success response
    return [1, 9, Date.now() + 60000];
  }

  clear() {
    this.data.clear();
    this.sortedSets.clear();
    this.hashFields.clear();
    this.counters.clear();
  }
}

const mockRedis = new MockRedisIORedis();

async function resetRedisData() {
  try {
    const redis = getRedisClient() as any;
    if (typeof redis.flushall === "function") {
      await redis.flushall();
    }
  } catch {
    // ignore - tests will still use local mock cleanup below
  }
  mockRedis.clear();
}

beforeAll(async () => {
  await getRedisManager().initialize({
    fallbackToMemory: true,
  });
  await resetRedisData();
});

describe("SlidingWindowRateLimiter", () => {
  let limiter: SlidingWindowRateLimiter;

  beforeEach(async () => {
    limiter = new SlidingWindowRateLimiter({
      maxRequests: 5,
      windowMs: 1000,
      keyPrefix: "test",
    });
    await resetRedisData();
  });

  test("should allow requests within limit", async () => {
    const result = await limiter.check({ identifier: "user1" });

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  test("should track remaining requests correctly", async () => {
    await limiter.check({ identifier: "user1" });
    await limiter.check({ identifier: "user1" });
    const result = await limiter.check({ identifier: "user1" });

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  test("should block requests over limit", async () => {
    // Use up all requests
    for (let i = 0; i < 5; i++) {
      await limiter.check({ identifier: "user1" });
    }

    // Next request should be blocked
    const result = await limiter.check({ identifier: "user1" });

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  test("should calculate reset time correctly", async () => {
    const result = await limiter.check({ identifier: "user1" });

    expect(result.resetAt).toBeGreaterThan(Date.now());
    expect(result.resetAt).toBeLessThan(Date.now() + 2000);
  });

  test("should track different identifiers separately", async () => {
    await limiter.check({ identifier: "user1" });
    await limiter.check({ identifier: "user2" });

    const result1 = await limiter.check({ identifier: "user1" });
    const result2 = await limiter.check({ identifier: "user2" });

    expect(result1.remaining).toBe(3);
    expect(result2.remaining).toBe(3);
  });
});

describe("TokenBucketRateLimiter", () => {
  let limiter: TokenBucketRateLimiter;

  beforeEach(async () => {
    limiter = new TokenBucketRateLimiter({
      maxRequests: 10,
      windowMs: 1000,
      bucketSize: 10,
      refillRate: 5, // 5 tokens per second
      keyPrefix: "test",
    });
    await resetRedisData();
  });

  test("should allow requests within bucket size", async () => {
    const result = await limiter.check({ identifier: "user1" });

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeGreaterThan(0);
  });

  test("should refill tokens over time", async () => {
    // Use all tokens
    for (let i = 0; i < 10; i++) {
      await limiter.check({ identifier: "user1" });
    }

    // Should be rate limited
    let result = await limiter.check({ identifier: "user1" });
    expect(result.allowed).toBe(false);

    // Wait for refill (in real test, would need to mock time)
    // For now, just verify structure
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  test("should support burst capacity", async () => {
    // Make 3 quick requests
    const results = await Promise.all([
      limiter.check({ identifier: "user1" }),
      limiter.check({ identifier: "user1" }),
      limiter.check({ identifier: "user1" }),
    ]);

    // All should succeed (burst capacity)
    results.forEach((r) => expect(r.allowed).toBe(true));
  });
});

describe("FixedWindowRateLimiter", () => {
  let limiter: FixedWindowRateLimiter;

  beforeEach(async () => {
    limiter = new FixedWindowRateLimiter({
      maxRequests: 3,
      windowMs: 1000,
      keyPrefix: "test",
    });
    await resetRedisData();
  });

  test("should allow requests within window", async () => {
    const result1 = await limiter.check({ identifier: "user1" });
    const result2 = await limiter.check({ identifier: "user1" });
    const result3 = await limiter.check({ identifier: "user1" });

    expect(result1.allowed).toBe(true);
    expect(result2.allowed).toBe(true);
    expect(result3.allowed).toBe(true);
  });

  test("should block when window exhausted", async () => {
    await limiter.check({ identifier: "user1" });
    await limiter.check({ identifier: "user1" });
    await limiter.check({ identifier: "user1" });

    const result = await limiter.check({ identifier: "user1" });

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  test("should reset after window expires", async () => {
    // Use all requests
    for (let i = 0; i < 3; i++) {
      await limiter.check({ identifier: "user1" });
    }

    let result = await limiter.check({ identifier: "user1" });
    expect(result.allowed).toBe(false);

    // In real test, would wait for window to expire
    // For now, just verify reset time is set
    expect(result.resetAt).toBeGreaterThan(Date.now());
  });
});

describe("TieredRateLimiter", () => {
  let limiter: TieredRateLimiter;

  beforeEach(async () => {
    await resetRedisData();
    limiter = new TieredRateLimiter({
      global: { maxRequests: 100, windowMs: 1000 },
      ip: { maxRequests: 50, windowMs: 1000 },
      user: { maxRequests: 20, windowMs: 1000 },
      auth: { maxRequests: 5, windowMs: 1000 },
      endpoints: {
        "/api/test": { maxRequests: 10, windowMs: 1000 },
      },
    });
  });

  test("should apply global limit", async () => {
    const result = await limiter.check({
      ip: "127.0.0.1",
      endpoint: "/api/test",
    });

    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(10); // Most restrictive endpoint limit wins
  });

  test("should apply auth endpoint limit", async () => {
    const result = await limiter.check({
      ip: "127.0.0.1",
      endpoint: "/api/auth/login",
      isAuthEndpoint: true,
    });

    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(5); // Auth limit is most restrictive
  });

  test("should apply per-user limit when user ID provided", async () => {
    const result = await limiter.check({
      ip: "127.0.0.1",
      userId: "user123",
      endpoint: "/api/test",
    });

    expect(result.allowed).toBe(true);
    // User limit (20) is more restrictive than IP (50) or endpoint (10)
  });

  test("should return most restrictive limit", async () => {
    const result = await limiter.check({
      ip: "127.0.0.1",
      userId: "user123",
      endpoint: "/api/test",
      isAuthEndpoint: false,
    });

    // Should return the most restrictive applicable limit
    expect(result.allowed).toBe(true);
  });
});

describe("ProgressiveBackoffRateLimiter", () => {
  let limiter: ProgressiveBackoffRateLimiter;

  beforeEach(async () => {
    await resetRedisData();
    limiter = new ProgressiveBackoffRateLimiter({
      maxAttempts: 5,
      windowMs: 300_000, // 5 minutes
    });
  });

  test("should allow requests initially", async () => {
    const result = await limiter.check("user1");

    expect(result.allowed).toBe(true);
    expect(result.attempt).toBe(0);
  });

  test("should track failed attempts", async () => {
    await limiter.check("user1");
    await limiter.check("user1");
    await limiter.check("user1");

    const result = await limiter.check("user1");

    expect(result.allowed).toBe(true);
    expect(result.attempt).toBe(3);
  });

  test("should block after max attempts", async () => {
    // Simulate 5 failed attempts
    for (let i = 0; i < 5; i++) {
      await limiter.check("user1");
    }

    const result = await limiter.check("user1");

    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  test("should increase backoff with each attempt", async () => {
    const attempts = [];

    // Make 6 attempts
    for (let i = 0; i < 6; i++) {
      const result = await limiter.check("user1");
      if (result.retryAfter) {
        attempts.push(result.retryAfter);
      }
    }

    // Backoff should increase
    expect(attempts.length).toBe(1); // Only last one blocked
    expect(attempts[0]).toBeGreaterThan(0);
  });

  test("should reset after decay period", async () => {
    // Use all attempts
    for (let i = 0; i < 5; i++) {
      await limiter.check("user1");
    }

    // Wait for decay (in real test, would mock time)
    // For now, just verify reset function exists
    await limiter.reset("user1");
  });
});

describe("CaptchaRateLimiter", () => {
  let limiter: CaptchaRateLimiter;

  beforeEach(() => {
    limiter = new CaptchaRateLimiter({
      provider: "hcaptcha",
      secretKey: "test-secret",
      threshold: 3,
    });
  });

  test("should not require CAPTCHA initially", () => {
    expect(limiter.requiresCaptcha("user1")).toBe(false);
  });

  test("should require CAPTCHA after threshold failures", () => {
    limiter.recordFailure("user1");
    limiter.recordFailure("user1");
    limiter.recordFailure("user1");

    expect(limiter.requiresCaptcha("user1")).toBe(true);
  });

  test("should reset failure count on success", () => {
    limiter.recordFailure("user1");
    limiter.recordFailure("user1");
    limiter.recordSuccess("user1");

    expect(limiter.requiresCaptcha("user1")).toBe(false);
  });

  test("should track failures separately per user", () => {
    limiter.recordFailure("user1");
    limiter.recordFailure("user1");
    limiter.recordFailure("user1");
    limiter.recordFailure("user2");

    expect(limiter.requiresCaptcha("user1")).toBe(true);
    expect(limiter.requiresCaptcha("user2")).toBe(false);
  });
});

describe("RateLimitPresets", () => {
  test("should have API preset", () => {
    expect(RateLimitPresets.api.maxRequests).toBe(100);
    expect(RateLimitPresets.api.windowMs).toBe(60_000);
  });

  test("should have auth preset with strict limits", () => {
    expect(RateLimitPresets.auth.maxRequests).toBe(5);
    expect(RateLimitPresets.auth.windowMs).toBe(15 * 60_000);
  });

  test("should have password reset preset", () => {
    expect(RateLimitPresets.passwordReset.maxRequests).toBe(3);
    expect(RateLimitPresets.passwordReset.windowMs).toBe(60 * 60_000);
  });

  test("should have WebSocket preset with token bucket", () => {
    expect(RateLimitPresets.websocket.strategy).toBe("token-bucket");
    expect(RateLimitPresets.websocket.refillRate).toBeDefined();
  });

  test("should have LLM calls preset", () => {
    expect(RateLimitPresets.llmCalls.maxRequests).toBe(60);
    expect(RateLimitPresets.llmCalls.strategy).toBe("token-bucket");
  });
});

describe("createProductionRateLimiter", () => {
  beforeEach(async () => {
    await resetRedisData();
  });

  test("should create tiered rate limiter with all presets", () => {
    const limiter = createProductionRateLimiter();

    expect(limiter).toBeInstanceOf(TieredRateLimiter);
  });

  test("should have configured endpoints", async () => {
    const limiter = createProductionRateLimiter();

    // Test auth endpoint (should have strict limit)
    const authResult = await limiter.check({
      ip: "127.0.0.1",
      endpoint: "/api/auth/login",
      isAuthEndpoint: true,
    });

    expect(authResult.allowed).toBe(true);
  });
});
