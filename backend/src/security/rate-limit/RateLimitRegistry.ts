// Rate Limit Registry
// Middleware, presets, tier configs, and endpoint limits

import { serverLog } from "../../logger";
import type {
  RateLimitConfig,
  RateLimitStrategy,
  RateLimitResult,
  RateLimitTier,
  TieredRateLimitConfig,
  RateLimitMiddlewareOptions,
  ExpressRateLimitOptions,
} from "./types";
import { TieredRateLimiter } from "./TieredRateLimiter";
import { checkMemoryLimit, extractUserIdFromToken, createTierConfig } from "./utils";

// ============================================================================
// RATE LIMIT PRESETS
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

// ============================================================================
// DEFAULT TIER CONFIGURATIONS
// ============================================================================

export const DEFAULT_TIERS: Record<string, RateLimitTier> = {
  free: createTierConfig("free", 60, 1_000, 10_000, 4_000, 2),
  premium: createTierConfig("premium", 300, 10_000, 100_000, 8_000, 10),
  pro: createTierConfig("pro", 1_000, 50_000, 500_000, 32_000, 50),
  enterprise: createTierConfig("enterprise", 5_000, 200_000, 2_000_000, 128_000, 200),
};

// ============================================================================
// ENDPOINT LIMITS
// ============================================================================

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

// ============================================================================
// TIER AND ENDPOINT HELPERS
// ============================================================================

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
// PRODUCTION RATE LIMITER FACTORY
// ============================================================================

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
// EXPRESS/BUN MIDDLEWARE
// ============================================================================

const DEFAULT_MIDDLEWARE_CONFIG: RateLimitConfig = {
  windowMs: 60_000,
  maxRequests: 100,
  strategy: "sliding-window",
};

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
// EXPRESS-COMPATIBLE MIDDLEWARE
// ============================================================================

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
