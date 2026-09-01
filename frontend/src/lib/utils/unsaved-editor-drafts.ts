/** Local, bounded recovery for plain-text editors that have an explicit Save. */

const STORAGE_KEY = 'koryphaios-unsaved-editor-drafts-v1';
const MAX_RECORDS = 12;
const MAX_TEXT_CHARS = 64_000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

export type AgentEditorDraft = {
  preferences?: string;
  managerNotes?: Record<string, string>;
};

type StoredDraft = AgentEditorDraft & { updatedAt: number };
type StoredDrafts = Record<string, StoredDraft>;

function safeStorage(): Storage | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  return localStorage;
}

/** FNV-1a gives us a stable local key without writing a project path as a key. */
export function editorDraftScopeId(scope: string | null | undefined): string {
  const source = scope?.trim() || 'personal';
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `scope-${(hash >>> 0).toString(16)}`;
}

function cleanDraft(value: unknown): AgentEditorDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const managerNotes: Record<string, string> = {};
  if (record.managerNotes && typeof record.managerNotes === 'object' && !Array.isArray(record.managerNotes)) {
    for (const [key, text] of Object.entries(record.managerNotes as Record<string, unknown>)) {
      if (typeof text === 'string' && text) managerNotes[key.slice(0, 80)] = text.slice(0, MAX_TEXT_CHARS);
    }
  }
  return {
    ...(typeof record.preferences === 'string' && record.preferences
      ? { preferences: record.preferences.slice(0, MAX_TEXT_CHARS) }
      : {}),
    ...(Object.keys(managerNotes).length ? { managerNotes } : {}),
  };
}

function readDrafts(storage: Storage | undefined = safeStorage()): StoredDrafts {
  if (!storage) return {};
  try {
    const raw = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const now = Date.now();
    const entries = Object.entries(raw as Record<string, unknown>)
      .map(([key, value]) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const updatedAt = (value as Record<string, unknown>).updatedAt;
        if (typeof updatedAt !== 'number' || now - updatedAt > MAX_AGE_MS) return null;
        const draft = cleanDraft(value);
        if (!draft.preferences && !draft.managerNotes) return null;
        return [key, { ...draft, updatedAt }] as const;
      })
      .filter((entry): entry is readonly [string, StoredDraft] => entry !== null)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_RECORDS);
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function writeDrafts(drafts: StoredDrafts, storage: Storage | undefined = safeStorage()): void {
  if (!storage) return;
  try {
    const sorted = Object.entries(drafts)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_RECORDS);
    storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(sorted)));
  } catch {}
}

export function loadAgentEditorDraft(scope: string | null | undefined): AgentEditorDraft {
  const record = readDrafts()[editorDraftScopeId(scope)];
  if (!record) return {};
  return { preferences: record.preferences, managerNotes: record.managerNotes };
}

export function saveAgentEditorDraft(
  scope: string | null | undefined,
  draft: AgentEditorDraft,
): void {
  const drafts = readDrafts();
  const key = editorDraftScopeId(scope);
  const clean = cleanDraft(draft);
  if (!clean.preferences && !clean.managerNotes) {
    delete drafts[key];
  } else {
    drafts[key] = { ...clean, updatedAt: Date.now() };
  }
  writeDrafts(drafts);
}
