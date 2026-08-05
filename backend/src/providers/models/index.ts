import type { ModelDef, ProviderName } from '@koryphaios/shared';

/**
 * There is intentionally no bundled model catalog.
 *
 * A model may appear only after the authenticated provider, its official CLI,
 * or a user-owned local configuration has reported it.  Guessing a catalog
 * makes unavailable models look selectable and turns discovery failures into
 * lies.
 */
export const MODEL_CATALOG: Record<string, ModelDef> = Object.create(null);

/** A model id alone is not enough to establish its provider or capabilities. */
export function resolveModel(_modelId: string): ModelDef | undefined {
  return undefined;
}

/** Model definitions are provider-scoped and come from live discovery only. */
export function resolveModelForProvider(
  modelId: string,
  provider: ProviderName,
): ModelDef | undefined {
  return liveModelResolver?.(modelId, provider);
}

/** Never use an in-repo list as a discovery fallback. */
export function getModelsForProvider(_providerName: ProviderName): ModelDef[] {
  return [];
}

/** Create a conservative definition for an ID reported by a real provider. */
export function createGenericModel(id: string, provider: ProviderName): ModelDef {
  return {
    id,
    name: id,
    provider,
    contextWindow: 0,
    maxOutputTokens: 4_096,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: false,
    supportsAttachments: false,
    supportsStreaming: true,
    isGeneric: true,
  };
}

type LiveModelResolver = (modelId: string, provider: ProviderName) => ModelDef | undefined;
let liveModelResolver: LiveModelResolver | null = null;

export function registerLiveModelResolver(resolver: LiveModelResolver): void {
  liveModelResolver = resolver;
}

function hasUsableContext(model: ModelDef | undefined): boolean {
  return !!model && Number.isFinite(model.contextWindow) && model.contextWindow >= 1024;
}

/** Return context only when the connected provider actually reported it. */
export function resolveTrustedContextWindow(
  modelId: string,
  provider: ProviderName,
): {
  contextWindow?: number;
  contextKnown: boolean;
  contextSource?: 'live';
} {
  const live = liveModelResolver?.(modelId, provider);
  if (live?.contextVerified && hasUsableContext(live)) {
    return { contextWindow: live.contextWindow, contextKnown: true, contextSource: 'live' };
  }
  return { contextKnown: false };
}

/** Model substitution is unsafe without a provider-reported alternative. */
export function findAlternativeModel(_failedModelId: string): ModelDef | undefined {
  return undefined;
}

/** Legacy status must be reported by the provider, not inferred from a stale list. */
export function isLegacyModel(_modelOrId: string | ModelDef): boolean {
  return false;
}

/** Automatic routing uses models from ProviderRegistry status, never a catalog. */
export function getNonLegacyModels(): ModelDef[] {
  return [];
}
