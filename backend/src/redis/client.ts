/**
 * Redis Connection Manager
 * 
 * Manages Redis connections with support for:
 * - Connection pooling
 * - Sentinel mode for HA
 * - Cluster mode for sharding
 * - Automatic reconnection
 * - Health checks
 * - Fallback to in-memory for development
 */

import Redis, { RedisOptions, Cluster as RedisCluster } from 'ioredis';
import { serverLog } from '../logger';

export interface RedisConfig {
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  tls?: boolean;
  
  // Sentinel configuration
  sentinel?: {
    hosts: { host: string; port: number }[];
    masterName: string;
    password?: string;
  };
  
  // Cluster configuration
  cluster?: {
    startupNodes: { host: string; port: number }[];
    options?: RedisOptions;
  };
  
  // Connection pool
  maxRetriesPerRequest?: number;
  enableReadyCheck?: boolean;
  maxLoadingTimeout?: number;
  
  // For development/testing
  fallbackToMemory?: boolean;
}

// In-memory fallback for development
class InMemoryRedis {
  private data: Map<string, any> = new Map();
  private expirations: Map<string, number> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();

  async get(key: string): Promise<string | null> {
    this.checkExpiration(key);
    const value = this.data.get(key);
    return value !== undefined ? String(value) : null;
  }

  async set(key: string, value: string, ...args: any[]): Promise<'OK'> {
    this.data.set(key, value);
    
    // Handle EX/PX arguments
    for (let i = 0; i < args.length; i++) {
      if (args[i] === 'EX' && args[i + 1]) {
        this.setExpiration(key, args[i + 1] * 1000);
      } else if (args[i] === 'PX' && args[i + 1]) {
        this.setExpiration(key, args[i + 1]);
      }
    }
    
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.data.has(key)) {
        this.data.delete(key);
        this.expirations.delete(key);
        const timer = this.timers.get(key);
        if (timer) {
          clearTimeout(timer);
          this.timers.delete(key);
        }
        count++;
      }
    }
    return count;
  }

  async exists(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      this.checkExpiration(key);
      if (this.data.has(key)) count++;
    }
    return count;
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (!this.data.has(key)) return 0;
    this.setExpiration(key, seconds * 1000);
    return 1;
  }

  async ttl(key: string): Promise<number> {
    this.checkExpiration(key);
    const exp = this.expirations.get(key);
    if (!exp) return -1;
    return Math.ceil((exp - Date.now()) / 1000);
  }

  async zadd(key: string, ...args: any[]): Promise<number> {
    this.checkExpiration(key);
    let score: number | undefined;
    const members: { score: number; member: string }[] = [];
    
    for (let i = 0; i < args.length; i++) {
      if (score === undefined) {
        score = Number(args[i]);
      } else {
        members.push({ score, member: String(args[i]) });
        score = undefined;
      }
    }
    
    let set = this.data.get(key) as Map<string, number> | undefined;
    if (!set) {
      set = new Map();
      this.data.set(key, set);
    }
    
    let added = 0;
    for (const { score, member } of members) {
      if (!set.has(member)) added++;
      set.set(member, score);
    }
    
    return added;
  }

  async zremrangebyscore(key: string, min: string | number, max: string | number): Promise<number> {
    this.checkExpiration(key);
    const set = this.data.get(key) as Map<string, number> | undefined;
    if (!set) return 0;
    
    const minScore = min === '-inf' ? -Infinity : Number(min);
    const maxScore = max === '+inf' || max === 'inf' ? Infinity : Number(max);
    
    let removed = 0;
    for (const [member, score] of set.entries()) {
      if (score >= minScore && score <= maxScore) {
        set.delete(member);
        removed++;
      }
    }
    
    return removed;
  }

  async zcard(key: string): Promise<number> {
    this.checkExpiration(key);
    const set = this.data.get(key) as Map<string, number> | undefined;
    return set ? set.size : 0;
  }

  async zrange(key: string, start: number, stop: number, ...args: string[]): Promise<string[]> {
    this.checkExpiration(key);
    const set = this.data.get(key) as Map<string, number> | undefined;
    if (!set) return [];
    
    const entries = Array.from(set.entries());
    entries.sort((a, b) => a[1] - b[1]);
    
    const sliced = entries.slice(start, stop === -1 ? undefined : stop + 1);
    
    if (args.includes('WITHSCORES')) {
      return sliced.flatMap(([member, score]) => [member, String(score)]);
    }
    
    return sliced.map(([member]) => member);
  }

  async hmset(key: string, ...args: any[]): Promise<'OK'> {
    this.checkExpiration(key);
    let hash = this.data.get(key) as Map<string, string> | undefined;
    if (!hash) {
      hash = new Map();
      this.data.set(key, hash);
    }
    
    for (let i = 0; i < args.length; i += 2) {
      if (args[i + 1] !== undefined) {
        hash.set(String(args[i]), String(args[i + 1]));
      }
    }
    
    return 'OK';
  }

  async hmget(key: string, ...fields: string[]): Promise<(string | null)[]> {
    this.checkExpiration(key);
    const hash = this.data.get(key) as Map<string, string> | undefined;
    if (!hash) return fields.map(() => null);
    
    return fields.map(f => hash.get(f) || null);
  }

  async script(command: 'LOAD', script: string): Promise<string> {
    // Return a hash of the script
    let hash = 0;
    for (let i = 0; i < script.length; i++) {
      const char = script.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  }

  async evalsha(sha: string | null, numKeys: number, ...args: any[]): Promise<any[]> {
    // In-memory fallback doesn't support Lua scripts
    // Return a sensible default
    return [1, 10, Date.now() + 60000];
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp(pattern.replace('*', '.*').replace('?', '.'));
    return Array.from(this.data.keys()).filter(k => regex.test(k));
  }

  async flushall(): Promise<'OK'> {
    this.data.clear();
    this.expirations.clear();
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    return 'OK';
  }

  async ping(): Promise<'PONG'> {
    return 'PONG';
  }

  async quit(): Promise<'OK'> {
    return 'OK';
  }

  private checkExpiration(key: string): void {
    const exp = this.expirations.get(key);
    if (exp && exp < Date.now()) {
      this.del(key);
    }
  }

  private setExpiration(key: string, ttlMs: number): void {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    
    this.expirations.set(key, Date.now() + ttlMs);
    const timer = setTimeout(() => {
      this.del(key);
    }, ttlMs);
    
    this.timers.set(key, timer);
  }
}

// Connection manager
class RedisManager {
  private client: Redis | RedisCluster | InMemoryRedis | null = null;
  private config: RedisConfig = {};
  private isConnected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  /**
   * Initialize Redis connection
   */
  async initialize(config: RedisConfig = {}): Promise<void> {
    this.config = {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      maxLoadingTimeout: 30000,
      fallbackToMemory: process.env.NODE_ENV === 'development',
      ...config,
    };

    // Check if we should use fallback
    if (!this.config.url && !this.config.host && !this.config.sentinel && !this.config.cluster) {
      if (this.config.fallbackToMemory) {
        serverLog.warn('No Redis configuration provided, using in-memory fallback (NOT FOR PRODUCTION)');
        this.client = new InMemoryRedis();
        this.isConnected = true;
        return;
      }
      throw new Error('Redis configuration required. Set REDIS_URL or enable fallbackToMemory for development.');
    }

    await this.connect();
    this.startHealthChecks();
  }

  /**
   * Get Redis client
   */
  getClient(): Redis | RedisCluster | InMemoryRedis {
    if (!this.client) {
      throw new Error('Redis not initialized. Call initialize() first.');
    }
    return this.client;
  }

  /**
   * Check if connected
   */
  isHealthy(): boolean {
    return this.isConnected && this.client !== null;
  }

  /**
   * Close connection
   */
  async close(): Promise<void> {
    this.stopHealthChecks();
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.client instanceof Redis) {
      await this.client.quit();
    }
    
    this.client = null;
    this.isConnected = false;
  }

  private async connect(): Promise<void> {
    try {
      if (this.config.cluster) {
        this.client = new RedisCluster(
          this.config.cluster.startupNodes,
          this.config.cluster.options
        );
      } else if (this.config.sentinel) {
        this.client = new Redis({
          sentinels: this.config.sentinel.hosts,
          name: this.config.sentinel.masterName,
          sentinelPassword: this.config.sentinel.password,
          password: this.config.password,
          maxRetriesPerRequest: this.config.maxRetriesPerRequest,
          enableReadyCheck: this.config.enableReadyCheck,
        });
      } else if (this.config.url) {
        this.client = new Redis(this.config.url, {
          maxRetriesPerRequest: this.config.maxRetriesPerRequest,
          enableReadyCheck: this.config.enableReadyCheck,
        });
      } else {
        this.client = new Redis({
          host: this.config.host || 'localhost',
          port: this.config.port || 6379,
          password: this.config.password,
          db: this.config.db || 0,
          tls: this.config.tls ? {} : undefined,
          maxRetriesPerRequest: this.config.maxRetriesPerRequest,
          enableReadyCheck: this.config.enableReadyCheck,
        });
      }

      this.setupEventHandlers();
      await this.waitForReady();
      
      this.isConnected = true;
      serverLog.info('Redis connection established');
    } catch (error) {
      serverLog.error({ error }, 'Failed to connect to Redis');
      
      if (this.config.fallbackToMemory) {
        serverLog.warn('Falling back to in-memory Redis (NOT FOR PRODUCTION)');
        this.client = new InMemoryRedis();
        this.isConnected = true;
      } else {
        throw error;
      }
    }
  }

  private setupEventHandlers(): void {
    if (!(this.client instanceof Redis)) return;

    this.client.on('connect', () => {
      serverLog.info('Redis connecting...');
    });

    this.client.on('ready', () => {
      serverLog.info('Redis ready');
      this.isConnected = true;
    });

    this.client.on('error', (err) => {
      serverLog.error({ error: err }, 'Redis error');
      this.isConnected = false;
    });

    this.client.on('close', () => {
      serverLog.warn('Redis connection closed');
      this.isConnected = false;
      this.scheduleReconnect();
    });

    this.client.on('reconnecting', () => {
      serverLog.info('Redis reconnecting...');
    });
  }

  private async waitForReady(): Promise<void> {
    if (!(this.client instanceof Redis)) return;
    
    const timeout = this.config.maxLoadingTimeout || 30000;
    const start = Date.now();
    
    while (Date.now() - start < timeout) {
      if (this.client.status === 'ready') return;
      await new Promise(r => setTimeout(r, 100));
    }
    
    throw new Error('Redis connection timeout');
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      
      if (!this.isConnected) {
        serverLog.info('Attempting Redis reconnection...');
        try {
          await this.connect();
        } catch (error) {
          serverLog.error({ error }, 'Redis reconnection failed');
          this.scheduleReconnect();
        }
      }
    }, 5000);
  }

  private startHealthChecks(): void {
    this.healthCheckInterval = setInterval(async () => {
      if (!this.client || this.client instanceof InMemoryRedis) return;
      
      try {
        await this.client.ping();
      } catch (error) {
        serverLog.error({ error }, 'Redis health check failed');
        this.isConnected = false;
      }
    }, 30000);
  }

  private stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }
}

// Singleton instance
let redisManager: RedisManager | null = null;

export function getRedisManager(): RedisManager {
  if (!redisManager) {
    redisManager = new RedisManager();
  }
  return redisManager;
}

export async function initializeRedis(config?: RedisConfig): Promise<void> {
  const manager = getRedisManager();
  await manager.initialize(config);
}

export function getRedisClient(): Redis | RedisCluster | InMemoryRedis {
  return getRedisManager().getClient();
}

export async function closeRedis(): Promise<void> {
  if (redisManager) {
    await redisManager.close();
    redisManager = null;
  }
}

export { InMemoryRedis };
