// Rate Limiting Utilities and Helper Functions

import { serverLog } from "../../logger";

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
// TOKEN EXTRACTION
// ============================================================================

/**
 * Extract user ID from JWT token (simplified)
 * In production, use proper JWT verification
 */
export function extractUserIdFromToken(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      return payload.sub;
    }
  } catch (err) {
    serverLog.debug({ error: err instanceof Error ? err.message : String(err) }, "Invalid JWT token");
  }
  return undefined;
}

// ============================================================================
// TIER CONFIGURATION FACTORY
// ============================================================================

import type { RateLimitTier, RateLimitConfig } from "./types";

export function createTierConfig(
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

// ============================================================================
// IN-MEMORY LIMITER HELPERS (for Express middleware)
// ============================================================================

const memoryLimiters = new Map<string, Map<string, { count: number; resetTime: number }>>();

export function getMemoryLimiter(key: string): Map<string, { count: number; resetTime: number }> {
  if (!memoryLimiters.has(key)) {
    memoryLimiters.set(key, new Map());
  }
  return memoryLimiters.get(key)!;
}

import type { RateLimitStrategy, RateLimitResult } from "./types";

export async function checkMemoryLimit(
  key: string,
  config: { maxRequests: number; windowMs: number },
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
