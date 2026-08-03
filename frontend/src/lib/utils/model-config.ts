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

/**
 * A manual selection is valid only while the provider reports that exact model
 * as enabled.  Keep this separate from Auto: Auto is resolved by the backend,
 * while a manual choice must never silently point at a disabled model.
 */
export function isEnabledModelSelection(providers: ProviderInfo[], value?: string): boolean {
  const { provider, model } = parseProviderModelSelection(value);
  if (!provider || !model) return false;
  const selectedProvider = providers.find((item) => item.name === provider);
  return !!selectedProvider?.authenticated && selectedProvider.models.includes(model);
}

export function getModelConfigurationWarning(
  providers: ProviderInfo[],
  preferredModel?: string,
): string | null {
  const authenticatedProviders = providers.filter((provider) => provider.authenticated);
  if (authenticatedProviders.length === 0) {
    return 'No provider connected. Open Settings → Providers and connect one before chatting.';
  }

  const { provider, model } = parseProviderModelSelection(preferredModel);
  if (provider && model) {
    const selectedProvider = authenticatedProviders.find((item) => item.name === provider);
    if (!selectedProvider) {
      return `${formatProviderName(provider)} is not configured. Open Settings and connect it.`;
    }
    if (!selectedProvider.models.includes(model)) {
      return `${model} is not enabled for ${formatProviderName(provider)}. Open Settings -> Manage Models and enable it.`;
    }
  }

  const enabledModelCount = authenticatedProviders.reduce(
    (count, current) => count + current.models.length,
    0,
  );
  if (enabledModelCount === 0) {
    return 'No models are enabled for your configured providers. Open Settings -> Manage Models and enable at least one model.';
  }

  return null;
}
