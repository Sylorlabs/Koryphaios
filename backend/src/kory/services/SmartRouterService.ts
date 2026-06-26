/**
 * SmartRouterService
 *
 * Task-aware, pricing-aware model routing for Auto mode.
 * Replaces static DOMAIN.DEFAULT_MODELS fallback with scored candidate selection
 * derived from the live MODEL_CATALOG + authenticated ProviderRegistry state.
 */

import type { WorkerDomain, ProviderName, ModelTier } from '@koryphaios/shared';
import { MODEL_CATALOG } from '../../providers/models';
import { DOMAIN } from '../../constants';
import { koryLog } from '../../logger';
import type { ProviderRegistry } from '../../providers/registry';

export type TaskType =
  | 'architecture'
  | 'implementation'
  | 'refactoring'
  | 'testing'
  | 'debugging'
  | 'documentation'
  | 'review'
  | 'exploration';

export interface SmartRoutingDecision {
  model: string;
  provider: ProviderName;
  reasoning: string;
  taskType?: TaskType;
  auto: boolean;
}

interface Candidate {
  modelId: string;
  provider: ProviderName;
  tier: ModelTier | undefined;
  canReason: boolean;
  costPerMInput: number;
  isFree: boolean;
}

// Keywords per task type for prompt classification
const TASK_KEYWORDS: Record<TaskType, string[]> = {
  architecture: [
    'design', 'architect', 'system', 'structure', 'plan', 'high-level', 'diagram',
    'scalab', 'pattern', 'abstraction', 'interface', 'schema', 'modeling',
  ],
  implementation: [
    'implement', 'write', 'create', 'build', 'add feature', 'add a', 'new function',
    'make', 'develop', 'code', 'generate',
  ],
  refactoring: [
    'refactor', 'restructure', 'improve', 'clean', 'optimize', 'rewrite',
    'extract', 'rename', 'move', 'simplify', 'reorganize',
  ],
  testing: [
    'test', 'spec', 'coverage', 'unit test', 'integration test', 'e2e', 'mock',
    'assert', 'snapshot', 'fixture',
  ],
  debugging: [
    'bug', 'fix', 'error', 'crash', 'issue', 'problem', 'failing', 'broken',
    'exception', 'stack trace', 'undefined', 'null pointer', 'regression',
  ],
  documentation: [
    'doc', 'readme', 'comment', 'document', 'explain', 'describe', 'annotate',
    'jsdoc', 'changelog', 'guide', 'tutorial',
  ],
  review: [
    'review', 'audit', 'check', 'assess', 'evaluate', 'feedback', 'lgtm',
    'looks good', 'pull request', 'pr', 'critique',
  ],
  exploration: [
    'how does', 'what is', 'where is', 'show me', 'explain', 'understand',
    'trace', 'walk through', 'which file', 'find', 'locate',
  ],
};

// Tier preference per task type: ordered best-to-acceptable
const TASK_TIER_PREFERENCE: Record<TaskType, ModelTier[]> = {
  architecture: ['reasoning', 'flagship', 'fast', 'cheap'],
  debugging: ['reasoning', 'flagship', 'fast', 'cheap'],
  review: ['reasoning', 'flagship', 'fast', 'cheap'],
  refactoring: ['flagship', 'reasoning', 'fast', 'cheap'],
  implementation: ['flagship', 'fast', 'reasoning', 'cheap'],
  testing: ['fast', 'flagship', 'cheap', 'reasoning'],
  documentation: ['fast', 'cheap', 'flagship', 'reasoning'],
  exploration: ['fast', 'cheap', 'flagship', 'reasoning'],
};

export class SmartRouterService {
  constructor(private providers: ProviderRegistry) {}

  inferTaskType(prompt: string): TaskType {
    const lower = prompt.toLowerCase();
    let best: TaskType = 'implementation';
    let bestScore = 0;

    for (const [taskType, keywords] of Object.entries(TASK_KEYWORDS) as [TaskType, string[]][]) {
      const score = keywords.filter((kw) => lower.includes(kw)).length;
      if (score > bestScore) {
        bestScore = score;
        best = taskType;
      }
    }

    return best;
  }

  inferDomainFromPrompt(prompt: string): WorkerDomain | undefined {
    const lower = prompt.toLowerCase();
    let best: WorkerDomain | undefined;
    let bestScore = 0;

    for (const [domain, keywords] of Object.entries(DOMAIN.KEYWORDS) as unknown as [WorkerDomain, string[]][]) {
      const score = keywords.filter((kw) => lower.includes(kw)).length;
      if (score > bestScore) {
        bestScore = score;
        best = domain;
      }
    }

    return bestScore > 0 ? best : undefined;
  }

  /**
   * Route a request to the best available model.
   * Returns null when no authenticated providers are available (caller handles fallback).
   */
  route(opts: {
    prompt?: string;
    domain?: WorkerDomain;
    preferCheap?: boolean;
  }): SmartRoutingDecision | null {
    const { prompt, preferCheap } = opts;

    const taskType = prompt ? this.inferTaskType(prompt) : 'implementation';
    const tierPreference = preferCheap
      ? (['cheap', 'fast', 'flagship', 'reasoning'] as ModelTier[])
      : TASK_TIER_PREFERENCE[taskType];

    const candidates = this.buildCandidates();
    if (candidates.length === 0) return null;

    // Score candidates: tier rank (primary), cost (secondary), free providers (bonus)
    const tierRank = (tier: ModelTier | undefined): number => {
      const idx = tierPreference.indexOf(tier as ModelTier);
      return idx === -1 ? tierPreference.length : idx; // lower = better
    };

    const scored = candidates.map((c) => ({
      candidate: c,
      score: tierRank(c.tier) * 100 + (c.isFree ? -10 : 0) + c.costPerMInput * 0.01,
    }));

    scored.sort((a, b) => a.score - b.score);
    const winner = scored[0]!.candidate;

    const reasoning = this.buildReasoning(winner, taskType, tierPreference[0]!);

    koryLog.info(
      {
        event: 'routing_decision',
        auto: true,
        model: winner.modelId,
        provider: winner.provider,
        taskType,
        tier: winner.tier,
        candidatesConsidered: candidates.length,
        preferCheap: !!preferCheap,
      },
      'Smart router decision',
    );

    return {
      model: winner.modelId,
      provider: winner.provider,
      reasoning,
      taskType,
      auto: true,
    };
  }

  private buildCandidates(): Candidate[] {
    const statuses = this.providers.getStatus();
    const candidates: Candidate[] = [];

    for (const status of statuses) {
      if (!status.authenticated || !status.enabled || status.circuitOpen) continue;

      for (const modelId of status.models) {
        const def = MODEL_CATALOG[modelId];
        if (!def || def.deprecated) continue;

        candidates.push({
          modelId,
          provider: status.name,
          tier: def.tier,
          canReason: def.canReason ?? false,
          costPerMInput: def.costPerMInputTokens ?? 0,
          isFree: (def.costPerMInputTokens ?? 0) === 0,
        });
      }
    }

    return candidates;
  }

  private buildReasoning(winner: Candidate, taskType: TaskType, preferredTier: ModelTier): string {
    const tierLabel = winner.tier ?? 'unknown tier';
    const isFree = winner.isFree ? ' (free/subscription)' : '';
    const tierMatch = winner.tier === preferredTier;
    const tierNote = tierMatch
      ? `best tier for ${taskType}`
      : `${tierLabel} tier, best available for ${taskType}`;
    return `Auto → ${winner.provider}:${winner.modelId} · ${taskType} · ${tierNote}${isFree}`;
  }
}
