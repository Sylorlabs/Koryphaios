/**
 * Rate Limiting Middleware
 * 
 * Express middleware for applying multi-layer rate limiting.
 * 
 * Features:
 * - Integrates with API key authentication
 * - Applies tier-based limits
 * - Endpoint-specific limits
 * - Custom headers in responses
 * - Optional Redis for distributed rate limiting
 */

import type { Request, Response, NextFunction } from 'express';
import { getRedisClient } from '../redis/client';
import { SlidingWindowRateLimiter } from './sliding-window';
import { TokenBucketRateLimiter } from './token-bucket';
import { getTierConfig, getEndpointConfig } from './tiers';
import type { RateLimitConfig } from './types';
import { serverLog } from '../logger';

export interface RateLimitMiddlewareOptions {
  /**
   * Algorithm to use
   */
  algorithm?: 'sliding-window' | 'token-bucket';
  
  /**
   * Custom rate limit config (overrides tier-based)
   */
  config?: RateLimitConfig;
  
  /**
   * Whether to skip rate limiting for authenticated users
   */
  skipAuthenticated?: boolean;
  
  /**
   * Custom key generator
   */
  keyGenerator?: (req: Request) => string;
  
  /**
   * Custom handler when rate limited
   */
  handler?: (req: Request, res: Response, next: NextFunction, retryAfter: number) => void;
  
  /**
   * Redis key prefix
   */
  prefix?: string;
}

// Default rate limit config
const DEFAULT_CONFIG: RateLimitConfig = {
  windowSeconds: 60,
  maxRequests: 100,
  algorithm: 'sliding-window',
};

// In-memory rate limiters for when Redis is not available
const memoryLimiters = new Map<string, Map<string, { count: number; resetTime: number }>>();

function getMemoryLimiter(key: string): Map<string, { count: number; resetTime: number }> {
  if (!memoryLimiters.has(key)) {
    memoryLimiters.set(key, new Map());
  }
  return memoryLimiters.get(key)!;
}

/**
 * Create rate limiting middleware
 */
export function rateLimit(options: RateLimitMiddlewareOptions = {}) {
  const prefix = options.prefix || 'ratelimit';
  const algorithm = options.algorithm || 'sliding-window';
  
  // Try to get Redis client
  let redis: any;
  let useRedis = false;
  try {
    redis = getRedisClient();
    useRedis = true;
  } catch {
    serverLog.warn('Redis not available, using in-memory rate limiting');
    useRedis = false;
  }
  
  // Create limiters if using Redis
  let slidingLimiter: SlidingWindowRateLimiter | null = null;
  let bucketLimiter: TokenBucketRateLimiter | null = null;
  
  if (useRedis) {
    slidingLimiter = new SlidingWindowRateLimiter(redis, {
      windowSeconds: 60,
      maxRequests: 100,
      algorithm: 'sliding-window',
    });
    
    bucketLimiter = new TokenBucketRateLimiter(redis, {
      windowSeconds: 60,
      maxRequests: 100,
      algorithm: 'token-bucket',
      burstSize: 20,
    });
    
    // Initialize limiters
    slidingLimiter.initialize().catch(() => {});
    bucketLimiter.initialize().catch(() => {});
  }
  
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Check if we should skip
      if (options.skipAuthenticated && req.authenticatedUser) {
        return next();
      }
      
      // Generate rate limit key
      let key: string;
      if (options.keyGenerator) {
        key = options.keyGenerator(req);
      } else if (req.authenticatedUser) {
        key = req.authenticatedUser.id;
      } else {
        key = req.ip || req.connection.remoteAddress || 'unknown';
      }
      
      // Determine rate limit config
      let config: RateLimitConfig;
      if (options.config) {
        config = options.config;
      } else if (req.authenticatedUser) {
        // Use tier-based limits
        const tier = getTierConfig(req.authenticatedUser.rateLimitTier);
        config = tier.limits.user || DEFAULT_CONFIG;
      } else {
        // Anonymous limits
        config = {
          windowSeconds: 60,
          maxRequests: 30, // Lower for anonymous
          algorithm: algorithm,
        };
      }
      
      // Check rate limit
      let result;
      if (useRedis && slidingLimiter && bucketLimiter) {
        // Use Redis-backed limiters
        if (algorithm === 'sliding-window') {
          result = await slidingLimiter.check(`${prefix}:${key}`);
        } else {
          result = await bucketLimiter.consume(`${prefix}:${key}`);
        }
      } else {
        // Use in-memory fallback
        result = await checkMemoryLimit(`${prefix}:${key}`, config, algorithm);
      }
      
      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit', String(result.limit));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, result.remaining)));
      res.setHeader('X-RateLimit-Reset', String(result.resetTime));
      
      // Check if allowed
      if (!result.allowed) {
        const retryAfter = result.retryAfter || Math.ceil((result.resetTime * 1000 - Date.now()) / 1000);
        
        res.setHeader('Retry-After', String(retryAfter));
        
        if (options.handler) {
          options.handler(req, res, next, retryAfter);
        } else {
          res.status(429).json({
            error: 'Too Many Requests',
            message: 'Rate limit exceeded. Please try again later.',
            retryAfter,
          });
        }
        
        serverLog.warn({ key, path: req.path }, 'Rate limit exceeded');
        return;
      }
      
      next();
    } catch (error) {
      serverLog.error({ error }, 'Rate limiting error');
      // Fail open - allow request
      next();
    }
  };
}

/**
 * In-memory rate limit check
 */
async function checkMemoryLimit(
  key: string,
  config: RateLimitConfig,
  algorithm: string
): Promise<{
  allowed: boolean;
  remaining: number;
  resetTime: number;
  limit: number;
  retryAfter?: number;
}> {
  const now = Date.now();
  const windowMs = config.windowSeconds * 1000;
  const limiters = getMemoryLimiter(algorithm);
  
  if (algorithm === 'token-bucket') {
    // Token bucket in memory
    const bucketSize = config.burstSize || config.maxRequests;
    const refillRate = config.maxRequests / config.windowSeconds; // tokens per second
    
    let bucket = limiters.get(key);
    if (!bucket) {
      bucket = { count: bucketSize, resetTime: now };
      limiters.set(key, bucket);
    }
    
    // Calculate refill
    const elapsed = (now - bucket.resetTime) / 1000;
    const refill = elapsed * refillRate;
    bucket.count = Math.min(bucketSize, bucket.count + refill);
    bucket.resetTime = now;
    
    // Try to consume
    if (bucket.count >= 1) {
      bucket.count -= 1;
      const tokensNeeded = bucketSize - bucket.count;
      const resetTime = Math.ceil(now / 1000) + Math.ceil(tokensNeeded / refillRate);
      
      return {
        allowed: true,
        remaining: Math.floor(bucket.count),
        resetTime,
        limit: bucketSize,
      };
    } else {
      const retryAfter = Math.ceil(1 / refillRate);
      const resetTime = Math.ceil(now / 1000) + retryAfter;
      
      return {
        allowed: false,
        remaining: 0,
        resetTime,
        limit: bucketSize,
        retryAfter,
      };
    }
  } else {
    // Sliding window in memory
    const limiter = getMemoryLimiter('sliding-window');
    let entry = limiter.get(key);
    
    if (!entry || entry.resetTime < now) {
      entry = { count: 0, resetTime: now + windowMs };
      limiter.set(key, entry);
    }
    
    if (entry.count < config.maxRequests) {
      entry.count += 1;
      return {
        allowed: true,
        remaining: config.maxRequests - entry.count,
        resetTime: Math.ceil(entry.resetTime / 1000),
        limit: config.maxRequests,
      };
    } else {
      const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
      return {
        allowed: false,
        remaining: 0,
        resetTime: Math.ceil(entry.resetTime / 1000),
        limit: config.maxRequests,
        retryAfter,
      };
    }
  }
}

/**
 * Endpoint-specific rate limiting
 */
export function endpointRateLimit(
  endpoint: string,
  options: Omit<RateLimitMiddlewareOptions, 'config'> = {}
) {
  const config = getEndpointConfig(endpoint);
  if (!config) {
    serverLog.warn({ endpoint }, 'No rate limit config for endpoint, using defaults');
  }
  
  return rateLimit({
    ...options,
    config: config || DEFAULT_CONFIG,
    prefix: `ratelimit:${endpoint.replace(/\//g, ':')}`,
  });
}

/**
 * Multi-layer rate limiting middleware
 * Combines global, tier-based, and endpoint-specific limits
 */
export function multiLayerRateLimit(
  endpoint?: string,
  options: RateLimitMiddlewareOptions = {}
) {
  const globalMiddleware = rateLimit({
    prefix: 'ratelimit:global',
    config: {
      windowSeconds: 60,
      maxRequests: 1000, // Global limit
      algorithm: 'sliding-window',
    },
  });
  
  const tierMiddleware = rateLimit({
    ...options,
    prefix: 'ratelimit:tier',
  });
  
  const endpointMiddleware = endpoint ? endpointRateLimit(endpoint, options) : (req: Request, res: Response, next: NextFunction) => next();
  
  return (req: Request, res: Response, next: NextFunction): void => {
    globalMiddleware(req, res, (err?: any) => {
      if (err) return next(err);
      
      tierMiddleware(req, res, (err2?: any) => {
        if (err2) return next(err2);
        
        endpointMiddleware(req, res, next);
      });
    });
  };
}
