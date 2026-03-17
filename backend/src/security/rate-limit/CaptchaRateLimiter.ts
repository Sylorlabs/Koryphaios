// CAPTCHA Integration for Rate Limiting
// Supports hCaptcha, reCAPTCHA, and Turnstile

import { serverLog } from "../../logger";
import type { CaptchaConfig } from "./types";

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
