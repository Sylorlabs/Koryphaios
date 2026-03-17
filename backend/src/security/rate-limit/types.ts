// Rate Limiting Types and Interfaces
// Production-ready distributed rate limiting with Redis, multiple strategies, and CAPTCHA integration

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

export interface RateLimitMiddlewareOptions {
  tieredConfig: TieredRateLimitConfig;
  onRateLimited?: (request: Request, result: RateLimitResult) => Response;
  trustProxy?: boolean;
  ipHeader?: string;
}

export interface CaptchaConfig {
  provider: "hcaptcha" | "recaptcha" | "turnstile";
  secretKey: string;
  minScore?: number; // For reCAPTCHA v3
  threshold?: number; // Number of failures before triggering CAPTCHA
}

export interface ExpressRateLimitOptions {
  algorithm?: RateLimitStrategy;
  config?: RateLimitConfig;
  skipAuthenticated?: boolean;
  keyGenerator?: (req: any) => string;
  handler?: (req: any, res: any, next: any, retryAfter: number) => void;
  prefix?: string;
}
