// Rate Limiting Module
// Complete rate limiting implementation with multiple strategies
// Re-exports all types and classes for backwards compatibility

// ============================================================================
// TYPES
// ============================================================================

export type {
  RateLimitStrategy,
  RateLimitConfig,
  RateLimitResult,
  RateLimitOptions,
  RateLimitTier,
  RateLimitAuditLog,
  TieredRateLimitConfig,
  RateLimitMiddlewareOptions,
  CaptchaConfig,
  ExpressRateLimitOptions,
} from "./types";

// ============================================================================
// UTILITIES
// ============================================================================

export {
  RateLimiter,
  extractUserIdFromToken,
  createTierConfig,
  getMemoryLimiter,
  checkMemoryLimit,
} from "./utils";

// ============================================================================
// RATE LIMITERS
// ============================================================================

export { SlidingWindowRateLimiter } from "./SlidingWindowRateLimiter";
export { TokenBucketRateLimiter } from "./TokenBucketRateLimiter";
export { FixedWindowRateLimiter } from "./FixedWindowRateLimiter";
export { TieredRateLimiter } from "./TieredRateLimiter";
export { ProgressiveBackoffRateLimiter } from "./ProgressiveBackoffRateLimiter";
export { CaptchaRateLimiter } from "./CaptchaRateLimiter";

// ============================================================================
// REGISTRY (Middleware, Presets, Tiers, Endpoints)
// ============================================================================

export {
  // Presets
  RateLimitPresets,
  
  // Tier configs
  DEFAULT_TIERS,
  
  // Endpoint limits
  ENDPOINT_LIMITS,
  
  // Helpers
  getTierConfig,
  getTierRequestsPerMinute,
  shouldUpgrade,
  getEndpointConfig,
  
  // Factories
  createProductionRateLimiter,
  
  // Middleware
  createRateLimitMiddleware,
  rateLimit,
  endpointRateLimit,
  multiLayerRateLimit,
} from "./RateLimitRegistry";
