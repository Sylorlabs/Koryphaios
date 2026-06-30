import type { ModelDef, ProviderName } from '@koryphaios/shared';
import { createGenericModel } from './models';

export const MODEL_LIST_CACHE_TTL_MS = 5 * 60_000;

export function isModelListCacheFresh(fetchedAt: number, ttlMs = MODEL_LIST_CACHE_TTL_MS): boolean {
  return fetchedAt > 0 && Date.now() - fetchedAt < ttlMs;
}

/** Prefer discovered models, enrich from fallback catalog metadata when ids match. */
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
    merged.push(byApiId.get(key) ?? remote);
  }

  for (const model of fallback) {
    const key = model.apiModelId ?? model.id;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(model);
  }

  return merged;
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