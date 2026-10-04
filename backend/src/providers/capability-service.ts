import { getContext } from '../context';
import { ValidationError } from '../errors/types';
import {
  capabilityAdapterProviders,
  getCapabilityAdapter,
  resolveCapabilityConfig,
  type CapabilityAdapter,
  type CapabilityKind,
  type CapabilityModelDef,
  type ResolvedCapabilityConfig,
} from './capabilities';

/** Shape of a stored provider config returned by the provider registry. */
export interface CapabilityProviderSettings {
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
  disabled?: boolean;
  label?: string;
}

/** One entry in a modality picker. */
export interface CapabilityProviderSummary {
  provider: string;
  label: string;
  configured: boolean;
  models: CapabilityModelDef[];
}

function allConfigs(): Record<string, CapabilityProviderSettings | undefined> {
  try {
    return getContext().providers.getConfigs() as Record<
      string,
      CapabilityProviderSettings | undefined
    >;
  } catch {
    return {};
  }
}

export function capabilitySettings(provider: string): CapabilityProviderSettings | undefined {
  return allConfigs()[provider];
}

/** A capability provider is usable once it has an adapter and a credential. */
export function isCapabilityProviderConfigured(provider: string): boolean {
  const adapter = getCapabilityAdapter(provider);
  if (!adapter) return false;
  const config = allConfigs()[provider];
  if (!config || config.disabled) return false;
  if (adapter.endpointAuthOnly) return Boolean(config.baseUrl?.trim());
  return Boolean(config.apiKey?.trim() || config.authToken?.trim());
}

/** Resolve config, or raise the standard "connect it first" message. */
export function requireCapabilityConfig(provider: string): {
  adapter: CapabilityAdapter;
  config: ResolvedCapabilityConfig;
} {
  const adapter = getCapabilityAdapter(provider);
  if (!adapter) {
    throw new ValidationError(`${provider} is not a supported capability provider.`);
  }
  return { adapter, config: resolveCapabilityConfig(adapter, allConfigs()[provider]) };
}

/**
 * Every dedicated-adapter provider that can serve `capability`, for populating a
 * modality picker.
 *
 * Providers whose credential is missing are still listed, flagged
 * `configured: false`, so the UI can offer to connect them rather than silently
 * omitting a provider the user has an account for.
 */
export async function listCapabilityProviders(
  capability: CapabilityKind,
): Promise<CapabilityProviderSummary[]> {
  const summaries: CapabilityProviderSummary[] = [];
  for (const provider of capabilityAdapterProviders()) {
    const adapter = getCapabilityAdapter(provider);
    if (!adapter?.capabilities.includes(capability)) continue;
    const settings = allConfigs()[provider];
    const configured = isCapabilityProviderConfigured(provider);
    let models: CapabilityModelDef[] = [];
    if (adapter.listModels && configured) {
      try {
        models = await adapter.listModels(resolveCapabilityConfig(adapter, settings), capability);
      } catch {
        // A catalog that cannot be read must not break the picker. The provider
        // stays listed as configured with no models, and any model the user
        // types by hand still reaches the adapter.
        models = [];
      }
    }
    summaries.push({
      provider,
      label: settings?.label?.trim() || adapter.provider,
      configured,
      models,
    });
  }
  return summaries;
}
