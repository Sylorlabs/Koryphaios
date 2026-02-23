/**
 * Multi-Layer Rate Limiter
 * 
 * Implements 4-layer protection:
 * 1. Global IP-based protection (DDoS prevention)
 * 2. User tier-based limits (free/premium/pro)
 * 3. Endpoint-specific limits (expensive operations)
 * 4. Burst handling (token bucket for spikes)
 */

import type { RateLimitConfig, RateLimitResult } from './types';
import { SlidingWindowRateLimiter } from './sliding-window';
import { TokenBucketRateLimiter } from './token-bucket';

export interface LayerConfig {
  name: string;
  priority: number; // Lower = checked first
  limiter: 'sliding' | 'bucket';
  config: RateLimitConfig;
  keyPrefix: string;
  skipIfFailed?: boolean; // If true, continue to next layer on failure
}

export interface MultiLayerResult {
  allowed: boolean;
  layer: string;
  result: RateLimitResult;
  allResults: Map<string, RateLimitResult>;
}

export class MultiLayerRateLimiter {
  private slidingLimiter: SlidingWindowRateLimiter;
  private bucketLimiter: TokenBucketRateLimiter;
  private layers: LayerConfig[];

  constructor(
    redis: any,
    layers: LayerConfig[] = DEFAULT_LAYERS
  ) {
    // Base configs for each limiter type
    const slidingConfig: RateLimitConfig = {
      maxRequests: 1000,
      windowSeconds: 60,
      algorithm: 'sliding-window',
    };
    
    const bucketConfig: RateLimitConfig = {
      maxRequests: 100,
      windowSeconds: 60,
      algorithm: 'token-bucket',
      burstSize: 20,
    };

    this.slidingLimiter = new SlidingWindowRateLimiter(redis, slidingConfig);
    this.bucketLimiter = new TokenBucketRateLimiter(redis, bucketConfig);
    this.layers = [...layers].sort((a, b) => a.priority - b.priority);
  }

  async initialize(): Promise<void> {
    await this.slidingLimiter.initialize();
    await this.bucketLimiter.initialize();
  }

  async check(
    layerKeyMap: Map<string, string>
  ): Promise<MultiLayerResult> {
    const allResults = new Map<string, RateLimitResult>();

    for (const layer of this.layers) {
      const key = layerKeyMap.get(layer.name);
      if (!key) continue;

      const fullKey = `${layer.keyPrefix}:${key}`;
      let result: RateLimitResult;

      if (layer.limiter === 'sliding') {
        result = await this.slidingLimiter.check(fullKey);
      } else {
        result = await this.bucketLimiter.consume(fullKey);
      }

      allResults.set(layer.name, result);

      if (!result.allowed) {
        if (!layer.skipIfFailed) {
          return {
            allowed: false,
            layer: layer.name,
            result,
            allResults,
          };
        }
      }
    }

    return {
      allowed: true,
      layer: 'all',
      result: allResults.get(this.layers[this.layers.length - 1].name)!,
      allResults,
    };
  }

  async close(): Promise<void> {
    // No explicit close needed for the limiters
  }
}

// Default 4-layer configuration
export const DEFAULT_LAYERS: LayerConfig[] = [
  // Layer 1: Global IP protection (DDoS prevention)
  {
    name: 'global',
    priority: 1,
    limiter: 'sliding',
    config: {
      windowSeconds: 60, // 1 minute
      maxRequests: 1_000,
      algorithm: 'sliding-window',
    },
    keyPrefix: 'ratelimit:global',
    skipIfFailed: false,
  },
  
  // Layer 2: User tier (authenticated users)
  {
    name: 'user_tier',
    priority: 2,
    limiter: 'sliding',
    config: {
      windowSeconds: 60,
      maxRequests: 100, // Default, override per tier
      algorithm: 'sliding-window',
    },
    keyPrefix: 'ratelimit:user',
    skipIfFailed: false,
  },
  
  // Layer 3: Endpoint specific (expensive operations)
  {
    name: 'endpoint',
    priority: 3,
    limiter: 'bucket',
    config: {
      windowSeconds: 60,
      maxRequests: 10, // Adjust per endpoint
      algorithm: 'token-bucket',
      burstSize: 5,
    },
    keyPrefix: 'ratelimit:endpoint',
    skipIfFailed: false,
  },
  
  // Layer 4: Burst handling (token bucket)
  {
    name: 'burst',
    priority: 4,
    limiter: 'bucket',
    config: {
      windowSeconds: 60,
      maxRequests: 20, // Bucket size
      algorithm: 'token-bucket',
      burstSize: 20,
    },
    keyPrefix: 'ratelimit:burst',
    skipIfFailed: false,
  },
];

// Layer key generators
export function createLayerKeys(options: {
  ip: string;
  userId?: string;
  tier?: string;
  endpoint?: string;
}): Map<string, string> {
  const keys = new Map<string, string>();
  
  keys.set('global', options.ip);
  
  if (options.userId) {
    keys.set('user_tier', `${options.tier || 'free'}:${options.userId}`);
  }
  
  if (options.endpoint) {
    keys.set('endpoint', `${options.endpoint}:${options.userId || options.ip}`);
  }
  
  if (options.userId) {
    keys.set('burst', options.userId);
  }
  
  return keys;
}
