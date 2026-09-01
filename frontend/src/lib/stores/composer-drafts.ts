/**
 * Bounded local recovery for unsent composer work.
 *
 * Drafts never leave this device. Text is capped and attachments are only
 * retained when their already-read payload is small enough for local storage.
 * Large attachments stay in memory and the composer tells the user they must
 * be reattached after a restart instead of silently pretending they were safe
 * to save.
 */

export type ComposerDraftAttachment = {
  type: 'image' | 'file';
  data: string;
  name: string;
  mimeType?: string;
};

export type ComposerDraft = {
  text: string;
  attachments: ComposerDraftAttachment[];
  omittedAttachmentNames: string[];
};

type StoredComposerDraft = ComposerDraft & { updatedAt: number };
type StoredComposerDrafts = Record<string, StoredComposerDraft>;

const STORAGE_KEY = 'koryphaios-composer-drafts-v1';
const MAX_DRAFTS = 16;
const MAX_TEXT_CHARS = 64_000;
const MAX_ATTACHMENT_COUNT = 4;
const MAX_ATTACHMENT_CHARS = 1_000_000;
const MAX_TOTAL_ATTACHMENT_CHARS = 2_400_000;
const MAX_ATTACHMENT_NAME_CHARS = 240;
const MAX_DRAFT_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

function safeStorage(): Storage | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  return localStorage;
}

function safeKey(key: string | undefined): string {
  const normalized = key?.trim();
  return normalized ? normalized.slice(0, 256) : 'welcome';
}

function parseStoredDrafts(storage: Storage | undefined = safeStorage()): StoredComposerDrafts {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const now = Date.now();
    const result: StoredComposerDrafts = {};
    for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const value = raw as Record<string, unknown>;
      if (typeof value.updatedAt !== 'number' || now - value.updatedAt > MAX_DRAFT_AGE_MS) continue;
      const text = typeof value.text === 'string' ? value.text.slice(0, MAX_TEXT_CHARS) : '';
      const attachments = sanitizeAttachments(value.attachments).attachments;
      const omittedAttachmentNames = Array.isArray(value.omittedAttachmentNames)
        ? value.omittedAttachmentNames
            .filter((name): name is string => typeof name === 'string')
            .map((name) => name.slice(0, MAX_ATTACHMENT_NAME_CHARS))
            .slice(0, MAX_ATTACHMENT_COUNT)
        : [];
      if (!text && attachments.length === 0 && omittedAttachmentNames.length === 0) continue;
      result[safeKey(key)] = {
        text,
        attachments,
        omittedAttachmentNames,
        updatedAt: value.updatedAt,
      };
    }
    return result;
  } catch {
    return {};
  }
}

function sanitizeAttachments(value: unknown): {
  attachments: ComposerDraftAttachment[];
  omittedAttachmentNames: string[];
} {
  if (!Array.isArray(value)) return { attachments: [], omittedAttachmentNames: [] };
  const attachments: ComposerDraftAttachment[] = [];
  const omittedAttachmentNames: string[] = [];
  let totalChars = 0;
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const name =
      typeof item.name === 'string' ? item.name.slice(0, MAX_ATTACHMENT_NAME_CHARS) : 'attachment';
    const type = item.type === 'image' || item.type === 'file' ? item.type : null;
    const data = typeof item.data === 'string' ? item.data : '';
    const mimeType = typeof item.mimeType === 'string' ? item.mimeType.slice(0, 128) : undefined;
    const canRecover =
      type !== null &&
      data.length > 0 &&
      attachments.length < MAX_ATTACHMENT_COUNT &&
      data.length <= MAX_ATTACHMENT_CHARS &&
      totalChars + data.length <= MAX_TOTAL_ATTACHMENT_CHARS;
    if (!canRecover) {
      omittedAttachmentNames.push(name);
      continue;
    }
    totalChars += data.length;
    attachments.push({ type, data, name, ...(mimeType ? { mimeType } : {}) });
  }
  return {
    attachments,
    omittedAttachmentNames: omittedAttachmentNames.slice(0, MAX_ATTACHMENT_COUNT),
  };
}

function trimDrafts(drafts: StoredComposerDrafts): StoredComposerDrafts {
  const sorted = Object.entries(drafts).sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
  return Object.fromEntries(sorted.slice(0, MAX_DRAFTS));
}

function writeDrafts(
  drafts: StoredComposerDrafts,
  storage: Storage | undefined = safeStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(trimDrafts(drafts)));
    return true;
  } catch {
    return false;
  }
}

export function loadComposerDraft(key?: string, storage?: Storage): ComposerDraft {
  const record = parseStoredDrafts(storage)[safeKey(key)];
  if (!record) return { text: '', attachments: [], omittedAttachmentNames: [] };
  return {
    text: record.text,
    attachments: record.attachments,
    omittedAttachmentNames: record.omittedAttachmentNames,
  };
}

export function saveComposerDraft(
  key: string | undefined,
  text: string,
  value: ComposerDraftAttachment[],
  previousOmittedAttachmentNames: string[] = [],
  storage?: Storage,
): { persisted: boolean; omittedAttachmentNames: string[] } {
  const drafts = parseStoredDrafts(storage);
  const normalizedKey = safeKey(key);
  const clippedText = text.slice(0, MAX_TEXT_CHARS);
  const sanitized = sanitizeAttachments(value);
  const omittedAttachmentNames = [
    ...new Set([...previousOmittedAttachmentNames, ...sanitized.omittedAttachmentNames]),
  ]
    .filter((name) => typeof name === 'string' && name)
    .map((name) => name.slice(0, MAX_ATTACHMENT_NAME_CHARS))
    .slice(0, MAX_ATTACHMENT_COUNT);
  if (!clippedText && sanitized.attachments.length === 0 && omittedAttachmentNames.length === 0) {
    delete drafts[normalizedKey];
    return { persisted: writeDrafts(drafts, storage), omittedAttachmentNames: [] };
  }
  drafts[normalizedKey] = {
    text: clippedText,
    attachments: sanitized.attachments,
    omittedAttachmentNames,
    updatedAt: Date.now(),
  };
  return {
    persisted: writeDrafts(drafts, storage),
    omittedAttachmentNames,
  };
}

export function clearComposerDraft(key?: string, storage?: Storage): void {
  const drafts = parseStoredDrafts(storage);
  delete drafts[safeKey(key)];
  writeDrafts(drafts, storage);
}
