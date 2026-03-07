// Redis Client — Distributed state management for horizontal scaling.
// Provides distributed rate limiting, session state, and caching.

import Redis from "ioredis";
import { serverLog } from "../logger";

let redis: Redis | null = null;
let redisEnabled = false;

export interface RedisConfig {
    enabled: boolean;
    host?: string;
    port?: number;
    password?: string;
    db?: number;
    ttl?: number; // Default TTL for cached items in seconds
}

/**
 * Initialize Redis client for distributed state management.
 * Falls back gracefully if Redis is not available.
 */
export function initRedis(config: RedisConfig = { enabled: false }): void {
    if (!config.enabled) {
        serverLog.info("Redis disabled — using in-memory state only");
        return;
    }

    try {
        redis = new Redis({
            host: config.host || "localhost",
            port: config.port || 6379,
            password: config.password,
            db: config.db || 0,
            retryStrategy: (times: number) => {
                const delay = Math.min(times * 50, 2000);
                return delay;
            },
            maxRetriesPerRequest: 3,
            enableReadyCheck: true,
            enableOfflineQueue: true,
        });

        redis.on("error", (err: Error) => {
            serverLog.error({ err }, "Redis connection error");
            redisEnabled = false;
        });

        redis.on("connect", () => {
            serverLog.info("Redis connected successfully");
            redisEnabled = true;
        });

        redis.on("ready", () => {
            serverLog.info("Redis ready for commands");
            redisEnabled = true;
        });

        redis.on("close", () => {
            serverLog.warn("Redis connection closed");
            redisEnabled = false;
        });

        // Test connection
        redis.ping()
            .then((result: string) => {
                serverLog.info({ result }, "Redis ping successful");
                redisEnabled = true;
            })
            .catch((err: Error) => {
                serverLog.error({ err }, "Redis ping failed");
                redisEnabled = false;
            });
    } catch (err) {
        serverLog.error({ err }, "Failed to initialize Redis");
        redis = null;
        redisEnabled = false;
    }
}

/**
 * Get the Redis client instance.
 * Returns null if Redis is not enabled or available.
 */
export function getRedis(): Redis | null {
    return redisEnabled ? redis : null;
}

/**
 * Check if Redis is available and connected.
 */
export function isRedisAvailable(): boolean {
    return redisEnabled && redis !== null;
}

/**
 * Gracefully close Redis connection.
 */
export async function closeRedis(): Promise<void> {
    if (redis) {
        await redis.quit();
        redis = null;
        redisEnabled = false;
        serverLog.info("Redis connection closed");
    }
}

/**
 * Distributed cache using Redis.
 */
export class DistributedCache {
    private readonly prefix: string;
    private readonly defaultTTL: number;

    constructor(prefix: string = "cache", defaultTTL: number = 3600) {
        this.prefix = prefix;
        this.defaultTTL = defaultTTL;
    }

    /**
     * Get a value from cache.
     */
    async get<T>(key: string): Promise<T | null> {
        const client = getRedis();
        if (!client) return null;

        try {
            const value = await client.get(`${this.prefix}:${key}`);
            if (!value) return null;
            return JSON.parse(value) as T;
        } catch (err) {
            serverLog.error({ err, key }, "Cache get failed");
            return null;
        }
    }

    /**
     * Set a value in cache.
     */
    async set<T>(key: string, value: T, ttl?: number): Promise<void> {
        const client = getRedis();
        if (!client) return;

        try {
            const serialized = JSON.stringify(value);
            const expiry = ttl ?? this.defaultTTL;
            await client.setex(`${this.prefix}:${key}`, expiry, serialized);
        } catch (err) {
            serverLog.error({ err, key }, "Cache set failed");
        }
    }

    /**
     * Delete a value from cache.
     */
    async delete(key: string): Promise<void> {
        const client = getRedis();
        if (!client) return;

        try {
            await client.del(`${this.prefix}:${key}`);
        } catch (err) {
            serverLog.error({ err, key }, "Cache delete failed");
        }
    }

    /**
     * Clear all cache entries with this prefix.
     */
    async clear(): Promise<void> {
        const client = getRedis();
        if (!client) return;

        try {
            const pattern = `${this.prefix}:*`;
            const keys = await client.keys(pattern);
            if (keys.length > 0) {
                await client.del(...keys);
            }
        } catch (err) {
            serverLog.error({ err }, "Cache clear failed");
        }
    }

    /**
     * Get or set a value using a factory function.
     */
    async getOrSet<T>(key: string, factory: () => Promise<T>, ttl?: number): Promise<T> {
        const cached = await this.get<T>(key);
        if (cached !== null) return cached;

        const value = await factory();
        await this.set(key, value, ttl);
        return value;
    }
}

/**
 * Distributed session state management.
 */
export class DistributedSessionState {
    private readonly prefix: string = "session_state";

    /**
     * Get session state.
     */
    async get<T>(sessionId: string, key: string): Promise<T | null> {
        const client = getRedis();
        if (!client) return null;

        try {
            const value = await client.hget(`${this.prefix}:${sessionId}`, key);
            if (!value) return null;
            return JSON.parse(value) as T;
        } catch (err) {
            serverLog.error({ err, sessionId, key }, "Session state get failed");
            return null;
        }
    }

    /**
     * Set session state.
     */
    async set<T>(sessionId: string, key: string, value: T): Promise<void> {
        const client = getRedis();
        if (!client) return;

        try {
            const serialized = JSON.stringify(value);
            await client.hset(`${this.prefix}:${sessionId}`, key, serialized);
            // Set expiration to 24 hours
            await client.expire(`${this.prefix}:${sessionId}`, 86400);
        } catch (err) {
            serverLog.error({ err, sessionId, key }, "Session state set failed");
        }
    }

    /**
     * Delete session state.
     */
    async delete(sessionId: string, key?: string): Promise<void> {
        const client = getRedis();
        if (!client) return;

        try {
            if (key) {
                await client.hdel(`${this.prefix}:${sessionId}`, key);
            } else {
                await client.del(`${this.prefix}:${sessionId}`);
            }
        } catch (err) {
            serverLog.error({ err, sessionId, key }, "Session state delete failed");
        }
    }

    /**
     * Get all session state.
     */
    async getAll<T extends Record<string, unknown>>(sessionId: string): Promise<T> {
        const client = getRedis();
        if (!client) return {} as T;

        try {
            const hash = await client.hgetall(`${this.prefix}:${sessionId}`);
            const result: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(hash)) {
                try {
                    result[key] = JSON.parse(value as string);
                } catch {
                    result[key] = value;
                }
            }
            return result as T;
        } catch (err) {
            serverLog.error({ err, sessionId }, "Session state get all failed");
            return {} as T;
        }
    }
}

// Export singleton instances
export const cache = new DistributedCache("koryphaios_cache", 3600);
export const sessionState = new DistributedSessionState();
