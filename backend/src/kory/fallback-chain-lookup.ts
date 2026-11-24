/**
 * Route-side view of a fallback chain: the live provider registry answers
 * whether each step can run, and the steps are described for the UI.
 */

import type { FallbackChain, ProviderName } from '@koryphaios/shared';
import { getContext } from '../context';
import { UNSUPPORTED_CHAT_PROVIDER_NAMES } from '../providers/registry';
import {
  describeFallbackStep,
  type FallbackProviderLookup,
  type FallbackStepStatus,
} from './fallback-chain-check';

export function runtimeFallbackLookup(): FallbackProviderLookup {
  const registry = getContext().providers;
  return {
    isChatProvider: (name) =>
      !UNSUPPORTED_CHAT_PROVIDER_NAMES.has(name as ProviderName) &&
      registry.get(name as ProviderName) !== undefined,
    isConnected: (name) => registry.get(name as ProviderName)?.isAvailable() === true,
    listModelIds: (name) => registry.get(name as ProviderName)?.listModels().map((model) => model.id),
  };
}

/** A saved chain plus the live status of each of its steps. */
export function describeFallbackChain(chain: FallbackChain, lookup: FallbackProviderLookup) {
  const stepStatuses: FallbackStepStatus[] = chain.steps.map((step) =>
    describeFallbackStep(step, lookup),
  );
  return { ...chain, stepStatuses };
}
