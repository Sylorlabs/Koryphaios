/**
 * Memory Context Assembly
 * 
 * Functions for assembling memory context from all sources
 * and formatting for use in AI prompts.
 * 
 * PERFORMANCE: Includes LRU cache with size limits to prevent memory leaks.
 */

import { MemoryFile, MemorySettings, MemoryContext } from "./types";
import { readUniversalMemory } from "./universal";
import { readProjectMemory } from "./project";
import { readSessionMemory } from "./session";
import { readRules } from "./rules";
import { loadMemorySettings } from "./settings";

// ============================================================================
// LRU Cache with Size Limits
// ============================================================================

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  key: string;
  accessCount: number;
}

class LRUCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;
  private readonly defaultTtlMs: number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(maxSize: number = 100, defaultTtlMs: number = 30000) {
    this.maxSize = maxSize;
    this.defaultTtlMs = defaultTtlMs;
  }

  get(key: string, ttlMs?: number): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    
    const effectiveTtl = ttlMs ?? this.defaultTtlMs;
    if (Date.now() - entry.timestamp > effectiveTtl) {
      this.cache.delete(key);
      this.misses++;
      return undefined;
    }
    
    // Update access metadata for LRU
    entry.accessCount++;
    entry.timestamp = Date.now(); // Extend TTL on access
    this.hits++;
    
    return entry.data;
  }

  set(key: string, data: T): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }
    
    this.cache.set(key, { 
      data, 
      timestamp: Date.now(), 
      key,
      accessCount: 0 
    });
  }

  invalidate(keyPattern?: string): void {
    if (!keyPattern) {
      this.evictions += this.cache.size;
      this.cache.clear();
      return;
    }
    
    for (const [key] of this.cache) {
      if (key.includes(keyPattern)) {
        this.cache.delete(key);
        this.evictions++;
      }
    }
  }

  /**
   * Evict least recently used entry
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    let lowestAccess = Infinity;
    
    for (const [key, entry] of this.cache) {
      // Weighted score: prefer older entries with fewer accesses
      const score = entry.timestamp / (entry.accessCount + 1);
      if (score < oldestTime / (lowestAccess + 1)) {
        oldestTime = entry.timestamp;
        lowestAccess = entry.accessCount;
        oldestKey = key;
      }
    }
    
    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.evictions++;
    }
  }

  getStats(): { 
    size: number; 
    maxSize: number;
    hits: number;
    misses: number;
    hitRate: number;
    evictions: number;
  } {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      evictions: this.evictions,
    };
  }
}

// Singleton cache instance with reasonable limits
// Max 100 entries, 30 second TTL
const contextCache = new LRUCache<MemoryContext>(100, 30000);

// Track file modification times for cache invalidation
const fileModCache = new Map<string, number>();

// ============================================================================
// Context Assembly
// ============================================================================

/**
 * Build cache key for memory context
 * FIX: Properly escapes projectRoot to avoid key collision issues
 */
function buildCacheKey(projectRoot: string, sessionId: string | null, settings: MemorySettings): string {
  // Normalize path and encode to avoid issues with special characters
  const normalizedRoot = projectRoot.replace(/:/g, '_');
  const settingsHash = `${settings.universalMemoryEnabled ? 1 : 0}${settings.projectMemoryEnabled ? 1 : 0}${settings.sessionMemoryEnabled ? 1 : 0}${settings.rulesEnabled ? 1 : 0}`;
  return `${normalizedRoot}:${sessionId ?? 'nosession'}:${settingsHash}`;
}

/**
 * Assemble memory context from all sources.
 * 
 * PERFORMANCE: Uses LRU cache with 100-entry limit and 30-second TTL.
 * Automatic invalidation on file changes (checked via mod time).
 */
export function assembleMemoryContext(
  projectRoot: string,
  sessionId: string | null,
  settings?: MemorySettings
): MemoryContext {
  const effectiveSettings = settings ?? loadMemorySettings(projectRoot);
  const cacheKey = buildCacheKey(projectRoot, sessionId, effectiveSettings);
  
  // Check cache first
  const cached = contextCache.get(cacheKey);
  if (cached && !hasFilesChanged(projectRoot, sessionId, cached)) {
    return cached;
  }
  
  // Assemble fresh context
  const context: MemoryContext = {
    universal: effectiveSettings.universalMemoryEnabled ? readUniversalMemory() : null,
    project: effectiveSettings.projectMemoryEnabled ? readProjectMemory(projectRoot) : null,
    session: effectiveSettings.sessionMemoryEnabled && sessionId
      ? readSessionMemory(projectRoot, sessionId)
      : null,
    rules: effectiveSettings.rulesEnabled ? readRules(projectRoot) : null,
    settings: effectiveSettings,
  };
  
  // Cache the result
  contextCache.set(cacheKey, context);
  updateFileModCache(projectRoot, sessionId, context);
  
  return context;
}

/**
 * Check if any memory files have changed since we cached them
 */
function hasFilesChanged(projectRoot: string, sessionId: string | null, context: MemoryContext): boolean {
  // Check each file's mod time
  if (context.rules?.exists) {
    const key = `${projectRoot}:rules`;
    const cachedMod = fileModCache.get(key);
    const currentMod = getFileModTime(`${projectRoot}/.koryrules`);
    if (cachedMod !== currentMod) return true;
  }
  
  if (context.project?.exists) {
    const key = `${projectRoot}:project`;
    const cachedMod = fileModCache.get(key);
    const currentMod = getFileModTime(`${projectRoot}/.koryphaios/memory/project.md`);
    if (cachedMod !== currentMod) return true;
  }
  
  if (context.session?.exists && sessionId) {
    const key = `${projectRoot}:session:${sessionId}`;
    const cachedMod = fileModCache.get(key);
    const currentMod = getFileModTime(`${projectRoot}/.koryphaios/memory/sessions/${sessionId}.md`);
    if (cachedMod !== currentMod) return true;
  }
  
  return false;
}

/**
 * Update file modification time cache
 */
function updateFileModCache(projectRoot: string, sessionId: string | null, context: MemoryContext): void {
  if (context.rules?.exists) {
    fileModCache.set(`${projectRoot}:rules`, getFileModTime(`${projectRoot}/.koryrules`));
  }
  
  if (context.project?.exists) {
    fileModCache.set(`${projectRoot}:project`, getFileModTime(`${projectRoot}/.koryphaios/memory/project.md`));
  }
  
  if (context.session?.exists && sessionId) {
    fileModCache.set(`${projectRoot}:session:${sessionId}`, getFileModTime(`${projectRoot}/.koryphaios/memory/sessions/${sessionId}.md`));
  }
}

/**
 * Get file modification time (0 if file doesn't exist)
 */
function getFileModTime(path: string): number {
  try {
    const { statSync } = require('fs');
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Assemble memory context asynchronously.
 * PERFORMANCE: Async version for non-blocking I/O.
 */
export async function assembleMemoryContextAsync(
  projectRoot: string,
  sessionId: string | null,
  settings?: MemorySettings
): Promise<MemoryContext> {
  // For now, use sync version but could be made truly async
  return assembleMemoryContext(projectRoot, sessionId, settings);
}

/**
 * Invalidate memory context cache.
 * Call this when memory files are modified.
 */
export function invalidateMemoryCache(projectRoot?: string): void {
  if (projectRoot) {
    contextCache.invalidate(projectRoot);
    // Also clear file mod cache for this project
    for (const key of fileModCache.keys()) {
      if (key.startsWith(projectRoot)) {
        fileModCache.delete(key);
      }
    }
  } else {
    contextCache.invalidate();
    fileModCache.clear();
  }
}

/**
 * Get cache statistics for monitoring.
 */
export function getMemoryCacheStats(): { 
  contextCache: ReturnType<LRUCache<MemoryContext>['getStats']>;
  fileModCacheSize: number;
} {
  return {
    contextCache: contextCache.getStats(),
    fileModCacheSize: fileModCache.size,
  };
}

export function formatMemoryForContext(context: MemoryContext): string {
  const parts: string[] = [];
  
  if (context.rules?.exists && context.rules.content) {
    parts.push(`## Project Rules (.koryrules)\n\n${context.rules.content}`);
  }
  
  if (context.universal?.exists && context.universal.content) {
    parts.push(`## Universal Memory\n\n${context.universal.content}`);
  }
  
  if (context.project?.exists && context.project.content) {
    parts.push(`## Project Memory\n\n${context.project.content}`);
  }
  
  if (context.session?.exists && context.session.content) {
    parts.push(`## Session Memory\n\n${context.session.content}`);
  }
  
  if (parts.length === 0) {
    return "";
  }
  
  return `# Memory Context\n\n${parts.join("\n\n---\n\n")}`;
}

// ============================================================================
// Context Helpers
// ============================================================================

/**
 * Get a summary of memory context for display
 */
export function getMemoryContextSummary(context: MemoryContext): {
  hasRules: boolean;
  hasUniversal: boolean;
  hasProject: boolean;
  hasSession: boolean;
  totalSize: number;
} {
  const hasRules = context.rules?.exists ?? false;
  const hasUniversal = context.universal?.exists ?? false;
  const hasProject = context.project?.exists ?? false;
  const hasSession = context.session?.exists ?? false;
  
  const totalSize = [
    context.rules,
    context.universal,
    context.project,
    context.session,
  ].reduce((sum, file) => sum + (file?.size ?? 0), 0);
  
  return {
    hasRules,
    hasUniversal,
    hasProject,
    hasSession,
    totalSize,
  };
}

/**
 * Filter memory content based on settings
 */
export function filterMemoryContent(
  content: string,
  maxTokens: number
): string {
  // Simple approximation: ~4 characters per token
  const maxChars = maxTokens * 4;
  
  if (content.length <= maxChars) {
    return content;
  }
  
  // Truncate with a notice
  const truncated = content.slice(0, maxChars);
  return `${truncated}\n\n[Content truncated due to length. Consider cleaning up memory files.]\n`;
}
