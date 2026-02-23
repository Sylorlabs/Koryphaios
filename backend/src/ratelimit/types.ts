// Rate limiting types

export interface RateLimitConfig {
  /** Max requests allowed in window */
  maxRequests: number;
  /** Time window in seconds */
  windowSeconds: number;
  /** Algorithm to use */
  algorithm: 'sliding-window' | 'token-bucket';
  /** Burst allowance (for token bucket) */
  burstSize?: number;
}

export interface RateLimitResult {
  /** Whether request is allowed */
  allowed: boolean;
  /** Remaining requests in current window */
  remaining: number;
  /** Unix timestamp when limit resets */
  resetTime: number;
  /** Total limit for this window */
  limit: number;
  /** Retry after seconds (if blocked) */
  retryAfter?: number;
}

export interface RateLimitTier {
  name: string;
  description: string;
  limits: {
    /** Per-user limit */
    user?: RateLimitConfig;
    /** Per-IP limit */
    ip?: RateLimitConfig;
    /** Per-endpoint limits */
    endpoints?: Record<string, RateLimitConfig>;
  };
}

export interface RateLimitAuditLog {
  timestamp: number;
  key: string;  // user:123 or ip:1.2.3.4
  allowed: boolean;
  limit: number;
  remaining: number;
  endpoint?: string;
}
