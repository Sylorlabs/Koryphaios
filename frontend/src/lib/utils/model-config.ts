import type { ProviderInfo } from '@koryphaios/shared';

function formatProviderName(provider: string): string {
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'codex') return 'Codex CLI';
  if (provider === 'codex-auth') return 'OpenAI Codex';
  if (provider === 'anthropic') return 'Anthropic';
  if (provider === 'google') return 'Google';
  if (provider === 'aistudio') return 'Google AI Studio';
  if (provider === 'xai') return 'xAI';
  if (provider === 'openrouter') return 'OpenRouter';
  if (provider === 'vertexai') return 'Vertex AI';
  if (provider === 'copilot') return 'Copilot';
  if (provider === 'kimicode') return 'Kimi Code';
  if (provider === 'moonshot') return 'Moonshot AI / Kimi API';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function parseProviderModelSelection(value?: string): { provider?: string; model?: string } {
  if (!value || value === 'auto') return {};
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
  const { provider, model } = parseProviderModelSelection(value);
  if (!provider || !model) return false;
  const selectedProvider = providers.find((item) => item.name === provider);
  return (
    !!selectedProvider &&
    canAttemptProvider(selectedProvider) &&
    selectedProvider.models.includes(model)
  );
}

export function getModelConfigurationWarning(
  providers: ProviderInfo[],
  preferredModel?: string,
): string | null {
  const configuredProviders = providers.filter(canAttemptProvider);
  if (configuredProviders.length === 0) {
    return 'No provider is configured. Open Settings → Providers and configure one before chatting.';
  }

  const { provider, model } = parseProviderModelSelection(preferredModel);
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
