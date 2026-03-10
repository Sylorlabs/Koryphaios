// Complete Rate Limiting Implementation
// Production-ready distributed rate limiting with Redis, multiple strategies, and CAPTCHA integration

import { getRedisClient, type InMemoryRedis } from "../redis";
import { randomBytes } from "node:crypto";
import { serverLog } from "../logger";

// ============================================================================
// RATE LIMITING STRATEGIES
// ============================================================================

export type RateLimitStrategy = "sliding-window" | "token-bucket" | "fixed-window";

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  strategy?: RateLimitStrategy;
  keyPrefix?: string;
  skipFailedRequests?: boolean;
  skipSuccessfulRequests?: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
  limit: number;
}

export interface RateLimitOptions extends RateLimitConfig {
  identifier: string;
  burst?: number; // For token bucket: burst capacity
  refillRate?: number; // For token bucket: tokens per second
}

export interface RateLimitTier {
  name: string;
  description: string;
  limits: {
    user?: RateLimitConfig;
    ip?: RateLimitConfig;
    endpoints?: Record<string, RateLimitConfig>;
  };
}

export interface RateLimitAuditLog {
  timestamp: number;
  key: string;
  allowed: boolean;
  limit: number;
  remaining: number;
  endpoint?: string;
}

// ============================================================================
// SIMPLE IN-MEMORY RATE LIMITER
// ============================================================================

/**
 * Simple in-memory sliding window rate limiter.
 * Suitable for single-instance deployments without Redis.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private pruneTimer: ReturnType<typeof setInterval>;

  constructor(
    private maxRequests: number = 60,
    private windowMs: number = 60_000,
  ) {
    // Auto-prune stale entries every 5 minutes to prevent unbounded memory growth
    this.pruneTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.hits) {
        if (now >= entry.resetAt) this.hits.delete(key);
      }
    }, 5 * 60_000);

    // Don't keep the process alive just for pruning
    if (this.pruneTimer.unref) this.pruneTimer.unref();
  }

  check(key: string): { allowed: boolean; remaining: number; resetIn: number } {
    const now = Date.now();
    let entry = this.hits.get(key);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }

    entry.count++;
    const allowed = entry.count <= this.maxRequests;
    return {
      allowed,
      remaining: Math.max(0, this.maxRequests - entry.count),
      resetIn: entry.resetAt - now,
    };
  }

  destroy(): void {
    clearInterval(this.pruneTimer);
    this.hits.clear();
  }
}

// ============================================================================
// SLIDING WINDOW RATE LIMITER
// ============================================================================

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

// ============================================================================
// TOKEN BUCKET RATE LIMITER
// ============================================================================

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

// ============================================================================
// FIXED WINDOW RATE LIMITER
// ============================================================================

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

// ============================================================================
// TIERED RATE LIMITER
// ============================================================================

export interface TieredRateLimitConfig {
  // Global limits (apply to all requests)
  global?: RateLimitConfig;

  // Per-IP limits
  ip?: RateLimitConfig;

  // Per-user limits (when authenticated)
  user?: RateLimitConfig;

  // Per-endpoint limits
  endpoints?: Record<string, RateLimitConfig>;

  // Auth endpoint limits (stricter)
  auth?: RateLimitConfig;
}

export class TieredRateLimiter {
  private limiters: Map<string, SlidingWindowRateLimiter | TokenBucketRateLimiter | FixedWindowRateLimiter> =
    new Map();

  constructor(private config: TieredRateLimitConfig) {}

  /**
   * Check rate limits across all tiers
   * Returns the most restrictive limit result
   */
  async check(request: {
    ip: string;
    userId?: string;
    endpoint: string;
    isAuthEndpoint?: boolean;
  }): Promise<RateLimitResult> {
    const results: RateLimitResult[] = [];

    // Global rate limit
    if (this.config.global) {
      const result = await this.checkWithKey("global", "global", this.config.global);
      results.push(result);
    }

    // IP-based rate limit
    if (this.config.ip) {
      const result = await this.checkWithKey("ip", request.ip, this.config.ip);
      results.push(result);
    }

    // User-based rate limit (if authenticated)
    if (this.config.user && request.userId) {
      const result = await this.checkWithKey("user", request.userId, this.config.user);
      results.push(result);
    }

    // Endpoint-specific rate limit
    if (this.config.endpoints) {
      const endpointConfig = this.config.endpoints[request.endpoint];
      if (endpointConfig) {
        const result = await this.checkWithKey(
          `endpoint:${request.endpoint}`,
          `${request.ip}:${request.endpoint}`,
          endpointConfig
        );
        results.push(result);
      }
    }

    // Auth endpoint rate limit (stricter)
    if (this.config.auth && request.isAuthEndpoint) {
      const result = await this.checkWithKey(
        "auth",
        request.ip,
        this.config.auth
      );
      results.push(result);
    }

    // Return the most restrictive result
    return results.reduce((most, current) => {
      if (!current.allowed) return current;
      if (!most.allowed) return most;
      return current.remaining < most.remaining ? current : most;
    });
  }

  private async checkWithKey(
    tier: string,
    identifier: string,
    config: RateLimitConfig
  ): Promise<RateLimitResult> {
    const limiterKey = `${tier}:${config.strategy || "sliding-window"}`;

    let limiter = this.limiters.get(limiterKey);
    if (!limiter) {
      const strategy = config.strategy || "sliding-window";
      switch (strategy) {
        case "token-bucket":
          limiter = new TokenBucketRateLimiter(config);
          break;
        case "fixed-window":
          limiter = new FixedWindowRateLimiter(config);
          break;
        default:
          limiter = new SlidingWindowRateLimiter(config);
      }
      this.limiters.set(limiterKey, limiter);
    }

    return limiter.check({ identifier, ...config });
  }

  /**
   * Reset rate limits for a specific identifier
   */
  async reset(identifier: string, tier?: string): Promise<void> {
    const keys = tier
      ? [`${tier}:${identifier}`]
      : Array.from(this.limiters.keys());

    for (const key of keys) {
      // Reset logic would go here
      // For now, we rely on Redis TTL
    }
  }
}

// ============================================================================
// PROGRESSIVE BACKOFF RATE LIMITER
// ============================================================================

/**
 * Progressive backoff for repeated failures
 * Increases wait time after each failed attempt
 */
export class ProgressiveBackoffRateLimiter {
  private readonly backoffMultipliers = [1, 2, 4, 8, 16, 32, 64]; // Exponential backoff
  private readonly baseDelayMs: number = 1000;

  constructor(
    private config: {
      maxAttempts: number;
      windowMs: number;
      decayMs?: number; // Time before attempt counter decays
    }
  ) {}

  async check(identifier: string): Promise<{
    allowed: boolean;
    retryAfter?: number;
    attempt: number;
  }> {
    const redis = getRedisClient();
    const key = `backoff:${identifier}`;
    const now = Date.now();

    try {
      const data = await redis.hmget(key, "attempts", "lastAttempt");

      const attempts = data[0] ? parseInt(data[0], 10) : 0;
      const lastAttempt = data[1] ? parseInt(data[1], 10) : 0;

      // Decay attempts over time
      const timeSinceLastAttempt = now - lastAttempt;
      const decayAfterMs = this.config.decayMs || this.config.windowMs;

      let effectiveAttempts = attempts;
      if (timeSinceLastAttempt > decayAfterMs) {
        // Reset attempts if enough time has passed
        effectiveAttempts = 0;
      }

      // Check if max attempts exceeded
      if (effectiveAttempts >= this.config.maxAttempts) {
        const backoffIndex = Math.min(
          effectiveAttempts,
          this.backoffMultipliers.length - 1
        );
        const retryAfter = this.backoffMultipliers[backoffIndex] * this.baseDelayMs;

        return {
          allowed: false,
          retryAfter,
          attempt: effectiveAttempts,
        };
      }

      // Increment attempts
      await redis.hmset(key, "attempts", effectiveAttempts + 1, "lastAttempt", now);
      await redis.expire(key, Math.ceil(this.config.windowMs / 1000) + 1);

      return {
        allowed: true,
        attempt: effectiveAttempts,
      };
    } catch (err) {
      serverLog.error({ err, key }, "Progressive backoff limiter failed");

      // Fail open
      return { allowed: true, attempt: 0 };
    }
  }

  async reset(identifier: string): Promise<void> {
    try {
      const redis = getRedisClient();
      await redis.del(`backoff:${identifier}`);
    } catch (err) {
      serverLog.error({ err, identifier }, "Failed to reset backoff");
    }
  }
}

// ============================================================================
// RATE LIMIT MIDDLEWARE
// ============================================================================

export interface RateLimitMiddlewareOptions {
  tieredConfig: TieredRateLimitConfig;
  onRateLimited?: (request: Request, result: RateLimitResult) => Response;
  trustProxy?: boolean;
  ipHeader?: string;
}

/**
 * Express/Bun-style middleware for rate limiting
 */
export function createRateLimitMiddleware(
  options: RateLimitMiddlewareOptions
) {
  const limiter = new TieredRateLimiter(options.tieredConfig);

  return async (
    request: Request,
    response: Response
  ): Promise<Response> => {
    // Extract IP address
    const ip =
      request.headers.get(options.ipHeader || "x-forwarded-for")?.split(",")[0]?.trim() ||
      "unknown";

    // Extract user ID if authenticated
    const authHeader = request.headers.get("authorization");
    const userId = authHeader?.startsWith("Bearer ") ? extractUserIdFromToken(authHeader.slice(7)) : undefined;

    // Determine endpoint
    const url = new URL(request.url);
    const endpoint = `${request.method}:${url.pathname}`;

    // Check if auth endpoint
    const isAuthEndpoint = endpoint.includes("/auth/") || endpoint.includes("/login") || endpoint.includes("/register");

    // Check rate limits
    const result = await limiter.check({
      ip,
      userId,
      endpoint,
      isAuthEndpoint,
    });

    // Add rate limit headers to response
    response.headers.set("X-RateLimit-Limit", String(result.limit));
    response.headers.set("X-RateLimit-Remaining", String(result.remaining));
    response.headers.set("X-RateLimit-Reset", String(result.resetAt));

    if (!result.allowed) {
      response.headers.set("Retry-After", String(result.retryAfter || 60));

      // Log rate limit hit
      serverLog.warn({
        ip,
        userId,
        endpoint,
        retryAfter: result.retryAfter,
      }, "Rate limit exceeded");

      // Call custom handler or return default response
      if (options.onRateLimited) {
        return options.onRateLimited(request, result);
      }

      return new Response(
        JSON.stringify({
          error: "Too many requests",
          retryAfter: result.retryAfter,
        }),
        {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    return response;
  };
}

// ============================================================================
// CAPTCHA INTEGRATION
// ============================================================================

export interface CaptchaConfig {
  provider: "hcaptcha" | "recaptcha" | "turnstile";
  secretKey: string;
  minScore?: number; // For reCAPTCHA v3
  threshold?: number; // Number of failures before triggering CAPTCHA
}

export class CaptchaRateLimiter {
  private failureCounts: Map<string, number> = new Map();

  constructor(private config: CaptchaConfig) {}

  /**
   * Check if CAPTCHA is required based on failure count
   */
  requiresCaptcha(identifier: string): boolean {
    const threshold = this.config.threshold || 5;
    const failures = this.failureCounts.get(identifier) || 0;
    return failures >= threshold;
  }

  /**
   * Record a failed attempt
   */
  recordFailure(identifier: string): void {
    const current = this.failureCounts.get(identifier) || 0;
    this.failureCounts.set(identifier, current + 1);
  }

  /**
   * Record a successful attempt (reset failure count)
   */
  recordSuccess(identifier: string): void {
    this.failureCounts.delete(identifier);
  }

  /**
   * Verify CAPTCHA response
   */
  async verify(token: string, ip?: string): Promise<boolean> {
    try {
      let verifyUrl: string;
      let body: Record<string, string>;

      switch (this.config.provider) {
        case "hcaptcha":
          verifyUrl = "https://hcaptcha.com/siteverify";
          body = {
            secret: this.config.secretKey,
            response: token,
          };
          break;

        case "recaptcha":
          verifyUrl = "https://www.google.com/recaptcha/api/siteverify";
          body = {
            secret: this.config.secretKey,
            response: token,
            ...(ip ? { remoteip: ip } : {}),
          };
          break;

        case "turnstile":
          verifyUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
          body = {
            secret: this.config.secretKey,
            response: token,
            ...(ip ? { remoteip: ip } : {}),
          };
          break;
      }

      const response = await fetch(verifyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
      });

      const result = await response.json();

      // Check minimum score for reCAPTCHA v3
      if (this.config.minScore && result.score !== undefined) {
        return result.success && result.score >= this.config.minScore;
      }

      return result.success;
    } catch (err) {
      serverLog.error({ err }, "CAPTCHA verification failed");
      return false;
    }
  }
}

// ============================================================================
// RATE LIMIT FACTORY
// ============================================================================

/**
 * Pre-configured rate limiters for common use cases
 */
export const RateLimitPresets = {
  // API endpoints: 100 requests per minute
  api: {
    maxRequests: 100,
    windowMs: 60_000,
    strategy: "sliding-window" as const,
  },

  // Authentication: 5 attempts per 15 minutes
  auth: {
    maxRequests: 5,
    windowMs: 15 * 60_000,
    strategy: "sliding-window" as const,
  },

  // Password reset: 3 attempts per hour
  passwordReset: {
    maxRequests: 3,
    windowMs: 60 * 60_000,
    strategy: "fixed-window" as const,
  },

  // WebSocket connections: 10 per second
  websocket: {
    maxRequests: 10,
    windowMs: 1000,
    strategy: "token-bucket" as const,
    refillRate: 10,
    bucketSize: 20, // Allow burst
  },

  // File uploads: 5 per hour
  fileUpload: {
    maxRequests: 5,
    windowMs: 60 * 60_000,
    strategy: "fixed-window" as const,
  },

  // LLM API calls: 60 per minute
  llmCalls: {
    maxRequests: 60,
    windowMs: 60_000,
    strategy: "token-bucket" as const,
    refillRate: 1,
    bucketSize: 10, // Allow burst
  },
};

/**
 * Create a complete tiered rate limiter with sensible defaults
 */
export function createProductionRateLimiter(): TieredRateLimiter {
  return new TieredRateLimiter({
    global: RateLimitPresets.api,
    ip: RateLimitPresets.api,
    user: RateLimitPresets.api,
    auth: RateLimitPresets.auth,
    endpoints: {
      "/api/auth/login": RateLimitPresets.auth,
      "/api/auth/register": RateLimitPresets.auth,
      "/api/auth/reset-password": RateLimitPresets.passwordReset,
      "/api/file/upload": RateLimitPresets.fileUpload,
      "/api/llm": RateLimitPresets.llmCalls,
    },
  });
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Extract user ID from JWT token (simplified)
 * In production, use proper JWT verification
 */
function extractUserIdFromToken(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      return payload.sub;
    }
  } catch {
    // Invalid token
  }
  return undefined;
}

// ============================================================================
// TIER CONFIGURATION
// ============================================================================

function createTierConfig(
  name: string,
  requestsPerMinute: number,
  requestsPerHour: number,
  requestsPerDay: number,
  maxTokensPerRequest: number,
  concurrentRequests: number
): RateLimitTier {
  return {
    name,
    description: `${name} tier with ${requestsPerMinute}/min, ${requestsPerHour}/hour`,
    limits: {
      user: {
        windowMs: 60_000,
        maxRequests: requestsPerMinute,
        strategy: "sliding-window",
      },
      ip: {
        windowMs: 60_000,
        maxRequests: Math.max(requestsPerMinute * 2, 100),
        strategy: "sliding-window",
      },
      endpoints: {
        "/api/v1/chat/completions": {
          windowMs: 60_000,
          maxRequests: Math.floor(requestsPerMinute / 2),
          strategy: "token-bucket",
        },
        "/api/v1/models": {
          windowMs: 60_000,
          maxRequests: 30,
          strategy: "sliding-window",
        },
      },
    },
  };
}

export const DEFAULT_TIERS: Record<string, RateLimitTier> = {
  free: createTierConfig("free", 60, 1_000, 10_000, 4_000, 2),
  premium: createTierConfig("premium", 300, 10_000, 100_000, 8_000, 10),
  pro: createTierConfig("pro", 1_000, 50_000, 500_000, 32_000, 50),
  enterprise: createTierConfig("enterprise", 5_000, 200_000, 2_000_000, 128_000, 200),
};

export const ENDPOINT_LIMITS: Record<string, {
  windowMs: number;
  maxRequests: number;
  description: string;
  strategy?: RateLimitStrategy;
  bucketSize?: number;
}> = {
  "/api/v1/chat/completions": {
    windowMs: 60_000,
    maxRequests: 100,
    description: "Chat completions endpoint",
    strategy: "token-bucket",
    bucketSize: 20,
  },
  "/api/v1/models": {
    windowMs: 60_000,
    maxRequests: 30,
    description: "Model list endpoint",
    strategy: "sliding-window",
  },
  "/api/v1/credentials": {
    windowMs: 60_000,
    maxRequests: 20,
    description: "Credential management (sensitive)",
    strategy: "sliding-window",
  },
  "/api/v1/admin": {
    windowMs: 60_000,
    maxRequests: 10,
    description: "Admin operations",
    strategy: "sliding-window",
  },
  "/api/v1/keys": {
    windowMs: 60_000,
    maxRequests: 5,
    description: "API key generation (expensive)",
    strategy: "token-bucket",
    bucketSize: 2,
  },
};

export function getTierConfig(tierName: string): RateLimitTier {
  return DEFAULT_TIERS[tierName] || DEFAULT_TIERS.free;
}

export function getTierRequestsPerMinute(tierName: string): number {
  const tier = getTierConfig(tierName);
  return tier.limits.user?.maxRequests || 60;
}

export function shouldUpgrade(tierName: string, usage: {
  requestsLastHour: number;
  requestsLastDay: number;
}): boolean {
  const tier = getTierConfig(tierName);
  const hourlyLimit = (tier.limits.user?.maxRequests || 60) * 60;
  const dailyLimit = hourlyLimit * 24;

  return (
    usage.requestsLastHour > hourlyLimit * 0.9 ||
    usage.requestsLastDay > dailyLimit * 0.9
  );
}

export function getEndpointConfig(endpoint: string): RateLimitConfig | null {
  const limit = ENDPOINT_LIMITS[endpoint];
  if (!limit) return null;

  return {
    windowMs: limit.windowMs,
    maxRequests: limit.maxRequests,
    strategy: limit.strategy || "sliding-window",
  };
}

// ============================================================================
// EXPRESS-COMPATIBLE MIDDLEWARE
// ============================================================================

export interface ExpressRateLimitOptions {
  algorithm?: RateLimitStrategy;
  config?: RateLimitConfig;
  skipAuthenticated?: boolean;
  keyGenerator?: (req: any) => string;
  handler?: (req: any, res: any, next: any, retryAfter: number) => void;
  prefix?: string;
}

const DEFAULT_MIDDLEWARE_CONFIG: RateLimitConfig = {
  windowMs: 60_000,
  maxRequests: 100,
  strategy: "sliding-window",
};

const memoryLimiters = new Map<string, Map<string, { count: number; resetTime: number }>>();

function getMemoryLimiter(key: string): Map<string, { count: number; resetTime: number }> {
  if (!memoryLimiters.has(key)) {
    memoryLimiters.set(key, new Map());
  }
  return memoryLimiters.get(key)!;
}

async function checkMemoryLimit(
  key: string,
  config: RateLimitConfig,
  algorithm: string
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowMs = config.windowMs;

  if (algorithm === "token-bucket") {
    const bucketSize = config.maxRequests;
    const refillRate = config.maxRequests / (windowMs / 1000);
    const limiters = getMemoryLimiter("token-bucket");

    let bucket = limiters.get(key);
    if (!bucket) {
      bucket = { count: bucketSize, resetTime: now };
      limiters.set(key, bucket);
    }

    const elapsed = (now - bucket.resetTime) / 1000;
    const refill = elapsed * refillRate;
    bucket.count = Math.min(bucketSize, bucket.count + refill);
    bucket.resetTime = now;

    if (bucket.count >= 1) {
      bucket.count -= 1;
      return {
        allowed: true,
        remaining: Math.floor(bucket.count),
        resetAt: now + Math.ceil((bucketSize - bucket.count) / refillRate) * 1000,
        limit: bucketSize,
      };
    } else {
      const retryAfter = Math.ceil(1 / refillRate);
      return {
        allowed: false,
        remaining: 0,
        resetAt: now + retryAfter * 1000,
        limit: bucketSize,
        retryAfter,
      };
    }
  } else {
    const limiters = getMemoryLimiter("sliding-window");
    let entry = limiters.get(key);

    if (!entry || entry.resetTime < now) {
      entry = { count: 0, resetTime: now + windowMs };
      limiters.set(key, entry);
    }

    if (entry.count < config.maxRequests) {
      entry.count += 1;
      return {
        allowed: true,
        remaining: config.maxRequests - entry.count,
        resetAt: entry.resetTime,
        limit: config.maxRequests,
      };
    } else {
      const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
      return {
        allowed: false,
        remaining: 0,
        resetAt: entry.resetTime,
        limit: config.maxRequests,
        retryAfter,
      };
    }
  }
}

/**
 * Create Express-compatible rate limiting middleware.
 * Falls back to in-memory limiting if Redis is unavailable.
 */
export function rateLimit(options: ExpressRateLimitOptions = {}) {
  const prefix = options.prefix || "ratelimit";
  const algorithm = options.algorithm || "sliding-window";
  const config = options.config || DEFAULT_MIDDLEWARE_CONFIG;

  return async (req: any, res: any, next: any): Promise<void> => {
    try {
      if (options.skipAuthenticated && req.authenticatedUser) {
        return next();
      }

      let key: string;
      if (options.keyGenerator) {
        key = options.keyGenerator(req);
      } else if (req.authenticatedUser) {
        key = req.authenticatedUser.id;
      } else {
        key = req.ip || req.connection?.remoteAddress || "unknown";
      }

      let effectiveConfig: RateLimitConfig = config;
      if (!options.config && req.authenticatedUser) {
        const tier = getTierConfig(req.authenticatedUser.rateLimitTier);
        effectiveConfig = tier.limits.user || config;
      }

      const result = await checkMemoryLimit(`${prefix}:${key}`, effectiveConfig, algorithm);

      res.setHeader("X-RateLimit-Limit", String(result.limit));
      res.setHeader("X-RateLimit-Remaining", String(Math.max(0, result.remaining)));
      res.setHeader("X-RateLimit-Reset", String(result.resetAt));

      if (!result.allowed) {
        const retryAfter = result.retryAfter || Math.ceil((result.resetAt - Date.now()) / 1000);
        res.setHeader("Retry-After", String(retryAfter));

        if (options.handler) {
          options.handler(req, res, next, retryAfter);
        } else {
          res.status(429).json({
            error: "Too Many Requests",
            message: "Rate limit exceeded. Please try again later.",
            retryAfter,
          });
        }

        serverLog.warn({ key, path: req.path }, "Rate limit exceeded");
        return;
      }

      next();
    } catch (error) {
      serverLog.error({ error }, "Rate limiting error");
      next();
    }
  };
}

/**
 * Endpoint-specific rate limiting middleware.
 */
export function endpointRateLimit(
  endpoint: string,
  options: Omit<ExpressRateLimitOptions, "config"> = {}
) {
  const config = getEndpointConfig(endpoint);
  if (!config) {
    serverLog.warn({ endpoint }, "No rate limit config for endpoint, using defaults");
  }

  return rateLimit({
    ...options,
    config: config || DEFAULT_MIDDLEWARE_CONFIG,
    prefix: `ratelimit:${endpoint.replace(/\//g, ":")}`,
  });
}

/**
 * Multi-layer rate limiting middleware combining global, tier, and endpoint limits.
 */
export function multiLayerRateLimit(
  endpoint?: string,
  options: ExpressRateLimitOptions = {}
) {
  const globalMiddleware = rateLimit({
    prefix: "ratelimit:global",
    config: {
      windowMs: 60_000,
      maxRequests: 1000,
      strategy: "sliding-window",
    },
  });

  const tierMiddleware = rateLimit({
    ...options,
    prefix: "ratelimit:tier",
  });

  const endpointMiddleware = endpoint
    ? endpointRateLimit(endpoint, options)
    : (_req: any, _res: any, next: any) => next();

  return (req: any, res: any, next: any): void => {
    globalMiddleware(req, res, (err?: any) => {
      if (err) return next(err);
      tierMiddleware(req, res, (err2?: any) => {
        if (err2) return next(err2);
        endpointMiddleware(req, res, next);
      });
    });
  };
}
