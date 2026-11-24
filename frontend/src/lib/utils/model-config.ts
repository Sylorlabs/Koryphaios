import type { ProviderInfo } from '@koryphaios/shared';

function formatProviderName(provider: string): string {
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'codex') return 'Codex CLI';
  if (provider === 'codex-auth') return 'OpenAI Codex';
  if (provider === 'omnirush') return 'Omnirush';
  if (provider === 'opencode') return 'OpenCode';
  if (provider === 'anthropic') return 'Anthropic';
  if (provider === 'google') return 'Google';
  if (provider === 'aistudio') return 'Google AI Studio';
  if (provider === 'xai') return 'xAI';
  if (provider === 'openrouter') return 'OpenRouter';
  if (provider === 'unorouter') return 'UnoRouter';
  if (provider === 'hundredmillionseek') return '100MillionSeek';
  if (provider === 'numes') return 'Numes';
  if (provider === 'coarena') return 'Coarena';
  if (provider === 'crowllm') return 'CrowLLM';
  if (provider === 'radeon') return 'AMD Radeon Cloud';
  if (provider === 'runcrate') return 'Runcrate';
  if (provider === 'tokenharbor') return 'Token Harbor';
  if (provider === 'logfare') return 'Logfare';
  if (provider === 'apinex') return 'APInex';
  if (provider === 'gwarden') return 'Gwarden AI';
  if (provider === 'respan') return 'Respan';
  if (provider === 'vertexai') return 'Vertex AI';
  if (provider === 'copilot') return 'Copilot';
  if (provider === 'kimicode') return 'Kimi Code';
  if (provider === 'moonshot') return 'Moonshot AI / Kimi API';
  if (provider === 'beam') return 'Reflection AI';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function parseProviderModelSelection(
  value?: string,
  providerNames?: Iterable<string>,
): { provider?: string; model?: string } {
  if (!value || value === 'auto') return {};
  // Custom provider keys are `custom:<slug>` and therefore contain a colon, so
  // a naive first-colon split yields provider `custom` plus garbage. Prefer an
  // exact longest-prefix match against the known provider list when available.
  if (providerNames) {
    let best: string | undefined;
    for (const name of providerNames) {
      if (!name) continue;
      if (value === name || value.startsWith(`${name}:`)) {
        if (!best || name.length > best.length) best = name;
      }
    }
    if (best) {
      const rest = value.slice(best.length + 1);
      return rest ? { provider: best, model: rest } : {};
    }
  }
  // Fallback without a provider list: only `custom:` keys contain a colon, and
  // their slug never does, so the model starts after the second colon.
  if (value.startsWith('custom:')) {
    const separator = value.indexOf(':', 'custom:'.length);
    if (separator === -1) return {};
    const model = value.slice(separator + 1);
    return model ? { provider: value.slice(0, separator), model } : {};
  }
  const separator = value.indexOf(':');
  if (separator === -1) return {};
  return {
    provider: value.slice(0, separator),
    model: value.slice(separator + 1),
  };
}

export function canAttemptProvider(provider: ProviderInfo): boolean {
  return (
    provider.enabled &&
    (provider.adapterAvailable ?? provider.authenticated) &&
    provider.connectionState !== 'unavailable'
  );
}

/**
 * A manual selection is valid only while the provider reports that exact model
 * as enabled.  Keep this separate from Auto: Auto is resolved by the backend,
 * while a manual choice must never silently point at a disabled model.
 */
export function isEnabledModelSelection(providers: ProviderInfo[], value?: string): boolean {
  const { provider, model } = parseProviderModelSelection(
    value,
    providers.map((item) => item.name),
  );
  if (!provider || !model) return false;
  const selectedProvider = providers.find((item) => item.name === provider);
  if (!selectedProvider || !canAttemptProvider(selectedProvider)) return false;
  if (selectedProvider.models.includes(model)) return true;
  // Superseded ids stay selectable when the catalog records them as aliases:
  // a chat saved on a collapsed id (e.g. a legacy Devin `fusion-…` pairing
  // slug) resolves to the current model rather than "no longer available".
  const catalog = (
    selectedProvider as { allAvailableModels?: Array<{ id: string; aliases?: string[] }> }
  ).allAvailableModels;
  const resolved = catalog?.find((m) => m.id === model || m.aliases?.includes(model));
  if (!resolved) return false;
  // An empty enabled list means the provider exposes its whole catalog — the
  // model picker applies the same rule.
  return selectedProvider.models.length === 0 || selectedProvider.models.includes(resolved.id);
}

export function getModelConfigurationWarning(
  providers: ProviderInfo[],
  preferredModel?: string,
): string | null {
  const configuredProviders = providers.filter(canAttemptProvider);
  if (configuredProviders.length === 0) {
    return 'No provider is configured. Open Settings → Providers and configure one before chatting.';
  }

  const { provider, model } = parseProviderModelSelection(
    preferredModel,
    providers.map((item) => item.name),
  );
  if (provider && model) {
    if (!isEnabledModelSelection(providers, preferredModel)) {
      return `${model} is no longer available for ${formatProviderName(provider)}. Select another model in the composer.`;
    }
  }

  const enabledModelCount = configuredProviders.reduce(
    (count, current) => count + current.models.length,
    0,
  );
  if (enabledModelCount === 0) {
    return 'No models are enabled for your configured providers. Open Settings -> Manage Models and enable at least one model.';
  }

  return null;
}
