/**
 * CostOptimizationService - Smart Routing and Caching for Cost Reduction
 *
 * Provides intelligent cost optimization through:
 * - Smart model routing based on task complexity
 * - Response caching with semantic similarity
 * - Token usage optimization
 * - Budget tracking and alerts
 * - Automatic model downgrading for simple tasks
 *
 * Features:
 * - Complexity-based routing (classification -> cheap model, reasoning -> powerful)
 * - Semantic caching with configurable TTL
 * - Request deduplication
 * - Budget enforcement with hard/soft limits
 * - Cost analytics and reporting
 */

import { koryLog } from '../../logger';
import type { ProviderRegistry } from '../../providers';
import type { ProviderName } from '@koryphaios/shared';

export interface ModelCapability {
  model: string;
  provider: ProviderName;
  maxTokens: number;
  costPer1KInput: number;
  costPer1KOutput: number;
  capabilities: {
    reasoning: 'low' | 'medium' | 'high';
    coding: 'low' | 'medium' | 'high';
    analysis: 'low' | 'medium' | 'high';
    creativity: 'low' | 'medium' | 'high';
    contextWindow: number;
  };
  suitableFor: TaskType[];
}

export type TaskType =
  | 'classification'
  | 'summarization'
  | 'extraction'
  | 'generation'
  | 'reasoning'
  | 'coding'
  | 'analysis'
  | 'chat';

export interface TaskProfile {
  type: TaskType;
  complexity: 'low' | 'medium' | 'high';
  estimatedTokens: number;
  requiresReasoning: boolean;
  requiresCode: boolean;
  contextSensitive: boolean;
}

export interface CachedResponse {
  id: string;
  query: string;
  queryEmbedding?: number[];
  response: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  timestamp: number;
  ttlMs: number;
  accessCount: number;
  tags: string[];
}

export interface RoutingDecision {
  model: string;
  provider: ProviderName;
  estimatedCost: number;
  estimatedTokens: number;
  reason: string;
  cached?: boolean;
  cacheHit?: boolean;
}

export interface BudgetConfig {
  dailyLimit: number;
  monthlyLimit: number;
  perRequestLimit: number;
  alertThreshold: number; // 0-1 percentage
  hardLimit: boolean;
}

export interface UsageMetrics {
  date: string;
  totalRequests: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  cacheHits: number;
  cacheMisses: number;
  savingsFromCache: number;
  savingsFromRouting: number;
}

export interface CacheConfig {
  enabled: boolean;
  defaultTTLMs: number;
  maxSize: number;
  similarityThreshold: number;
  enableSemanticCache: boolean;
}

export interface CostOptimizationConfig {
  routing: {
    enabled: boolean;
    defaultModel: string;
    defaultProvider: ProviderName;
    complexityThresholds: {
      low: number; // Token threshold for low complexity
      medium: number; // Token threshold for medium complexity
    };
  };
  cache: CacheConfig;
  budget: BudgetConfig;
  deduplication: {
    enabled: boolean;
    windowMs: number;
  };
}

const DEFAULT_MODELS: ModelCapability[] = [
  {
    model: 'gpt-4o-mini',
    provider: 'openai',
    maxTokens: 128000,
    costPer1KInput: 0.00015,
    costPer1KOutput: 0.0006,
    capabilities: {
      reasoning: 'medium',
      coding: 'medium',
      analysis: 'medium',
      creativity: 'medium',
      contextWindow: 128000,
    },
    suitableFor: ['classification', 'summarization', 'extraction', 'chat'],
  },
  {
    model: 'claude-3-7-sonnet',
    provider: 'anthropic',
    maxTokens: 200000,
    costPer1KInput: 0.003,
    costPer1KOutput: 0.015,
    capabilities: {
      reasoning: 'high',
      coding: 'high',
      analysis: 'high',
      creativity: 'high',
      contextWindow: 200000,
    },
    suitableFor: ['reasoning', 'coding', 'analysis', 'generation'],
  },
  {
    model: 'gemini-2.0-flash',
    provider: 'google',
    maxTokens: 1000000,
    costPer1KInput: 0.000075,
    costPer1KOutput: 0.0003,
    capabilities: {
      reasoning: 'medium',
      coding: 'medium',
      analysis: 'medium',
      creativity: 'medium',
      contextWindow: 1000000,
    },
    suitableFor: ['summarization', 'extraction', 'classification'],
  },
];

const DEFAULT_CONFIG: CostOptimizationConfig = {
  routing: {
    enabled: true,
    defaultModel: 'claude-3-7-sonnet',
    defaultProvider: 'anthropic',
    complexityThresholds: {
      low: 500,
      medium: 2000,
    },
  },
  cache: {
    enabled: true,
    defaultTTLMs: 60 * 60 * 1000, // 1 hour
    maxSize: 10000,
    similarityThreshold: 0.95,
    enableSemanticCache: true,
  },
  budget: {
    dailyLimit: 50, // $50/day
    monthlyLimit: 500, // $500/month
    perRequestLimit: 5, // $5/request
    alertThreshold: 0.8, // 80%
    hardLimit: false,
  },
  deduplication: {
    enabled: true,
    windowMs: 5000, // 5 seconds
  },
};

export class CostOptimizationService {
  private config: CostOptimizationConfig;
  private models: ModelCapability[];
  private providers: ProviderRegistry;
  private cache = new Map<string, CachedResponse>();
  private pendingRequests = new Map<string, Promise<unknown>>();
  private usageHistory: UsageMetrics[] = [];
  private dailyUsage = new Map<string, number>(); // date -> cost
  private monthlyUsage = new Map<string, number>(); // month -> cost
  private alertSent = false;

  constructor(
    providers: ProviderRegistry,
    config?: Partial<CostOptimizationConfig>,
    models?: ModelCapability[],
  ) {
    this.providers = providers;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.models = models || DEFAULT_MODELS;
  }

  /**
   * Determine the optimal model for a task
   */
  async routeTask(
    prompt: string,
    preferredModel?: string,
    forceModel?: boolean,
  ): Promise<RoutingDecision> {
    // If forced, use preferred model
    if (forceModel && preferredModel) {
      const model = this.findModel(preferredModel);
      if (model) {
        return {
          model: model.model,
          provider: model.provider,
          estimatedCost: this.estimateCost(model, prompt.length / 4),
          estimatedTokens: prompt.length / 4,
          reason: 'User-specified model',
        };
      }
    }

    // Check cache first
    if (this.config.cache.enabled) {
      const cached = await this.checkCache(prompt);
      if (cached) {
        return {
          model: cached.model,
          provider: this.findModel(cached.model)?.provider || 'openai',
          estimatedCost: 0,
          estimatedTokens: cached.tokensOut,
          reason: 'Cache hit',
          cached: true,
          cacheHit: true,
        };
      }
    }

    // Analyze task complexity
    const profile = this.analyzeTaskProfile(prompt);

    // Select appropriate model
    const selectedModel = this.selectModelForTask(profile, preferredModel);
    const estimatedTokens = this.estimateTokens(prompt, profile.type);
    const estimatedCost = this.estimateCost(selectedModel, estimatedTokens);

    // Check budget constraints
    const budgetStatus = this.checkBudget(estimatedCost);
    if (!budgetStatus.allowed) {
      if (budgetStatus.suggestAlternative) {
        // Try to find cheaper model
        const cheaperModel = this.findCheaperModel(selectedModel, profile);
        if (cheaperModel && cheaperModel.model !== selectedModel.model) {
          return {
            model: cheaperModel.model,
            provider: cheaperModel.provider,
            estimatedCost: this.estimateCost(cheaperModel, estimatedTokens),
            estimatedTokens,
            reason: `Budget constraint - downgraded from ${selectedModel.model}`,
          };
        }
      }

      if (this.config.budget.hardLimit) {
        throw new Error(`Budget limit exceeded: ${budgetStatus.reason}`);
      }
    }

    return {
      model: selectedModel.model,
      provider: selectedModel.provider,
      estimatedCost,
      estimatedTokens,
      reason: `Selected for ${profile.complexity} complexity ${profile.type} task`,
    };
  }

  /**
   * Analyze task profile from prompt
   */
  analyzeTaskProfile(prompt: string): TaskProfile {
    const tokens = prompt.length / 4; // Rough estimate
    const lowerPrompt = prompt.toLowerCase();

    // Determine task type
    let type: TaskType = 'chat';
    if (lowerPrompt.includes('classify') || lowerPrompt.includes('category')) {
      type = 'classification';
    } else if (lowerPrompt.includes('summarize') || lowerPrompt.includes('summary')) {
      type = 'summarization';
    } else if (lowerPrompt.includes('extract') || lowerPrompt.includes('parse')) {
      type = 'extraction';
    } else if (lowerPrompt.includes('write') || lowerPrompt.includes('generate')) {
      type = 'generation';
    } else if (lowerPrompt.includes('analyze') || lowerPrompt.includes('compare')) {
      type = 'analysis';
    } else if (
      lowerPrompt.includes('code') ||
      lowerPrompt.includes('function') ||
      lowerPrompt.includes('implement')
    ) {
      type = 'coding';
    } else if (
      lowerPrompt.includes('explain') ||
      lowerPrompt.includes('why') ||
      lowerPrompt.includes('reason')
    ) {
      type = 'reasoning';
    }

    // Determine complexity
    let complexity: TaskProfile['complexity'] = 'low';
    if (tokens > this.config.routing.complexityThresholds.medium) {
      complexity = 'high';
    } else if (tokens > this.config.routing.complexityThresholds.low) {
      complexity = 'medium';
    }

    // Check for reasoning indicators
    const reasoningIndicators = [
      'explain',
      'why',
      'how',
      'reason',
      'analyze',
      'compare',
      'evaluate',
      'step by step',
      'think through',
      'logic',
      'complex',
      'difficult',
    ];
    const requiresReasoning = reasoningIndicators.some((i) => lowerPrompt.includes(i));

    // Check for code indicators
    const codeIndicators = [
      'code',
      'function',
      'class',
      'implement',
      'refactor',
      'debug',
      'typescript',
      'javascript',
      'python',
      'rust',
      'go',
    ];
    const requiresCode = codeIndicators.some((i) => lowerPrompt.includes(i));

    return {
      type,
      complexity,
      estimatedTokens: tokens,
      requiresReasoning,
      requiresCode,
      contextSensitive: lowerPrompt.includes('context') || lowerPrompt.includes('previous'),
    };
  }

  /**
   * Check cache for a similar query
   */
  async checkCache(query: string): Promise<CachedResponse | undefined> {
    if (!this.config.cache.enabled) return undefined;

    const queryKey = this.hashQuery(query);
    const exactMatch = this.cache.get(queryKey);

    if (exactMatch && !this.isExpired(exactMatch)) {
      exactMatch.accessCount++;
      koryLog.debug({ cacheId: exactMatch.id }, 'Exact cache hit');
      return exactMatch;
    }

    // Check semantic similarity
    if (this.config.cache.enableSemanticCache) {
      const semanticMatch = await this.findSemanticMatch(query);
      if (semanticMatch) {
        semanticMatch.accessCount++;
        koryLog.debug({ cacheId: semanticMatch.id, similarity: 'semantic' }, 'Semantic cache hit');
        return semanticMatch;
      }
    }

    return undefined;
  }

  /**
   * Store response in cache
   */
  storeInCache(
    query: string,
    response: string,
    model: string,
    tokensIn: number,
    tokensOut: number,
    tags: string[] = [],
  ): void {
    if (!this.config.cache.enabled) return;

    // Evict if at capacity
    if (this.cache.size >= this.config.cache.maxSize) {
      this.evictOldest();
    }

    const modelInfo = this.findModel(model);
    const cost = modelInfo
      ? (tokensIn / 1000) * modelInfo.costPer1KInput +
        (tokensOut / 1000) * modelInfo.costPer1KOutput
      : 0;

    const cached: CachedResponse = {
      id: `cache-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      query,
      response,
      model,
      tokensIn,
      tokensOut,
      cost,
      timestamp: Date.now(),
      ttlMs: this.config.cache.defaultTTLMs,
      accessCount: 1,
      tags,
    };

    const key = this.hashQuery(query);
    this.cache.set(key, cached);

    koryLog.debug({ cacheId: cached.id, cost }, 'Response cached');
  }

  /**
   * Record usage and update budget tracking
   */
  recordUsage(cost: number, tokensIn: number, tokensOut: number): void {
    const now = new Date();
    const dateKey = now.toISOString().split('T')[0];
    const monthKey = dateKey.substring(0, 7);

    // Update daily usage
    const currentDaily = this.dailyUsage.get(dateKey) || 0;
    this.dailyUsage.set(dateKey, currentDaily + cost);

    // Update monthly usage
    const currentMonthly = this.monthlyUsage.get(monthKey) || 0;
    this.monthlyUsage.set(monthKey, currentMonthly + cost);

    // Update metrics
    const today = this.getOrCreateTodayMetrics();
    today.totalRequests++;
    today.totalTokensIn += tokensIn;
    today.totalTokensOut += tokensOut;
    today.totalCost += cost;

    // Check budget thresholds
    this.checkBudgetAlerts(dateKey, monthKey);
  }

  /**
   * Record cache hit savings
   */
  recordCacheHit(savedCost: number): void {
    const today = this.getOrCreateTodayMetrics();
    today.cacheHits++;
    today.savingsFromCache += savedCost;
  }

  /**
   * Get current budget status
   */
  getBudgetStatus(): {
    dailyUsed: number;
    dailyLimit: number;
    dailyRemaining: number;
    monthlyUsed: number;
    monthlyLimit: number;
    monthlyRemaining: number;
    alertTriggered: boolean;
  } {
    const dateKey = new Date().toISOString().split('T')[0];
    const monthKey = dateKey.substring(0, 7);

    const dailyUsed = this.dailyUsage.get(dateKey) || 0;
    const monthlyUsed = this.monthlyUsage.get(monthKey) || 0;

    return {
      dailyUsed,
      dailyLimit: this.config.budget.dailyLimit,
      dailyRemaining: Math.max(0, this.config.budget.dailyLimit - dailyUsed),
      monthlyUsed,
      monthlyLimit: this.config.budget.monthlyLimit,
      monthlyRemaining: Math.max(0, this.config.budget.monthlyLimit - monthlyUsed),
      alertTriggered: this.alertSent,
    };
  }

  /**
   * Get usage analytics
   */
  getAnalytics(days = 30): {
    totalCost: number;
    totalRequests: number;
    avgCostPerRequest: number;
    totalSavings: number;
    cacheHitRate: number;
    dailyBreakdown: UsageMetrics[];
  } {
    const recentMetrics = this.usageHistory.slice(-days);

    const totalCost = recentMetrics.reduce((sum, m) => sum + m.totalCost, 0);
    const totalRequests = recentMetrics.reduce((sum, m) => sum + m.totalRequests, 0);
    const totalSavings = recentMetrics.reduce(
      (sum, m) => sum + m.savingsFromCache + m.savingsFromRouting,
      0,
    );
    const totalCacheHits = recentMetrics.reduce((sum, m) => sum + m.cacheHits, 0);
    const totalCacheMisses = recentMetrics.reduce((sum, m) => sum + m.cacheMisses, 0);

    return {
      totalCost,
      totalRequests,
      avgCostPerRequest: totalRequests > 0 ? totalCost / totalRequests : 0,
      totalSavings,
      cacheHitRate:
        totalCacheHits + totalCacheMisses > 0
          ? totalCacheHits / (totalCacheHits + totalCacheMisses)
          : 0,
      dailyBreakdown: recentMetrics,
    };
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    size: number;
    maxSize: number;
    totalSavings: number;
    hitRate: number;
    avgAccessCount: number;
  } {
    const entries = Array.from(this.cache.values());
    const totalSavings = entries.reduce((sum, e) => sum + e.cost * e.accessCount, 0);
    const avgAccessCount =
      entries.length > 0 ? entries.reduce((sum, e) => sum + e.accessCount, 0) / entries.length : 0;

    return {
      size: this.cache.size,
      maxSize: this.config.cache.maxSize,
      totalSavings,
      hitRate: 0, // Would need to track total requests
      avgAccessCount,
    };
  }

  // ─── Private Methods ───────────────────────────────────────────────────────────

  private findModel(modelName: string): ModelCapability | undefined {
    return this.models.find((m) => m.model === modelName || m.model.includes(modelName));
  }

  private selectModelForTask(profile: TaskProfile, preferredModel?: string): ModelCapability {
    // If we have a preferred model that can handle this task, use it
    if (preferredModel) {
      const preferred = this.findModel(preferredModel);
      if (preferred && this.canHandleTask(preferred, profile)) {
        return preferred;
      }
    }

    // Filter models by capability
    const candidates = this.models.filter((m) => this.canHandleTask(m, profile));

    if (candidates.length === 0) {
      // Fallback to default
      return this.findModel(this.config.routing.defaultModel)!;
    }

    // Sort by cost (cheapest first)
    candidates.sort((a, b) => {
      const costA = a.costPer1KInput + a.costPer1KOutput;
      const costB = b.costPer1KInput + b.costPer1KOutput;
      return costA - costB;
    });

    return candidates[0];
  }

  private canHandleTask(model: ModelCapability, profile: TaskProfile): boolean {
    // Check if model has required capabilities
    if (profile.requiresReasoning && model.capabilities.reasoning !== 'high') {
      return false;
    }
    if (profile.requiresCode && model.capabilities.coding !== 'high') {
      return false;
    }

    // Check if task type is in suitable list
    return model.suitableFor.includes(profile.type) || profile.complexity === 'low';
  }

  private findCheaperModel(
    current: ModelCapability,
    profile: TaskProfile,
  ): ModelCapability | undefined {
    const candidates = this.models.filter((m) => {
      if (m.model === current.model) return false;
      const currentCost = current.costPer1KInput + current.costPer1KOutput;
      const candidateCost = m.costPer1KInput + m.costPer1KOutput;
      return candidateCost < currentCost && this.canHandleTask(m, profile);
    });

    candidates.sort((a, b) => {
      const costA = a.costPer1KInput + a.costPer1KOutput;
      const costB = b.costPer1KInput + b.costPer1KOutput;
      return costA - costB;
    });

    return candidates[0];
  }

  private estimateTokens(prompt: string, taskType: TaskType): number {
    const baseTokens = prompt.length / 4;

    // Adjust based on task type typical output
    const outputMultipliers: Record<TaskType, number> = {
      classification: 0.1,
      summarization: 0.3,
      extraction: 0.5,
      generation: 1.5,
      reasoning: 1.2,
      coding: 1.3,
      analysis: 1.0,
      chat: 0.8,
    };

    return baseTokens * (1 + outputMultipliers[taskType]);
  }

  private estimateCost(model: ModelCapability, tokens: number): number {
    const inputCost = tokens * (model.costPer1KInput / 1000);
    const outputCost = tokens * 0.5 * (model.costPer1KOutput / 1000); // Assume 50% output
    return inputCost + outputCost;
  }

  private checkBudget(estimatedCost: number): {
    allowed: boolean;
    reason?: string;
    suggestAlternative?: boolean;
  } {
    const status = this.getBudgetStatus();

    if (estimatedCost > this.config.budget.perRequestLimit) {
      return {
        allowed: false,
        reason: `Per-request limit ($${this.config.budget.perRequestLimit}) exceeded`,
        suggestAlternative: true,
      };
    }

    if (status.dailyRemaining < estimatedCost) {
      return {
        allowed: false,
        reason: `Daily budget limit exceeded`,
        suggestAlternative: true,
      };
    }

    if (status.monthlyRemaining < estimatedCost) {
      return {
        allowed: false,
        reason: `Monthly budget limit exceeded`,
        suggestAlternative: true,
      };
    }

    return { allowed: true };
  }

  private checkBudgetAlerts(dateKey: string, monthKey: string): void {
    const status = this.getBudgetStatus();
    const threshold = this.config.budget.alertThreshold;

    if (!this.alertSent) {
      if (
        status.dailyUsed / this.config.budget.dailyLimit > threshold ||
        status.monthlyUsed / this.config.budget.monthlyLimit > threshold
      ) {
        this.alertSent = true;
        koryLog.warn(
          {
            dailyUsage: status.dailyUsed,
            dailyLimit: this.config.budget.dailyLimit,
            monthlyUsage: status.monthlyUsed,
            monthlyLimit: this.config.budget.monthlyLimit,
          },
          'Budget alert threshold reached',
        );
      }
    }

    // Reset alert at start of new day
    if (new Date().getHours() === 0) {
      this.alertSent = false;
    }
  }

  private getOrCreateTodayMetrics(): UsageMetrics {
    const today = new Date().toISOString().split('T')[0];
    let metrics = this.usageHistory.find((m) => m.date === today);

    if (!metrics) {
      metrics = {
        date: today,
        totalRequests: 0,
        totalTokensIn: 0,
        totalTokensOut: 0,
        totalCost: 0,
        cacheHits: 0,
        cacheMisses: 0,
        savingsFromCache: 0,
        savingsFromRouting: 0,
      };
      this.usageHistory.push(metrics);
    }

    return metrics;
  }

  private hashQuery(query: string): string {
    // Simple hash for exact match
    return query.toLowerCase().trim().replace(/\s+/g, ' ');
  }

  private async findSemanticMatch(query: string): Promise<CachedResponse | undefined> {
    // Simplified semantic matching - in reality, use embeddings
    const queryWords = new Set(query.toLowerCase().split(/\s+/));
    let bestMatch: CachedResponse | undefined;
    let bestScore = 0;

    for (const entry of this.cache.values()) {
      if (this.isExpired(entry)) continue;

      const entryWords = new Set(entry.query.toLowerCase().split(/\s+/));
      const intersection = new Set([...queryWords].filter((x) => entryWords.has(x)));
      const score = intersection.size / Math.max(queryWords.size, entryWords.size);

      if (score > bestScore && score > this.config.cache.similarityThreshold) {
        bestScore = score;
        bestMatch = entry;
      }
    }

    return bestMatch;
  }

  private isExpired(entry: CachedResponse): boolean {
    return Date.now() - entry.timestamp > entry.ttlMs;
  }

  private evictOldest(): void {
    let oldest: CachedResponse | undefined;
    let oldestTime = Infinity;

    for (const entry of this.cache.values()) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldest = entry;
      }
    }

    if (oldest) {
      this.cache.delete(this.hashQuery(oldest.query));
    }
  }
}

export { DEFAULT_CONFIG as DEFAULT_COST_CONFIG, DEFAULT_MODELS };
