// Bounded Cache — TTL-based cache with automatic cleanup and size limits
// Prevents memory leaks from unbounded Map usage

import { serverLog } from "../logger";

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  createdAt: number;
  accessCount: number;
  lastAccessedAt: number;
}

export interface BoundedCacheConfig {
  /** Maximum number of entries in the cache */
  maxSize: number;
  /** Default TTL in milliseconds */
  defaultTtlMs: number;
  /** Interval for cleanup of expired entries */
  cleanupIntervalMs: number;
  /** Enable logging */
  enableLogging?: boolean;
  /** Name for logging */
  name?: string;
}

export interface CacheStats {
  name: string;
  size: number;
  maxSize: number;
  hits: number;
  misses: number;
  evictions: number;
  expiredCleanups: number;
  hitRate: number;
}

/**
 * Bounded cache with TTL support
 * 
 * Features:
 * - Maximum size limit with LRU eviction
 * - TTL-based expiration
 * - Automatic periodic cleanup
 * - Statistics tracking
 */
export class BoundedCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expiredCleanups = 0;
  private cleanupTimer: Timer | null = null;

  private readonly config: BoundedCacheConfig;

  constructor(config: Partial<BoundedCacheConfig> & { name?: string }) {
    this.config = {
      maxSize: 1000,
      defaultTtlMs: 5 * 60 * 1000, // 5 minutes
      cleanupIntervalMs: 60 * 1000, // 1 minute
      enableLogging: false,
      ...config,
    };

    this.startCleanupTimer();
  }

  /**
   * Get a value from the cache
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    
    if (!entry) {
      this.misses++;
      return undefined;
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      this.expiredCleanups++;
      return undefined;
    }

    // Update access stats
    entry.accessCount++;
    entry.lastAccessedAt = Date.now();

    // Move to end for LRU (Map maintains insertion order)
    this.cache.delete(key);
    this.cache.set(key, entry);

    this.hits++;
    return entry.value;
  }

  /**
   * Set a value in the cache
   */
  set(key: string, value: T, ttlMs?: number): void {
    const now = Date.now();
    const expiresAt = now + (ttlMs ?? this.config.defaultTtlMs);

    // Remove existing entry if present
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest if at capacity
    while (this.cache.size >= this.config.maxSize) {
      this.evictOldest();
    }

    this.cache.set(key, {
      value,
      expiresAt,
      createdAt: now,
      accessCount: 0,
      lastAccessedAt: now,
    });
  }

  /**
   * Check if a key exists and is not expired
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.expiredCleanups++;
      return false;
    }
    
    return true;
  }

  /**
   * Delete a key from the cache
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get or compute a value
   */
  async getOrSet(key: string, fn: () => Promise<T>, ttlMs?: number): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const value = await fn();
    this.set(key, value, ttlMs);
    return value;
  }

  /**
   * Get current size
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get all keys
   */
  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Evict the oldest entry (LRU)
   */
  private evictOldest(): void {
    // Map maintains insertion order, first entry is oldest
    const oldestKey = this.cache.keys().next().value;
    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.evictions++;
    }
  }

  /**
   * Clean up expired entries
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    this.expiredCleanups += cleaned;

    if (cleaned > 0 && this.config.enableLogging) {
      serverLog.debug(
        { cache: this.config.name, cleaned },
        "Cache cleanup removed expired entries"
      );
    }

    return cleaned;
  }

  /**
   * Start periodic cleanup timer
   */
  private startCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupIntervalMs);
  }

  /**
   * Stop cleanup timer
   */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      name: this.config.name ?? "unnamed",
      size: this.cache.size,
      maxSize: this.config.maxSize,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expiredCleanups: this.expiredCleanups,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.expiredCleanups = 0;
  }

  /**
   * Shutdown cache
   */
  shutdown(): void {
    this.stopCleanupTimer();
    this.clear();
    
    if (this.config.enableLogging) {
      serverLog.debug({ cache: this.config.name }, "Cache shutdown complete");
    }
  }
}

// ─── Cache Manager ────────────────────────────────────────────────────────────

/**
 * Manager for multiple caches with shared configuration
 */
export class CacheManager {
  private caches = new Map<string, BoundedCache<unknown>>();
  private defaultConfig: Omit<BoundedCacheConfig, "name">;

  constructor(defaultConfig?: Partial<BoundedCacheConfig>) {
    this.defaultConfig = {
      maxSize: 1000,
      defaultTtlMs: 5 * 60 * 1000,
      cleanupIntervalMs: 60 * 1000,
      enableLogging: false,
      ...defaultConfig,
    };
  }

  /**
   * Get or create a cache by name
   */
  get<T>(name: string, config?: Partial<BoundedCacheConfig>): BoundedCache<T> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new BoundedCache<T>({
        ...this.defaultConfig,
        ...config,
        name,
      });
      this.caches.set(name, cache as BoundedCache<unknown>);
    }
    return cache as BoundedCache<T>;
  }

  /**
   * Get all cache statistics
   */
  getAllStats(): CacheStats[] {
    return Array.from(this.caches.values()).map((c) => c.getStats());
  }

  /**
   * Cleanup all caches
   */
  cleanupAll(): void {
    for (const cache of this.caches.values()) {
      cache.cleanup();
    }
  }

  /**
   * Shutdown all caches
   */
  shutdownAll(): void {
    for (const cache of this.caches.values()) {
      cache.shutdown();
    }
    this.caches.clear();
  }
}

// ─── Singleton Manager ────────────────────────────────────────────────────────

let manager: CacheManager | null = null;

export function getCacheManager(): CacheManager {
  if (!manager) {
    manager = new CacheManager();
  }
  return manager;
}

export function getCache<T>(
  name: string, 
  config?: Partial<BoundedCacheConfig>
): BoundedCache<T> {
  return getCacheManager().get<T>(name, config);
}