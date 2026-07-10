import type { ProviderInfo } from '@koryphaios/shared';

function formatProviderName(provider: string): string {
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'codex') return 'Codex';
  if (provider === 'anthropic') return 'Anthropic';
  if (provider === 'google') return 'Google';
  if (provider === 'xai') return 'xAI';
  if (provider === 'openrouter') return 'OpenRouter';
  if (provider === 'vertexai') return 'Vertex AI';
  if (provider === 'copilot') return 'Copilot';
  if (provider === 'kimicode') return 'Kimi Code';
  if (provider === 'moonshot') return 'Moonshot AI / Kimi API';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function parseProviderModelSelection(
  value?: string,
): { provider?: string; model?: string } {
  if (!value || value === 'auto') return {};
  const separator = value.indexOf(':');
  if (separator === -1) return {};
  return {
    provider: value.slice(0, separator),
    model: value.slice(separator + 1),
  };
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
      return `${formatProviderName(provider)} is not configured. Open Settings and connect it, or switch back to Auto.`;
    }
    if (!selectedProvider.models.includes(model)) {
      return `${model} is not enabled for ${formatProviderName(provider)}. Open Settings -> Manage Models and enable it, or switch back to Auto.`;
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
