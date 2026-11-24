import { recordProviderModelPricing } from '../pricing';
import type { ModelDef, ProviderName } from '@koryphaios/shared';
import { buildModelParameters } from '@koryphaios/shared';
import { createGenericModel } from './models';

export const MODEL_LIST_CACHE_TTL_MS = 5 * 60_000;

export function isModelListCacheFresh(fetchedAt: number, ttlMs = MODEL_LIST_CACHE_TTL_MS): boolean {
  return fetchedAt > 0 && Date.now() - fetchedAt < ttlMs;
}

/**
 * Turn a provider-reported list into display definitions.
 *
 * `fallback` is metadata only: it may enrich a model whose exact ID was
 * reported by the provider, but it must never add a model the provider did not
 * return. Appending the fallback here made removed, plan-gated, and otherwise
 * unavailable models look selectable in Settings.
 */
export function mergeModelLists(fallback: ModelDef[], discovered: ModelDef[]): ModelDef[] {
  const byApiId = new Map<string, ModelDef>();
  for (const model of fallback) {
    byApiId.set(model.apiModelId ?? model.id, model);
  }

  const merged: ModelDef[] = [];
  const seen = new Set<string>();

  for (const remote of discovered) {
    const key = remote.apiModelId ?? remote.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const catalog = byApiId.get(key);
    if (!catalog) {
      merged.push(remote);
    } else if (remote.contextVerified) {
      merged.push({
        ...catalog,
        contextWindow: remote.contextWindow,
        contextVerified: true,
        ...(remote.maxOutputTokens > 0 ? { maxOutputTokens: remote.maxOutputTokens } : {}),
        ...(remote.vision !== undefined ? { vision: remote.vision } : {}),
        ...(remote.reasoningLevels?.length ? { reasoningLevels: remote.reasoningLevels } : {}),
        ...(remote.outputModalities?.length ? { outputModalities: remote.outputModalities } : {}),
      });
    } else {
      merged.push(catalog);
    }
  }

  return merged;
}

function firstPositive(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    if (typeof v !== 'string') continue;
    const match = v.trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM])?(?:\s+context)?$/);
    if (!match) continue;
    const amount = Number(match[1]);
    const multiplier = match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2] ? 1_000 : 1;
    const parsed = amount * multiplier;
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const v of values) {
    if (typeof v === 'boolean') return v;
  }
  return undefined;
}

/**
 * Pull real capability metadata out of a raw /models list entry. Many
 * OpenAI-compatible endpoints return far more than the bare id — OpenRouter
 * sends `context_length`, GitHub Copilot sends
 * `capabilities.limits.max_context_window_tokens` / `max_output_tokens` and
 * `capabilities.supports.vision`, other gateways send `context_window` or
 * `display_name`. Reasoning capability flags are read from `reasoning`,
 * `capabilities.supports.reasoning`, or `capabilities.reasoning`, and discrete
 * effort tiers from `reasoning_levels` / `supported_reasoning_efforts` /
 * `reasoning_options` when the provider reports them. The OpenAI
 * SDK preserves unknown fields on the raw objects,
 * so this turns the provider's OWN numbers into the ModelDef instead of
 * trusting a hand-maintained catalog.
 */
function firstStringArray(...values: unknown[]): string[] | undefined {
  for (const v of values) {
    if (
      Array.isArray(v) &&
      v.length > 0 &&
      v.every((item) => typeof item === 'string' && item.trim().length > 0)
    ) {
      return [...new Set(v.map((item) => (item as string).trim().toLowerCase()))];
    }
  }
  return undefined;
}

export function enrichFromRemoteMetadata(raw: unknown, def: ModelDef): ModelDef {
  if (!raw || typeof raw !== 'object') return def;
  const r = raw as Record<string, unknown>;
  recordProviderModelPricing(def.provider, def.apiModelId ?? def.id, raw);
  const caps = (r.capabilities ?? {}) as Record<string, unknown>;
  const limits = (caps.limits ?? {}) as Record<string, unknown>;
  const supports = (caps.supports ?? {}) as Record<string, unknown>;
  const topProvider = (r.top_provider ?? {}) as Record<string, unknown>;
  const architecture = (r.architecture ?? {}) as Record<string, unknown>;
  const modalities = (r.modalities ?? {}) as Record<string, unknown>;

  const ctx = firstPositive(
    r.context_length,
    r.context_window,
    r.max_context_length,
    r.max_context_tokens,
    r.max_input_tokens,
    limits.max_context_window_tokens,
  );
  const maxOut = firstPositive(
    r.max_output_tokens,
    r.max_completion_tokens,
    limits.max_output_tokens,
    topProvider.max_completion_tokens,
  );
  const displayName =
    typeof r.display_name === 'string' && r.display_name.trim()
      ? r.display_name.trim()
      : typeof r.name === 'string' && r.name.trim() && r.name !== def.id
        ? (r.name as string).trim()
        : undefined;
  const vision = typeof supports.vision === 'boolean' ? (supports.vision as boolean) : undefined;
  // Output modalities, only when the provider states them: OpenRouter sends
  // `architecture.output_modalities`, models.dev sends `modalities.output`, and
  // other OpenAI-compatible gateways send a flat `output_modalities`. Never
  // inferred from the model name — the image and video pickers rely on this
  // being provider-stated truth.
  const outputModalities = firstStringArray(
    architecture.output_modalities,
    r.output_modalities,
    modalities.output,
  );
  const reasoning = firstBoolean(
    r.reasoning,
    r.supports_reasoning,
    supports.reasoning,
    supports.supports_reasoning,
    caps.reasoning,
    caps.supports_reasoning,
  );
  // Discrete reasoning effort tiers, when the provider's own catalog reports
  // them (e.g. gateways mirroring the models.dev `reasoning_options` shape or
  // a plain `reasoning_levels` array). Never invented — absent means unknown.
  const reasoningOptions = Array.isArray(r.reasoning_options)
    ? (r.reasoning_options as Array<{ type?: unknown; values?: unknown }>)
    : undefined;
  const effortValues = reasoningOptions?.find((o) => o?.type === 'effort')?.values;
  // Reflection reports its exact effort ladder in a nested reasoning object.
  const nestedReasoning =
    r.reasoning && typeof r.reasoning === 'object'
      ? (r.reasoning as Record<string, unknown>)
      : undefined;
  const nestedEfforts = firstStringArray(nestedReasoning?.supported_efforts);
  const reasoningLevels = firstStringArray(
    nestedEfforts,
    r.reasoning_levels,
    r.supported_reasoning_efforts,
    r.reasoning_efforts,
    r.supported_reasoning_levels,
    caps.supported_reasoning_efforts,
    Array.isArray(effortValues) ? effortValues : undefined,
  );
  // OpenRouter-style parameter reporting: `supported_parameters` names the
  // request keys the gateway forwards and `default_parameters` carries the
  // model's own default values (null = unknown). Filtered to the keys
  // Koryphaios actually sends.
  const supportedParameters = firstStringArray(r.supported_parameters);
  const defaultParameters =
    r.default_parameters && typeof r.default_parameters === 'object'
      ? (r.default_parameters as Record<string, unknown>)
      : undefined;
  const parameters = supportedParameters
    ? buildModelParameters(
        supportedParameters,
        defaultParameters,
        firstPositive(topProvider.max_completion_tokens) ?? maxOut ?? def.maxOutputTokens,
      )
    : undefined;

  if (
    ctx === undefined &&
    maxOut === undefined &&
    !displayName &&
    vision === undefined &&
    reasoning === undefined &&
    reasoningLevels === undefined &&
    outputModalities === undefined &&
    parameters === undefined
  ) {
    return def;
  }
  return {
    ...def,
    ...(displayName ? { name: displayName } : {}),
    ...(ctx !== undefined ? { contextWindow: ctx, contextVerified: true } : {}),
    ...(maxOut !== undefined ? { maxOutputTokens: maxOut } : {}),
    ...(reasoning !== undefined
      ? { canReason: reasoning }
      : nestedEfforts?.length
        ? { canReason: true }
        : {}),
    ...(reasoningLevels !== undefined ? { reasoningLevels } : {}),
    ...(vision !== undefined
      ? { vision, supportsAttachments: def.supportsAttachments || vision }
      : {}),
    ...(outputModalities !== undefined ? { outputModalities } : {}),
    ...(parameters !== undefined && parameters.length > 0 ? { parameters } : {}),
  };
}

export function modelFromRemoteId(
  id: string,
  provider: ProviderName,
  fallback: ModelDef[],
): ModelDef {
  const existing = fallback.find((m) => m.apiModelId === id || m.id === id);
  if (existing) return existing;
  const generic = createGenericModel(id, provider);
  generic.apiModelId = id;
  return generic;
}

/** Filter noisy / non-chat model ids from OpenAI-compatible /models listings. */
export function isLikelyChatModelId(id: string, provider: ProviderName): boolean {
  const lowerId = id.toLowerCase();

  if (provider === 'openai') {
    return (
      lowerId.includes('gpt') ||
      lowerId.includes('o1') ||
      lowerId.includes('o3') ||
      lowerId.includes('o4')
    );
  }

  return !(
    lowerId.includes('embed') ||
    lowerId.includes('whisper') ||
    lowerId.includes('tts') ||
    lowerId.includes('dall-e') ||
    lowerId.includes('moderation') ||
    lowerId.includes('rerank') ||
    lowerId.includes('transcribe') ||
    lowerId.includes('realtime') ||
    lowerId.includes('audio') ||
    lowerId.includes('imagine') ||
    lowerId.includes('image-quality') ||
    lowerId.includes('flux') ||
    lowerId.includes('stable-diffusion') ||
    lowerId.includes('imagen')
  );
}
