/** Model-specific composer preferences that are safe to keep on this device. */

type ModelPreference = {
  reasoningLevel?: string;
  fastMode?: boolean;
  contextWindow?: number;
};

const STORAGE_KEY = 'koryphaios-composer-preferences-v1';
const MAX_MODELS = 48;

function storage(): Storage | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  return localStorage;
}

function readAll(): Record<string, ModelPreference> {
  const local = storage();
  if (!local) return {};
  try {
    const parsed = JSON.parse(local.getItem(STORAGE_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, ModelPreference> = {};
    for (const [model, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const value = raw as Record<string, unknown>;
      const preference: ModelPreference = {
        ...(typeof value.reasoningLevel === 'string' && value.reasoningLevel
          ? { reasoningLevel: value.reasoningLevel.slice(0, 80) }
          : {}),
        ...(typeof value.fastMode === 'boolean' ? { fastMode: value.fastMode } : {}),
        ...(typeof value.contextWindow === 'number' &&
        Number.isFinite(value.contextWindow) &&
        value.contextWindow > 0
          ? { contextWindow: value.contextWindow }
          : {}),
      };
      if (
        preference.reasoningLevel !== undefined ||
        preference.fastMode !== undefined ||
        preference.contextWindow !== undefined
      ) {
        result[model.slice(0, 300)] = preference;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeAll(preferences: Record<string, ModelPreference>): void {
  const local = storage();
  if (!local) return;
  try {
    const capped = Object.fromEntries(Object.entries(preferences).slice(-MAX_MODELS));
    local.setItem(STORAGE_KEY, JSON.stringify(capped));
  } catch {}
}

function safeModel(model: string): string {
  return model.trim().slice(0, 300);
}

export function loadComposerPreference(model: string): ModelPreference {
  return readAll()[safeModel(model)] ?? {};
}

export function saveComposerPreference(model: string, next: ModelPreference): void {
  const key = safeModel(model);
  if (!key) return;
  const all = readAll();
  const merged = { ...all[key], ...next };
  // An explicit undefined erases the field: only defined values are stored,
  // so "Default" clears the persisted session budget instead of keeping a
  // stale one.
  const stored: ModelPreference = {};
  if (merged.reasoningLevel !== undefined) stored.reasoningLevel = merged.reasoningLevel;
  if (merged.fastMode !== undefined) stored.fastMode = merged.fastMode;
  if (merged.contextWindow !== undefined) stored.contextWindow = merged.contextWindow;
  all[key] = stored;
  writeAll(all);
}
