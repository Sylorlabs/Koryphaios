import { ValidationError } from '../../errors/types';
import { PROVIDER_CONFIG_MAP } from '../provider-configs';
import type { CapabilityAdapter, CapabilityKind, ResolvedCapabilityConfig } from './types';
import { lumaAdapter } from './adapters/luma';
import { klingAiAdapter } from './adapters/klingai';
import { prodiaAdapter } from './adapters/prodia';
import { replicateAdapter } from './adapters/replicate';
import { lmntAdapter } from './adapters/lmnt';
import { voyageAiAdapter } from './adapters/voyageai';
import { mem0Adapter } from './adapters/mem0';
import { lettaAdapter } from './adapters/letta';

/**
 * Dedicated non-chat provider contracts, keyed by provider name.
 *
 * These providers are intentionally absent from `PROVIDER_FACTORIES` and stay
 * in `UNSUPPORTED_CHAT_PROVIDER_NAMES`: none of them speaks chat completions,
 * and pretending otherwise would let a user pick a model that cannot answer a
 * message. They are configured and verified here instead, and surface in the
 * surface that matches their API.
 */
const CAPABILITY_ADAPTERS: ReadonlyMap<string, CapabilityAdapter> = new Map(
  [
    lumaAdapter,
    klingAiAdapter,
    prodiaAdapter,
    replicateAdapter,
    lmntAdapter,
    voyageAiAdapter,
    mem0Adapter,
    lettaAdapter,
  ].map((adapter) => [adapter.provider, adapter]),
);

export function getCapabilityAdapter(provider: string | undefined): CapabilityAdapter | undefined {
  return provider ? CAPABILITY_ADAPTERS.get(provider) : undefined;
}

export function capabilityAdapterProviders(): string[] {
  return [...CAPABILITY_ADAPTERS.keys()];
}

/** Providers that can serve `capability`, for populating modality pickers. */
export function capabilityProvidersFor(capability: CapabilityKind): string[] {
  return [...CAPABILITY_ADAPTERS.values()]
    .filter((adapter) => adapter.capabilities.includes(capability))
    .map((adapter) => adapter.provider);
}

export function capabilityAdapterSupports(provider: string, capability: CapabilityKind): boolean {
  return CAPABILITY_ADAPTERS.get(provider)?.capabilities.includes(capability) ?? false;
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Merge the provider's configured base URL with its catalog default.
 *
 * Users can point a provider at a self-hosted or proxied deployment, but an
 * empty override must fall back to the official endpoint rather than producing
 * a relative URL that would resolve against the Koryphaios backend itself.
 */
export function resolveCapabilityConfig(
  adapter: CapabilityAdapter,
  settings: { apiKey?: string; authToken?: string; baseUrl?: string } | undefined,
): ResolvedCapabilityConfig {
  const configured = settings?.baseUrl?.trim();
  const baseUrl = trimBase(configured || adapter.defaultBaseUrl);
  if (!baseUrl) {
    throw new ValidationError(
      `${adapter.provider} has no base URL. Set one in Providers & models.`,
    );
  }
  const apiKey = settings?.apiKey?.trim() || settings?.authToken?.trim() || '';
  const endpointAuthOnly = Boolean(adapter.endpointAuthOnly);
  if (!apiKey && !endpointAuthOnly) {
    throw new ValidationError(`Connect ${adapter.provider} in Providers & models before using it.`);
  }
  if (apiKey && /[\r\n]/.test(apiKey)) {
    throw new ValidationError(`${adapter.provider} credential contains an invalid character.`);
  }
  // Prefer the user's endpoint when set; otherwise the catalog default.
  const catalogDefault = trimBase(PROVIDER_CONFIG_MAP.get(adapter.provider)?.baseUrl ?? '');
  const base = configured ? baseUrl : catalogDefault || baseUrl;
  return { baseUrl: base, apiKey, headers: {}, endpointAuthOnly };
}

export type { CapabilityAdapter, CapabilityKind, ResolvedCapabilityConfig };
