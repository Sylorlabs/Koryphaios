// Tiered Rate Limiter
// Multi-layer rate limiting with global, IP, user, and endpoint tiers

import type { TieredRateLimitConfig, RateLimitConfig, RateLimitResult } from "./types";
import { SlidingWindowRateLimiter } from "./SlidingWindowRateLimiter";
import { TokenBucketRateLimiter } from "./TokenBucketRateLimiter";
import { FixedWindowRateLimiter } from "./FixedWindowRateLimiter";

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
