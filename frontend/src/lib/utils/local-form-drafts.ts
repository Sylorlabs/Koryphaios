/** Bounded device-local recovery for small, unsent form fields. */

const STORAGE_KEY = 'koryphaios-local-form-drafts-v1';
const MAX_DRAFTS = 24;
const MAX_FIELD_CHARS = 48_000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

type StoredFormDraft = { fields: Record<string, string>; updatedAt: number };
type StoredFormDrafts = Record<string, StoredFormDraft>;

function storage(): Storage | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  return localStorage;
}

function safeKey(namespace: string, scope: string | null | undefined): string {
  const normalizedScope = scope?.trim() || 'default';
  return `${namespace.slice(0, 80)}:${normalizedScope.slice(0, 300)}`;
}

function cleanFields(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, text] of Object.entries(value as Record<string, unknown>)) {
    if (typeof text === 'string' && text) result[key.slice(0, 80)] = text.slice(0, MAX_FIELD_CHARS);
  }
  return result;
}

function readAll(): StoredFormDrafts {
  const local = storage();
  if (!local) return {};
  try {
    const parsed = JSON.parse(local.getItem(STORAGE_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const now = Date.now();
    const drafts: StoredFormDrafts = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const updatedAt = (value as Record<string, unknown>).updatedAt;
      if (typeof updatedAt !== 'number' || now - updatedAt > MAX_AGE_MS) continue;
      const fields = cleanFields((value as Record<string, unknown>).fields);
      if (Object.keys(fields).length) drafts[key] = { fields, updatedAt };
    }
    return drafts;
  } catch {
    return {};
  }
}

function writeAll(drafts: StoredFormDrafts): void {
  const local = storage();
  if (!local) return;
  try {
    const capped = Object.fromEntries(
      Object.entries(drafts)
        .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
        .slice(0, MAX_DRAFTS),
    );
    local.setItem(STORAGE_KEY, JSON.stringify(capped));
  } catch {}
}

export function loadLocalFormDraft(namespace: string, scope?: string | null): Record<string, string> {
  return readAll()[safeKey(namespace, scope)]?.fields ?? {};
}

export function saveLocalFormDraft(
  namespace: string,
  scope: string | null | undefined,
  fields: Record<string, string>,
): void {
  const drafts = readAll();
  const key = safeKey(namespace, scope);
  const clean = cleanFields(fields);
  if (Object.keys(clean).length === 0) delete drafts[key];
  else drafts[key] = { fields: clean, updatedAt: Date.now() };
  writeAll(drafts);
}
