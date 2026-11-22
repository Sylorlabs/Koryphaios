import type { WorkerDomain } from '@koryphaios/shared';

/** The provider rows the manager needs to describe reachable worker models. */
export interface DelegationProviderStatus {
  name: string;
  models: readonly string[];
  adapterAvailable: boolean;
}

export interface DelegationPromptContext {
  available: boolean;
  reason?: string;
  /** Plan mode: delegation is for investigation and design, not implementation. */
  planning?: boolean;
  /** Chat's worker-isolation preset: 'auto' defers to the worktree argument,
   *  'always'/'never' are the user's fixed choice and ignore it. */
  worktreeMode?: 'auto' | 'always' | 'never';
  pools: Array<{ domain: string; models: string[]; unrestricted?: boolean }>;
}

const WORKER_DOMAINS: readonly WorkerDomain[] = ['general', 'ui', 'backend', 'test', 'review'];

/**
 * Describe the delegation surface the manager can actually use this turn.
 *
 * The manager cannot pick a worker category it cannot see. A static
 * instruction ("choose from the user's pool") left it guessing, and an unknown
 * domain silently degraded to `general`. Rendering the real pools, including an
 * empty one, makes the choice explicit instead of hopeful.
 *
 * Plan mode is a planning posture, not a delegation veto: it stays available so
 * the manager can parallelize investigation and design, and the prompt tells it
 * not to delegate implementation yet.
 */
export function buildDelegationPromptContext(input: {
  managerModelAccess?: Record<string, string[]>;
  agentExecutionMode: string;
  interactionMode: string;
  providerStatuses: readonly DelegationProviderStatus[];
  worktreeMode?: 'auto' | 'always' | 'never';
}): DelegationPromptContext {
  const access = input.managerModelAccess ?? {};
  const availableModels = input.providerStatuses
    .filter((status) => status.adapterAvailable)
    .flatMap((status) => status.models.map((model) => `${status.name}:${model}`));

  const pools = WORKER_DOMAINS.map((domain) => {
    const configured =
      access[domain] ?? (domain === 'ui' ? access.frontend : undefined) ?? [];
    return configured.length
      ? { domain, models: [...configured] }
      : { domain, models: [...availableModels], unrestricted: true };
  });

  const worktreeMode = input.worktreeMode;
  if (input.agentExecutionMode === 'single') {
    return { available: false, reason: 'Single-Agent mode', pools, worktreeMode };
  }
  if (availableModels.length === 0) {
    return { available: false, reason: 'no model is reachable for a worker', pools, worktreeMode };
  }
  return {
    available: true,
    pools,
    worktreeMode,
    ...(input.interactionMode === 'plan' ? { planning: true } : {}),
  };
}
