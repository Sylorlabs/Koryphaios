// Progressive Backoff Rate Limiter
// Increases wait time after each failed attempt

import { getRedisClient } from "../../redis";
import { serverLog } from "../../logger";

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
