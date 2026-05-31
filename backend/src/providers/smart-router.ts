/**
 * Smart Model Router - Auto-select models based on task
 *
 * Routes to optimal model based on:
 * - Task type (architecture, coding, testing, docs)
 * - Cost/speed/quality preferences
 * - Historical performance
 */

import type { ProviderName } from '@koryphaios/shared';
import { koryLog } from '../logger';

export type TaskType =
  | 'architecture' // System design, high-level planning
  | 'implementation' // Writing code
  | 'refactoring' // Restructuring existing code
  | 'testing' // Writing tests
  | 'debugging' // Fixing bugs
  | 'documentation' // Writing docs
  | 'review' // Code review
  | 'exploration'; // Learning codebase

export interface ModelProfile {
  id: string;
  provider: ProviderName;
  displayName: string;

  // Capabilities (0-10)
  capabilities: {
    reasoning: number; // Complex logic, planning
    coding: number; // Code generation quality
    contextWindow: number; // Large file handling
    speed: number; // Response time
    costEfficiency: number; // Quality per dollar
  };

  // Cost (cents per 1K tokens)
  costPer1KInput: number;
  costPer1KOutput: number;

  // Preferences
  strengths: TaskType[];
  avoidFor: TaskType[];
}

export interface RoutingDecision {
  model: string;
  provider: ProviderName;
  reasoning: string;
  estimatedCost: number;
  confidence: number;
}

// Model profiles - can be updated as new models release
export const MODEL_PROFILES: ModelProfile[] = [
  {
    id: 'claude-4-opus',
    provider: 'anthropic',
    displayName: 'Claude 4 Opus',
    capabilities: { reasoning: 10, coding: 10, contextWindow: 10, speed: 6, costEfficiency: 5 },
    costPer1KInput: 15.0,
    costPer1KOutput: 75.0,
    strengths: ['architecture', 'refactoring', 'debugging', 'review'],
    avoidFor: ['documentation'],
  },
  {
    id: 'claude-4-sonnet',
    provider: 'anthropic',
    displayName: 'Claude 4 Sonnet',
    capabilities: { reasoning: 8, coding: 9, contextWindow: 10, speed: 7, costEfficiency: 7 },
    costPer1KInput: 3.0,
    costPer1KOutput: 15.0,
    strengths: ['implementation', 'refactoring', 'testing'],
    avoidFor: [],
  },
  {
    id: 'gpt-4-turbo',
    provider: 'openai',
    displayName: 'GPT-4 Turbo',
    capabilities: { reasoning: 9, coding: 9, contextWindow: 9, speed: 7, costEfficiency: 6 },
    costPer1KInput: 10.0,
    costPer1KOutput: 30.0,
    strengths: ['architecture', 'implementation', 'debugging'],
    avoidFor: [],
  },
  {
    id: 'gpt-4o',
    provider: 'openai',
    displayName: 'GPT-4o',
    capabilities: { reasoning: 8, coding: 8, contextWindow: 8, speed: 9, costEfficiency: 8 },
    costPer1KInput: 2.5,
    costPer1KOutput: 10.0,
    strengths: ['implementation', 'testing', 'documentation'],
    avoidFor: ['architecture'],
  },
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    displayName: 'GPT-4o Mini',
    capabilities: { reasoning: 6, coding: 7, contextWindow: 7, speed: 10, costEfficiency: 10 },
    costPer1KInput: 0.15,
    costPer1KOutput: 0.6,
    strengths: ['testing', 'documentation', 'exploration'],
    avoidFor: ['architecture', 'refactoring'],
  },
  {
    id: 'o3-mini',
    provider: 'openai',
    displayName: 'o3 Mini',
    capabilities: { reasoning: 9, coding: 8, contextWindow: 7, speed: 5, costEfficiency: 7 },
    costPer1KInput: 1.1,
    costPer1KOutput: 4.4,
    strengths: ['debugging', 'refactoring', 'review'],
    avoidFor: ['documentation'],
  },
  {
    id: 'gemini-2.5-pro',
    provider: 'google',
    displayName: 'Gemini 2.5 Pro',
    capabilities: { reasoning: 8, coding: 8, contextWindow: 10, speed: 7, costEfficiency: 8 },
    costPer1KInput: 1.25,
    costPer1KOutput: 10.0,
    strengths: ['implementation', 'documentation', 'exploration'],
    avoidFor: [],
  },
  {
    id: 'llama-3.3-70b',
    provider: 'fireworks',
    displayName: 'Llama 3.3 70B',
    capabilities: { reasoning: 7, coding: 7, contextWindow: 8, speed: 8, costEfficiency: 9 },
    costPer1KInput: 0.9,
    costPer1KOutput: 0.9,
    strengths: ['implementation', 'testing'],
    avoidFor: ['architecture'],
  },
];

export interface RouterPreferences {
  prioritize: 'quality' | 'speed' | 'cost';
  maxCostPerRequest?: number;
  preferredProviders?: ProviderName[];
  avoidProviders?: ProviderName[];
}

export class SmartRouter {
  private profiles = new Map<string, ModelProfile>();
  private preferences: RouterPreferences;
  private usageHistory: Array<{
    taskType: TaskType;
    model: string;
    success: boolean;
    duration: number;
    cost: number;
  }> = [];

  constructor(preferences: Partial<RouterPreferences> = {}) {
    this.preferences = {
      prioritize: 'quality',
      ...preferences,
    };

    // Index profiles
    for (const profile of MODEL_PROFILES) {
      this.profiles.set(profile.id, profile);
    }
  }

  /**
   * Route a task to the best model.
   */
  route(taskType: TaskType, prompt: string): RoutingDecision {
    // Score all models for this task
    const scored = Array.from(this.profiles.values())
      .filter((p) => this.isAvailable(p))
      .map((profile) => ({
        profile,
        score: this.scoreModel(profile, taskType, prompt),
      }));

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    const winner = scored[0];
    if (!winner) {
      // Fallback to GPT-4o
      return {
        model: 'gpt-4o',
        provider: 'openai',
        reasoning: 'No suitable model found, using fallback',
        estimatedCost: 0,
        confidence: 0,
      };
    }

    // Estimate cost
    const estimatedTokens = this.estimateTokens(prompt);
    const estimatedCost = this.estimateCost(winner.profile, estimatedTokens);

    return {
      model: winner.profile.id,
      provider: winner.profile.provider,
      reasoning: this.explainChoice(winner.profile, taskType, scored.slice(0, 3)),
      estimatedCost,
      confidence: winner.score / 100,
    };
  }

  /**
   * Score a model for a specific task.
   */
  private scoreModel(profile: ModelProfile, taskType: TaskType, prompt: string): number {
    let score = 0;
    const caps = profile.capabilities;

    // Base score from task fit
    if (profile.strengths.includes(taskType)) {
      score += 30;
    }
    if (profile.avoidFor.includes(taskType)) {
      score -= 20;
    }

    // Add capability scores based on task type
    switch (taskType) {
      case 'architecture':
        score += caps.reasoning * 3 + caps.contextWindow * 2;
        break;
      case 'implementation':
        score += caps.coding * 3 + caps.speed * 2;
        break;
      case 'refactoring':
        score += caps.coding * 2 + caps.reasoning * 2 + caps.contextWindow;
        break;
      case 'debugging':
        score += caps.reasoning * 3 + caps.coding * 2;
        break;
      case 'testing':
        score += caps.coding * 2 + caps.costEfficiency * 2;
        break;
      case 'documentation':
        score += caps.coding + caps.speed * 2 + caps.costEfficiency * 2;
        break;
      case 'review':
        score += caps.reasoning * 3 + caps.contextWindow;
        break;
      case 'exploration':
        score += caps.speed * 3 + caps.costEfficiency * 2;
        break;
    }

    // Apply user preferences
    switch (this.preferences.prioritize) {
      case 'quality':
        score += caps.coding + caps.reasoning;
        break;
      case 'speed':
        score += caps.speed * 2;
        break;
      case 'cost':
        score += caps.costEfficiency * 3;
        break;
    }

    // Provider preferences
    if (this.preferences.preferredProviders?.includes(profile.provider)) {
      score += 10;
    }
    if (this.preferences.avoidProviders?.includes(profile.provider)) {
      score -= 50;
    }

    // Cost cap
    if (this.preferences.maxCostPerRequest) {
      const estimatedCost = this.estimateCost(profile, this.estimateTokens(prompt));
      if (estimatedCost > this.preferences.maxCostPerRequest) {
        score -= 100; // Heavy penalty
      }
    }

    // Historical performance
    const history = this.usageHistory.filter(
      (h) => h.taskType === taskType && h.model === profile.id,
    );
    if (history.length > 0) {
      const successRate = history.filter((h) => h.success).length / history.length;
      score += successRate * 20;
    }

    return score;
  }

  /**
   * Estimate token count for a prompt.
   */
  private estimateTokens(prompt: string): number {
    // Rough estimate: ~4 chars per token
    return Math.ceil(prompt.length / 4);
  }

  /**
   * Estimate cost in cents.
   */
  private estimateCost(
    profile: ModelProfile,
    inputTokens: number,
    outputTokens = inputTokens / 2,
  ): number {
    const inputCost = (inputTokens / 1000) * profile.costPer1KInput;
    const outputCost = (outputTokens / 1000) * profile.costPer1KOutput;
    return inputCost + outputCost;
  }

  /**
   * Check if model is available (has API key, etc).
   */
  private isAvailable(profile: ModelProfile): boolean {
    // Check env var for provider
    const envVar = `${profile.provider.toUpperCase()}_API_KEY`;
    return !!process.env[envVar];
  }

  /**
   * Explain why this model was chosen.
   */
  private explainChoice(
    winner: ModelProfile,
    taskType: TaskType,
    top3: Array<{ profile: ModelProfile; score: number }>,
  ): string {
    const reasons: string[] = [`Best for ${taskType}:`];

    if (winner.strengths.includes(taskType)) {
      reasons.push(`- Specialized strength`);
    }

    switch (this.preferences.prioritize) {
      case 'quality':
        reasons.push(`- Highest quality for this task`);
        break;
      case 'speed':
        reasons.push(`- Fastest response time`);
        break;
      case 'cost':
        reasons.push(`- Most cost-effective`);
        break;
    }

    if (top3.length > 1) {
      const runnerUp = top3[1];
      const diff = top3[0].score - runnerUp.score;
      if (diff < 10) {
        reasons.push(`- Close runner-up: ${runnerUp.profile.displayName}`);
      }
    }

    return reasons.join('\n');
  }

  /**
   * Infer task type from prompt.
   */
  inferTaskType(prompt: string): TaskType {
    const lower = prompt.toLowerCase();

    // Architecture patterns
    if (/design|architecture|structure|pattern|system/i.test(lower)) {
      return 'architecture';
    }

    // Debugging patterns
    if (/fix|bug|error|debug|broken|fails?|crash/i.test(lower)) {
      return 'debugging';
    }

    // Testing patterns
    if (/test|spec|unit test|integration test/i.test(lower)) {
      return 'testing';
    }

    // Refactoring patterns
    if (/refactor|rewrite|restructure|clean up|improve/i.test(lower)) {
      return 'refactoring';
    }

    // Documentation patterns
    if (/document|readme|comment|explain/i.test(lower)) {
      return 'documentation';
    }

    // Review patterns
    if (/review|check|audit|analyze code/i.test(lower)) {
      return 'review';
    }

    // Exploration
    if (/how does|what is|understand|explore/i.test(lower)) {
      return 'exploration';
    }

    // Default to implementation
    return 'implementation';
  }

  /**
   * Route with auto-detected task type.
   */
  autoRoute(prompt: string): RoutingDecision {
    const taskType = this.inferTaskType(prompt);
    return this.route(taskType, prompt);
  }

  /**
   * Record usage for learning.
   */
  recordUsage(
    taskType: TaskType,
    model: string,
    success: boolean,
    duration: number,
    cost: number,
  ): void {
    this.usageHistory.push({ taskType, model, success, duration, cost });

    // Keep last 100 entries
    if (this.usageHistory.length > 100) {
      this.usageHistory = this.usageHistory.slice(-100);
    }

    koryLog.debug({ taskType, model, success }, 'Model usage recorded');
  }

  /**
   * Get recommendations based on history.
   */
  getRecommendations(): Array<{
    taskType: TaskType;
    bestModel: string;
    avgCost: number;
    successRate: number;
  }> {
    const byTask = new Map<TaskType, Array<(typeof this.usageHistory)[0]>>();

    for (const entry of this.usageHistory) {
      if (!byTask.has(entry.taskType)) {
        byTask.set(entry.taskType, []);
      }
      byTask.get(entry.taskType)!.push(entry);
    }

    const recommendations: Array<{
      taskType: TaskType;
      bestModel: string;
      avgCost: number;
      successRate: number;
    }> = [];

    for (const [taskType, entries] of byTask) {
      const byModel = new Map<string, typeof entries>();
      for (const e of entries) {
        if (!byModel.has(e.model)) byModel.set(e.model, []);
        byModel.get(e.model)!.push(e);
      }

      let bestModel = '';
      let bestScore = -Infinity;

      for (const [model, modelEntries] of byModel) {
        const successRate = modelEntries.filter((e) => e.success).length / modelEntries.length;
        const avgCost = modelEntries.reduce((sum, e) => sum + e.cost, 0) / modelEntries.length;
        const score = successRate * 100 - avgCost; // Success weighted by cost

        if (score > bestScore) {
          bestScore = score;
          bestModel = model;
        }
      }

      if (bestModel) {
        const modelEntries = byModel.get(bestModel)!;
        recommendations.push({
          taskType,
          bestModel,
          avgCost: modelEntries.reduce((sum, e) => sum + e.cost, 0) / modelEntries.length,
          successRate: modelEntries.filter((e) => e.success).length / modelEntries.length,
        });
      }
    }

    return recommendations;
  }

  /**
   * Update preferences.
   */
  updatePreferences(prefs: Partial<RouterPreferences>): void {
    this.preferences = { ...this.preferences, ...prefs };
  }
}

export const smartRouter = new SmartRouter();
