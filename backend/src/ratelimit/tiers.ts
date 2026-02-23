/**
 * Rate Limit Tiers
 * 
 * Predefined rate limiting configurations for different user tiers.
 * Model hub usage: free users get lower limits, premium/pro get higher.
 */

import type { RateLimitTier, RateLimitConfig } from './types';

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
        windowSeconds: 60,
        maxRequests: requestsPerMinute,
        algorithm: 'sliding-window',
      },
      ip: {
        windowSeconds: 60,
        maxRequests: Math.max(requestsPerMinute * 2, 100),
        algorithm: 'sliding-window',
      },
      endpoints: {
        '/api/v1/chat/completions': {
          windowSeconds: 60,
          maxRequests: Math.floor(requestsPerMinute / 2),
          algorithm: 'token-bucket',
          burstSize: Math.floor(requestsPerMinute / 4),
        },
        '/api/v1/models': {
          windowSeconds: 60,
          maxRequests: 30,
          algorithm: 'sliding-window',
        },
      },
    },
  };
}

export const DEFAULT_TIERS: Record<string, RateLimitTier> = {
  free: createTierConfig(
    'free',
    60,      // requests per minute
    1_000,   // requests per hour
    10_000,  // requests per day
    4_000,   // max tokens
    2        // concurrent
  ),
  
  premium: createTierConfig(
    'premium',
    300,     // requests per minute
    10_000,  // requests per hour
    100_000, // requests per day
    8_000,   // max tokens
    10       // concurrent
  ),
  
  pro: createTierConfig(
    'pro',
    1_000,   // requests per minute
    50_000,  // requests per hour
    500_000, // requests per day
    32_000,  // max tokens
    50       // concurrent
  ),
  
  enterprise: createTierConfig(
    'enterprise',
    5_000,     // requests per minute
    200_000,   // requests per hour
    2_000_000, // requests per day
    128_000,   // max tokens
    200        // concurrent
  ),
};

// Endpoint-specific limits for expensive operations
export const ENDPOINT_LIMITS: Record<string, {
  windowSeconds: number;
  maxRequests: number;
  description: string;
  algorithm?: 'sliding-window' | 'token-bucket';
  burstSize?: number;
}> = {
  '/api/v1/chat/completions': {
    windowSeconds: 60,
    maxRequests: 100,
    description: 'Chat completions endpoint',
    algorithm: 'token-bucket',
    burstSize: 20,
  },
  
  '/api/v1/models': {
    windowSeconds: 60,
    maxRequests: 30,
    description: 'Model list endpoint',
    algorithm: 'sliding-window',
  },
  
  '/api/v1/credentials': {
    windowSeconds: 60,
    maxRequests: 20,
    description: 'Credential management (sensitive)',
    algorithm: 'sliding-window',
  },
  
  '/api/v1/admin': {
    windowSeconds: 60,
    maxRequests: 10,
    description: 'Admin operations',
    algorithm: 'sliding-window',
  },
  
  '/api/v1/keys': {
    windowSeconds: 60,
    maxRequests: 5,
    description: 'API key generation (expensive)',
    algorithm: 'token-bucket',
    burstSize: 2,
  },
};

// Get tier configuration
export function getTierConfig(tierName: string): RateLimitTier {
  return DEFAULT_TIERS[tierName] || DEFAULT_TIERS.free;
}

// Get the per-minute limit for a tier
export function getTierRequestsPerMinute(tierName: string): number {
  const tier = getTierConfig(tierName);
  return tier.limits.user?.maxRequests || 60;
}

// Check if upgrade is needed
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

// Convert endpoint limits to RateLimitConfig
export function getEndpointConfig(endpoint: string): RateLimitConfig | null {
  const limit = ENDPOINT_LIMITS[endpoint];
  if (!limit) return null;
  
  return {
    windowSeconds: limit.windowSeconds,
    maxRequests: limit.maxRequests,
    algorithm: limit.algorithm || 'sliding-window',
    burstSize: limit.burstSize,
  };
}
