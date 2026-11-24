/**
 * Parse fallback steps from tool, route and stored input. Accepts the current
 * `{provider, model, reasoningLevel, label}` shape and the legacy
 * `{ model: 'provider:model' }` shape that delegate_to_worker and set_controls
 * shipped with. A legacy `provider:model` is split with the provider-key rules,
 * so `custom:name:model` keeps its prefix.
 */

import { normalizeFallbackStep, type FallbackStep } from '@koryphaios/shared';
import { splitProviderKey } from '../providers/provider-key';

export function normalizeFallbackStepInput(raw: unknown): FallbackStep | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const model = typeof record.model === 'string' ? record.model.trim() : '';
  if (!model) return undefined;
  const explicitProvider = typeof record.provider === 'string' ? record.provider.trim() : '';
  const split = explicitProvider
    ? { provider: explicitProvider, model }
    : model.includes(':')
      ? { provider: splitProviderKey(model).provider as string, model: splitProviderKey(model).model }
      : { provider: '', model };
  return normalizeFallbackStep({
    provider: split.provider,
    model: split.model,
    reasoningLevel: record.reasoningLevel,
    label: record.label,
  });
}

export function normalizeFallbackStepsInput(raw: unknown, max = 20): FallbackStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: FallbackStep[] = [];
  for (const entry of raw) {
    const step = normalizeFallbackStepInput(entry);
    if (step) steps.push(step);
    if (steps.length >= max) break;
  }
  return steps;
}
