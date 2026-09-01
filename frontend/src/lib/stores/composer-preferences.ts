/** Model-specific composer preferences that are safe to keep on this device. */

type ModelPreference = {
  reasoningLevel?: string;
  fastMode?: boolean;
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
      };
      if (preference.reasoningLevel !== undefined || preference.fastMode !== undefined) {
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
  all[key] = { ...all[key], ...next };
  writeAll(all);
}
