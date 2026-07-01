import type { ModelDef, ProviderName } from '@koryphaios/shared';
import { createGenericModel } from './models';

export const MODEL_LIST_CACHE_TTL_MS = 5 * 60_000;

export function isModelListCacheFresh(fetchedAt: number, ttlMs = MODEL_LIST_CACHE_TTL_MS): boolean {
  return fetchedAt > 0 && Date.now() - fetchedAt < ttlMs;
}

/** Prefer discovered models, enrich from fallback catalog metadata when ids match.
 *  When the remote listing reported its own capability metadata (contextVerified),
 *  those live numbers override the hand-maintained catalog values. */
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
      });
    } else {
      merged.push(catalog);
    }
  }

  for (const model of fallback) {
    const key = model.apiModelId ?? model.id;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(model);
  }

  return merged;
}

function firstPositive(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

/**
 * Pull real capability metadata out of a raw /models list entry. Many
 * OpenAI-compatible endpoints return far more than the bare id — OpenRouter
 * sends `context_length`, GitHub Copilot sends
 * `capabilities.limits.max_context_window_tokens` / `max_output_tokens` and
 * `capabilities.supports.vision`, other gateways send `context_window` or
 * `display_name`. The OpenAI SDK preserves unknown fields on the raw objects,
 * so this turns the provider's OWN numbers into the ModelDef instead of
 * trusting a hand-maintained catalog.
 */
export function enrichFromRemoteMetadata(raw: unknown, def: ModelDef): ModelDef {
  if (!raw || typeof raw !== 'object') return def;
  const r = raw as Record<string, unknown>;
  const caps = (r.capabilities ?? {}) as Record<string, unknown>;
  const limits = (caps.limits ?? {}) as Record<string, unknown>;
  const supports = (caps.supports ?? {}) as Record<string, unknown>;
  const topProvider = (r.top_provider ?? {}) as Record<string, unknown>;

  const ctx = firstPositive(
    r.context_length,
    r.context_window,
    r.max_context_length,
    limits.max_context_window_tokens,
  );
  const maxOut = firstPositive(
    r.max_output_tokens,
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

  if (ctx === undefined && maxOut === undefined && !displayName && vision === undefined) {
    return def;
  }
  return {
    ...def,
    ...(displayName ? { name: displayName } : {}),
    ...(ctx !== undefined ? { contextWindow: ctx, contextVerified: true } : {}),
    ...(maxOut !== undefined ? { maxOutputTokens: maxOut } : {}),
    ...(vision !== undefined
      ? { vision, supportsAttachments: def.supportsAttachments || vision }
      : {}),
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
    lowerId.includes('audio')
  );
}