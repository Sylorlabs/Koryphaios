/**
 * Redis Connection for BullMQ
 * Shared connection singleton with graceful fallback
 */

import { Redis } from 'ioredis';
import { serverLog } from '../logger';

// ============================================================================
// Configuration
// ============================================================================

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  maxRetriesPerRequest?: number | null;
  enableReadyCheck?: boolean;
}

function getRedisConfig(): RedisConfig {
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || '0'),
    maxRetriesPerRequest: null, // Required for BullMQ blocking commands
    enableReadyCheck: false, // Faster startup
  };
}

// ============================================================================
// Connection Singleton
// ============================================================================

let redisConnection: Redis | null = null;
let isRedisAvailable = false;

export function getRedisConnection(): Redis | null {
  if (!redisConnection) {
    try {
      const config = getRedisConfig();
      redisConnection = new Redis(config);

      redisConnection.on('connect', () => {
        serverLog.info('Redis connected');
        isRedisAvailable = true;
      });

      redisConnection.on('error', (err) => {
        serverLog.warn({ err: err.message }, 'Redis error');
        isRedisAvailable = false;
      });

      redisConnection.on('close', () => {
        serverLog.warn('Redis connection closed');
        isRedisAvailable = false;
      });
    } catch (err) {
      serverLog.warn('Failed to create Redis connection');
      return null;
    }
  }

  return redisConnection;
}

export function isRedisConnected(): boolean {
  return isRedisAvailable && redisConnection?.status === 'ready';
}

export async function closeRedisConnection(): Promise<void> {
  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
    isRedisAvailable = false;
  }
}

// Test connection on startup
export async function testRedisConnection(): Promise<boolean> {
  try {
    const conn = getRedisConnection();
    if (!conn) return false;

    await conn.ping();
    return true;
  } catch {
    return false;
  }
}
