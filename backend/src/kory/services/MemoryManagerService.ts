/**
 * MemoryManagerService - Tiered Memory Management for Agents
 *
 * Provides a comprehensive memory system with three tiers:
 * - Short-term: In-memory context for current session
 * - Long-term: Persistent storage across sessions
 * - Vector: Semantic search for relevant historical context
 *
 * Features:
 * - Automatic context window management with pruning
 * - Semantic retrieval for cross-session knowledge
 * - Memory compression for long contexts
 * - Relevance scoring and ranking
 * - Conversation summarization
 */

import { koryLog } from '../../logger';

export interface MemoryTier {
  type: 'short-term' | 'long-term' | 'vector';
  maxTokens: number;
  ttlMs?: number;
}

export interface MemoryEntry {
  id: string;
  content: string;
  tokens: number;
  timestamp: number;
  sessionId: string;
  agentId: string;
  importance: number; // 0-1
  metadata: {
    type: 'message' | 'tool-result' | 'thought' | 'summary' | 'fact';
    tags: string[];
    source?: string;
    entities?: string[];
  };
  embedding?: number[];
  accessCount: number;
  lastAccessed: number;
}

export interface VectorMemory {
  id: string;
  content: string;
  embedding: number[];
  metadata: {
    sessionId: string;
    timestamp: number;
    tags: string[];
  };
}

export interface ContextWindow {
  entries: MemoryEntry[];
  totalTokens: number;
  maxTokens: number;
  pruned: boolean;
}

export interface MemoryQuery {
  content?: string;
  sessionId?: string;
  agentId?: string;
  tags?: string[];
  type?: MemoryEntry['metadata']['type'];
  timeRange?: { start: number; end: number };
  limit?: number;
  minImportance?: number;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  relevanceScore: number;
  semanticScore?: number;
  temporalScore?: number;
}

export interface PruningStrategy {
  type: 'oldest-first' | 'least-important' | 'least-accessed' | 'summarize';
  targetTokenCount: number;
  preserveRecentMs?: number;
}

export interface ConversationSummary {
  id: string;
  sessionId: string;
  startTime: number;
  endTime: number;
  summary: string;
  keyPoints: string[];
  entities: string[];
  decisions: string[];
  tokenCount: number;
}

export interface MemoryConfig {
  shortTerm: {
    maxTokens: number;
    defaultTTLMs: number;
    pruningStrategy: PruningStrategy['type'];
  };
  longTerm: {
    maxEntries: number;
    minImportance: number;
  };
  vector: {
    enabled: boolean;
    dimensions: number;
    similarityThreshold: number;
    maxResults: number;
  };
  compression: {
    enabled: boolean;
    thresholdTokens: number;
    compressionRatio: number;
  };
}

const DEFAULT_CONFIG: MemoryConfig = {
  shortTerm: {
    maxTokens: 16000, // 4k tokens buffer for model
    defaultTTLMs: 30 * 60 * 1000, // 30 minutes
    pruningStrategy: 'least-important',
  },
  longTerm: {
    maxEntries: 10000,
    minImportance: 0.5,
  },
  vector: {
    enabled: true,
    dimensions: 1536, // OpenAI embedding dimensions
    similarityThreshold: 0.7,
    maxResults: 10,
  },
  compression: {
    enabled: true,
    thresholdTokens: 12000,
    compressionRatio: 0.5,
  },
};

export class MemoryManagerService {
  private shortTermMemory = new Map<string, MemoryEntry>();
  private longTermMemory = new Map<string, MemoryEntry>();
  private vectorMemory: VectorMemory[] = [];
  private summaries: ConversationSummary[] = [];
  private config: MemoryConfig;
  private cleanupInterval?: Timer;
  private sessionContexts = new Map<string, ContextWindow>();

  constructor(config?: Partial<MemoryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startCleanupInterval();
  }

  /**
   * Store a memory entry with automatic tier selection
   */
  async store(
    entry: Omit<MemoryEntry, 'id' | 'timestamp' | 'accessCount' | 'lastAccessed'>,
  ): Promise<MemoryEntry> {
    const fullEntry: MemoryEntry = {
      ...entry,
      id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: Date.now(),
      accessCount: 0,
      lastAccessed: Date.now(),
    };

    // Determine which tier to store in
    const tier = this.selectTier(fullEntry);

    switch (tier) {
      case 'short-term':
        await this.storeShortTerm(fullEntry);
        break;
      case 'long-term':
        this.storeLongTerm(fullEntry);
        break;
      case 'vector':
        await this.storeVector(fullEntry);
        break;
    }

    koryLog.debug(
      {
        entryId: fullEntry.id,
        tier,
        tokens: fullEntry.tokens,
        importance: fullEntry.importance,
      },
      'Memory stored',
    );

    return fullEntry;
  }

  /**
   * Store in short-term memory with context window management
   */
  private async storeShortTerm(entry: MemoryEntry): Promise<void> {
    const sessionId = entry.sessionId;
    let context = this.sessionContexts.get(sessionId);

    if (!context) {
      context = {
        entries: [],
        totalTokens: 0,
        maxTokens: this.config.shortTerm.maxTokens,
        pruned: false,
      };
      this.sessionContexts.set(sessionId, context);
    }

    // Check if we need to prune
    if (context.totalTokens + entry.tokens > context.maxTokens) {
      await this.pruneContext(sessionId);
    }

    // Add entry
    this.shortTermMemory.set(entry.id, entry);
    context.entries.push(entry);
    context.totalTokens += entry.tokens;

    // Update session context
    this.sessionContexts.set(sessionId, context);
  }

  /**
   * Store in long-term memory
   */
  private storeLongTerm(entry: MemoryEntry): void {
    // Evict old entries if at capacity
    if (this.longTermMemory.size >= this.config.longTerm.maxEntries) {
      this.evictLongTerm();
    }

    this.longTermMemory.set(entry.id, entry);
  }

  /**
   * Store in vector memory (semantic search)
   */
  private async storeVector(entry: MemoryEntry): Promise<void> {
    if (!this.config.vector.enabled) return;

    // Generate embedding (simplified - in reality, call embedding API)
    const embedding = await this.generateEmbedding(entry.content);
    entry.embedding = embedding;

    this.vectorMemory.push({
      id: entry.id,
      content: entry.content,
      embedding,
      metadata: {
        sessionId: entry.sessionId,
        timestamp: entry.timestamp,
        tags: entry.metadata.tags,
      },
    });

    // Also store in short-term for immediate access
    await this.storeShortTerm(entry);
  }

  /**
   * Retrieve memories matching query criteria
   */
  async retrieve(query: MemoryQuery): Promise<MemorySearchResult[]> {
    const results: MemorySearchResult[] = [];

    // Search short-term memory
    for (const entry of this.shortTermMemory.values()) {
      if (this.matchesQuery(entry, query)) {
        results.push({
          entry,
          relevanceScore: this.calculateRelevance(entry, query),
          temporalScore: this.calculateTemporalScore(entry),
        });
      }
    }

    // Search long-term memory for cross-session context
    if (!query.sessionId) {
      for (const entry of this.longTermMemory.values()) {
        if (this.matchesQuery(entry, query)) {
          results.push({
            entry,
            relevanceScore: this.calculateRelevance(entry, query) * 0.8, // Slightly lower priority
            temporalScore: this.calculateTemporalScore(entry),
          });
        }
      }
    }

    // Semantic search if content provided and vector enabled
    if (query.content && this.config.vector.enabled) {
      const semanticResults = await this.semanticSearch(query.content, query.limit);

      for (const semanticResult of semanticResults) {
        const existing = results.find((r) => r.entry.id === semanticResult.entry.id);
        if (existing) {
          existing.semanticScore = semanticResult.semanticScore;
          existing.relevanceScore = Math.max(
            existing.relevanceScore,
            semanticResult.relevanceScore,
          );
        } else if (this.matchesQuery(semanticResult.entry, query)) {
          results.push(semanticResult);
        }
      }
    }

    // Sort by relevance and limit
    results.sort((a, b) => b.relevanceScore - a.relevanceScore);
    const limited = results.slice(0, query.limit || 20);

    // Update access counts
    for (const result of limited) {
      result.entry.accessCount++;
      result.entry.lastAccessed = Date.now();
    }

    return limited;
  }

  /**
   * Get context window for a session (formatted for LLM)
   */
  async getContextWindow(sessionId: string, maxTokens?: number): Promise<string> {
    const context = this.sessionContexts.get(sessionId);
    if (!context || context.entries.length === 0) {
      return '';
    }

    const limit = maxTokens || this.config.shortTerm.maxTokens;
    let totalTokens = 0;
    const selectedEntries: MemoryEntry[] = [];

    // Select entries by importance and recency
    const sortedEntries = [...context.entries].sort((a, b) => {
      const scoreA = a.importance + (a.timestamp / Date.now()) * 0.5;
      const scoreB = b.importance + (b.timestamp / Date.now()) * 0.5;
      return scoreB - scoreA;
    });

    for (const entry of sortedEntries) {
      if (totalTokens + entry.tokens > limit) break;
      selectedEntries.push(entry);
      totalTokens += entry.tokens;
    }

    // Sort by timestamp for chronological order
    selectedEntries.sort((a, b) => a.timestamp - b.timestamp);

    // Format as conversation
    return selectedEntries.map((e) => this.formatEntry(e)).join('\n\n');
  }

  /**
   * Clear all memory for a session
   */
  clearSession(sessionId: string): void {
    // Remove from short-term
    for (const [id, entry] of this.shortTermMemory) {
      if (entry.sessionId === sessionId) {
        this.shortTermMemory.delete(id);
      }
    }

    // Remove context window
    this.sessionContexts.delete(sessionId);

    koryLog.info({ sessionId }, 'Session memory cleared');
  }

  /**
   * Cleanup expired memories
   */
  cleanup(): void {
    const now = Date.now();
    const ttl = this.config.shortTerm.defaultTTLMs;

    // Clean short-term memory
    for (const [id, entry] of this.shortTermMemory) {
      if (now - entry.timestamp > ttl) {
        this.shortTermMemory.delete(id);
      }
    }

    // Clean vector memory
    this.vectorMemory = this.vectorMemory.filter((v) => now - v.metadata.timestamp < ttl * 2);

    koryLog.debug('Memory cleanup completed');
  }

  /**
   * Destroy service and clean up resources
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.shortTermMemory.clear();
    this.longTermMemory.clear();
    this.vectorMemory = [];
    this.summaries = [];
    this.sessionContexts.clear();
  }

  // ─── Private Methods ───────────────────────────────────────────────────────────

  private selectTier(entry: MemoryEntry): MemoryTier['type'] {
    // High importance facts go to vector memory
    if (entry.importance > 0.8 && entry.metadata.type === 'fact') {
      return 'vector';
    }

    // Important cross-session knowledge goes to long-term
    if (entry.importance > this.config.longTerm.minImportance) {
      return 'long-term';
    }

    // Default to short-term
    return 'short-term';
  }

  private matchesQuery(entry: MemoryEntry, query: MemoryQuery): boolean {
    if (query.sessionId && entry.sessionId !== query.sessionId) return false;
    if (query.agentId && entry.agentId !== query.agentId) return false;
    if (query.type && entry.metadata.type !== query.type) return false;
    if (query.minImportance && entry.importance < query.minImportance) return false;

    if (query.tags && query.tags.length > 0) {
      const hasTag = query.tags.some((t) => entry.metadata.tags.includes(t));
      if (!hasTag) return false;
    }

    if (query.timeRange) {
      if (entry.timestamp < query.timeRange.start || entry.timestamp > query.timeRange.end) {
        return false;
      }
    }

    return true;
  }

  private calculateRelevance(entry: MemoryEntry, query: MemoryQuery): number {
    let score = entry.importance;

    // Boost for recency
    const age = Date.now() - entry.timestamp;
    const recencyBoost = Math.max(0, 1 - age / (24 * 60 * 60 * 1000)); // Decay over 24h
    score += recencyBoost * 0.3;

    // Boost for access frequency
    score += Math.min(entry.accessCount * 0.05, 0.2);

    return Math.min(score, 1);
  }

  private calculateTemporalScore(entry: MemoryEntry): number {
    const age = Date.now() - entry.timestamp;
    return Math.max(0, 1 - age / (7 * 24 * 60 * 60 * 1000)); // Decay over 7 days
  }

  private async semanticSearch(query: string, limit = 10): Promise<MemorySearchResult[]> {
    if (!this.config.vector.enabled) return [];

    const queryEmbedding = await this.generateEmbedding(query);
    const results: MemorySearchResult[] = [];

    for (const vector of this.vectorMemory) {
      const similarity = this.cosineSimilarity(queryEmbedding, vector.embedding);

      if (similarity > this.config.vector.similarityThreshold) {
        const entry = this.shortTermMemory.get(vector.id) || this.longTermMemory.get(vector.id);
        if (entry) {
          results.push({
            entry,
            relevanceScore: similarity,
            semanticScore: similarity,
          });
        }
      }
    }

    return results.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, limit);
  }

  private async generateEmbedding(text: string): Promise<number[]> {
    // Simplified - in reality, call OpenAI or similar embedding API
    // For now, return random vector as placeholder
    return Array.from({ length: this.config.vector.dimensions }, () => Math.random() - 0.5);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private async pruneContext(sessionId: string): Promise<void> {
    const context = this.sessionContexts.get(sessionId);
    if (!context) return;

    const strategy = this.config.shortTerm.pruningStrategy;
    const targetTokens = context.maxTokens * 0.8;

    koryLog.info(
      {
        sessionId,
        currentTokens: context.totalTokens,
        targetTokens,
        strategy,
      },
      'Pruning context window',
    );

    switch (strategy) {
      case 'oldest-first':
        this.pruneOldestFirst(context, targetTokens);
        break;
      case 'least-important':
        this.pruneLeastImportant(context, targetTokens);
        break;
      case 'least-accessed':
        this.pruneLeastAccessed(context, targetTokens);
        break;
      case 'summarize':
        await this.pruneWithSummarization(context, targetTokens, sessionId);
        break;
    }

    context.pruned = true;
    this.sessionContexts.set(sessionId, context);
  }

  private pruneOldestFirst(context: ContextWindow, targetTokens: number): void {
    context.entries.sort((a, b) => a.timestamp - b.timestamp);

    while (context.totalTokens > targetTokens && context.entries.length > 0) {
      const removed = context.entries.shift()!;
      context.totalTokens -= removed.tokens;
      this.shortTermMemory.delete(removed.id);
    }
  }

  private pruneLeastImportant(context: ContextWindow, targetTokens: number): void {
    context.entries.sort((a, b) => a.importance - b.importance);

    while (context.totalTokens > targetTokens && context.entries.length > 0) {
      const removed = context.entries.shift()!;
      context.totalTokens -= removed.tokens;
      this.shortTermMemory.delete(removed.id);
    }
  }

  private pruneLeastAccessed(context: ContextWindow, targetTokens: number): void {
    context.entries.sort((a, b) => a.accessCount - b.accessCount);

    while (context.totalTokens > targetTokens && context.entries.length > 0) {
      const removed = context.entries.shift()!;
      context.totalTokens -= removed.tokens;
      this.shortTermMemory.delete(removed.id);
    }
  }

  private async pruneWithSummarization(
    context: ContextWindow,
    targetTokens: number,
    sessionId: string,
  ): Promise<void> {
    // Summarize oldest 50% of entries
    const entriesToSummarize = context.entries.slice(0, Math.floor(context.entries.length / 2));
    const textToSummarize = entriesToSummarize.map((e) => this.formatEntry(e)).join('\n');

    const summary = `[Summary of ${entriesToSummarize.length} entries]`;
    const summaryTokens = Math.floor(summary.length / 4);

    // Remove old entries
    for (const entry of entriesToSummarize) {
      context.totalTokens -= entry.tokens;
      this.shortTermMemory.delete(entry.id);
    }

    // Add summary entry
    const summaryEntry: MemoryEntry = {
      id: `summary-${Date.now()}`,
      content: summary,
      tokens: summaryTokens,
      timestamp: Date.now(),
      sessionId,
      agentId: 'system',
      importance: 0.8,
      metadata: { type: 'summary', tags: ['pruned'] },
      accessCount: 0,
      lastAccessed: Date.now(),
    };

    context.entries = [summaryEntry, ...context.entries.slice(entriesToSummarize.length)];
    context.totalTokens += summaryTokens;
    this.shortTermMemory.set(summaryEntry.id, summaryEntry);
  }

  private evictLongTerm(): void {
    // Evict least important and oldest entry
    let toEvict: MemoryEntry | undefined;
    let lowestScore = Infinity;

    for (const entry of this.longTermMemory.values()) {
      const score = entry.importance + (entry.timestamp / Date.now()) * 0.5;
      if (score < lowestScore) {
        lowestScore = score;
        toEvict = entry;
      }
    }

    if (toEvict) {
      this.longTermMemory.delete(toEvict.id);
    }
  }

  private formatEntry(entry: MemoryEntry): string {
    const role = entry.metadata.type === 'message' ? 'user' : 'assistant';
    return `[${role}]: ${entry.content}`;
  }

  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(
      () => {
        this.cleanup();
      },
      5 * 60 * 1000,
    ); // Every 5 minutes
  }
}

export { DEFAULT_CONFIG as DEFAULT_MEMORY_CONFIG };
