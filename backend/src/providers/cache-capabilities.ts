import {
  readProviderReasoningCacheProbe,
  type VerifiedReasoningCacheScope,
} from './cache-capability-store';

export type NativePromptCaching = 'explicit' | 'implicit' | 'gateway' | 'local-prefix' | 'none';
export type PromptCacheReasoningScope = 'shared' | 'isolated' | 'probe' | 'unknown';
export type PromptCacheToolPolicy =
  'stable-declarations-allowlist' | 'stable-meta-tools' | 'exact-toolset';
export type PromptCacheKeyControl = 'native-key' | 'sticky-session' | 'none';
export type PromptCacheTtl = '5m' | '30m' | '1h' | 'provider-managed';

export interface PromptCacheCapabilities {
  nativeCaching: NativePromptCaching;
  modelRequiredInDomain: boolean;
  reasoningScope: PromptCacheReasoningScope;
  toolPolicy: PromptCacheToolPolicy;
  cacheKeyControl: PromptCacheKeyControl;
  ttl: PromptCacheTtl[];
  readTelemetry: boolean;
  writeTelemetry: boolean;
  accountScoped: boolean;
}

export interface PromptCacheRoutingContext {
  provider?: string;
  custom?: boolean;
  reasoningScopeOverride?: VerifiedReasoningCacheScope;
}

export interface ResolvedPromptCacheCapabilities extends PromptCacheCapabilities {
  effectiveReasoningScope: VerifiedReasoningCacheScope;
  reasoningScopeSource:
    'documented' | 'verified-catalog' | 'live-probe' | 'conservative' | 'diagnostic-override';
}

const CONSERVATIVE_UNKNOWN: PromptCacheCapabilities = {
  nativeCaching: 'none',
  modelRequiredInDomain: true,
  reasoningScope: 'unknown',
  toolPolicy: 'exact-toolset',
  cacheKeyControl: 'none',
  ttl: ['provider-managed'],
  readTelemetry: false,
  writeTelemetry: false,
  accountScoped: true,
};

const VERIFIED_CAPABILITY_CATALOG: Record<string, PromptCacheCapabilities> = {
  openai: {
    nativeCaching: 'implicit',
    modelRequiredInDomain: true,
    reasoningScope: 'shared',
    toolPolicy: 'stable-declarations-allowlist',
    cacheKeyControl: 'native-key',
    ttl: ['30m', 'provider-managed'],
    readTelemetry: true,
    writeTelemetry: true,
    accountScoped: true,
  },
  anthropic: {
    nativeCaching: 'explicit',
    modelRequiredInDomain: true,
    reasoningScope: 'shared',
    toolPolicy: 'exact-toolset',
    cacheKeyControl: 'none',
    ttl: ['5m', '1h'],
    readTelemetry: true,
    writeTelemetry: true,
    accountScoped: true,
  },
  bedrock: {
    nativeCaching: 'explicit',
    modelRequiredInDomain: true,
    reasoningScope: 'isolated',
    toolPolicy: 'exact-toolset',
    cacheKeyControl: 'none',
    ttl: ['5m'],
    readTelemetry: true,
    writeTelemetry: true,
    accountScoped: true,
  },
  openrouter: {
    nativeCaching: 'gateway',
    modelRequiredInDomain: true,
    reasoningScope: 'probe',
    toolPolicy: 'exact-toolset',
    cacheKeyControl: 'sticky-session',
    ttl: ['provider-managed'],
    readTelemetry: true,
    writeTelemetry: false,
    accountScoped: true,
  },
};

function normalizeProvider(provider: string | undefined): string {
  return provider?.trim().toLowerCase() || 'unknown';
}

export function getPromptCacheCapabilities(
  context: PromptCacheRoutingContext = {},
): PromptCacheCapabilities {
  const provider = normalizeProvider(context.provider);
  if (context.custom || provider.startsWith('custom:')) {
    return {
      nativeCaching: 'gateway',
      modelRequiredInDomain: true,
      reasoningScope: 'probe',
      toolPolicy: 'exact-toolset',
      cacheKeyControl: 'none',
      ttl: ['provider-managed'],
      readTelemetry: true,
      writeTelemetry: true,
      accountScoped: true,
    };
  }
  return VERIFIED_CAPABILITY_CATALOG[provider] ?? CONSERVATIVE_UNKNOWN;
}

export function resolvePromptCacheCapabilities(
  context: PromptCacheRoutingContext & { model: string },
): ResolvedPromptCacheCapabilities {
  const declared = getPromptCacheCapabilities(context);
  if (context.reasoningScopeOverride) {
    return {
      ...declared,
      effectiveReasoningScope: context.reasoningScopeOverride,
      reasoningScopeSource: 'diagnostic-override',
    };
  }
  if (declared.reasoningScope === 'shared' || declared.reasoningScope === 'isolated') {
    return {
      ...declared,
      effectiveReasoningScope: declared.reasoningScope,
      reasoningScopeSource: 'verified-catalog',
    };
  }
  if (declared.reasoningScope === 'probe') {
    const probe = readProviderReasoningCacheProbe(
      normalizeProvider(context.provider),
      context.model,
    );
    if (probe) {
      return {
        ...declared,
        effectiveReasoningScope: probe.scope,
        reasoningScopeSource: 'live-probe',
      };
    }
  }
  return {
    ...declared,
    effectiveReasoningScope: 'isolated',
    reasoningScopeSource: 'conservative',
  };
}
