/**
 * Save-time checks for fallback-chain steps. A step whose provider is not
 * connected is allowed (flagged `provider_disconnected`) so a chain can be
 * prepared before its provider is set up; it is skipped at runtime. A step
 * naming a provider that cannot chat, or a model a connected provider does not
 * offer, is rejected.
 */

import type { FallbackStep } from '@koryphaios/shared';

export type FallbackStepStatus =
  | 'ready'
  | 'provider_disconnected'
  | 'model_unverified'
  | 'model_unavailable'
  | 'not_chat_provider'
  | 'missing_provider';

/** Statuses that block a save. Everything else is saved, possibly with a warning. */
const BLOCKING: ReadonlySet<FallbackStepStatus> = new Set([
  'model_unavailable',
  'not_chat_provider',
  'missing_provider',
]);

export interface FallbackProviderLookup {
  /** True for a provider that can run chat turns (not a capability-only adapter). */
  isChatProvider(name: string): boolean;
  isConnected(name: string): boolean;
  /** Model ids the provider currently offers, or undefined when unknown. */
  listModelIds(name: string): string[] | undefined;
}

export function describeFallbackStep(
  step: Pick<FallbackStep, 'provider' | 'model'>,
  lookup: FallbackProviderLookup,
): FallbackStepStatus {
  if (!step.provider) return 'missing_provider';
  if (!lookup.isChatProvider(step.provider)) return 'not_chat_provider';
  if (!lookup.isConnected(step.provider)) return 'provider_disconnected';
  const ids = lookup.listModelIds(step.provider);
  if (!ids || ids.length === 0) return 'model_unverified';
  return ids.includes(step.model) ? 'ready' : 'model_unavailable';
}

export type FallbackStepCheck =
  { ok: true; statuses: FallbackStepStatus[] } | { ok: false; stepIndex: number; error: string };

export function checkFallbackSteps(
  steps: readonly FallbackStep[],
  lookup: FallbackProviderLookup,
): FallbackStepCheck {
  const statuses: FallbackStepStatus[] = [];
  for (const [stepIndex, step] of steps.entries()) {
    const status = describeFallbackStep(step, lookup);
    if (BLOCKING.has(status)) {
      return { ok: false, stepIndex, error: fallbackStepError(stepIndex, step, status) };
    }
    statuses.push(status);
  }
  return { ok: true, statuses };
}

function fallbackStepError(
  stepIndex: number,
  step: FallbackStep,
  status: FallbackStepStatus,
): string {
  const position = `Step ${stepIndex + 1}`;
  if (status === 'missing_provider') return `${position} needs a provider.`;
  if (status === 'not_chat_provider') {
    return `${position}: ${step.provider} cannot run chat turns, so it cannot be a fallback.`;
  }
  return `${position}: ${step.model} is not a chat model offered by ${step.provider}.`;
}
