/**
 * Local recovery for unsent composer work.
 *
 * Drafts never leave this device. Text lives in localStorage; attachment
 * payloads live in IndexedDB, which is disk-backed and therefore has no size
 * ceiling of its own — a draft keeps the images the user attached, however
 * large. Only where IndexedDB is unavailable (older webviews, tests) do payloads
 * share the localStorage budget, and even there the budget is enforced on the
 * stored copy so the draft *text* always survives; the attachment stays attached
 * in the composer for the session.
 *
 * A stored attachment belongs to the user until the user removes it: sending,
 * discarding, or deleting the attachment themselves. Nothing in this module may
 * delete a payload as housekeeping — no size ceiling, no draft-count eviction,
 * no age expiry. Those exist to bound a storage budget, and bounding the budget
 * is done by storing less text, never by destroying the user's images.
 */

import {
  createIndexedDbAttachmentStore,
  type DraftAttachmentStore,
  type StoredDraftAttachment,
} from './composer-draft-attachments';

export type ComposerDraftAttachment = StoredDraftAttachment;

export type ComposerDraft = {
  text: string;
  /** Empty when payloads live in the external store; read those with
   *  `loadComposerDraftAttachments`. */
  attachments: ComposerDraftAttachment[];
};

type StoredComposerDraft = {
  text: string;
  /** Payloads written before drafts moved to IndexedDB. */
  attachments?: ComposerDraftAttachment[];
  updatedAt: number;
};
type StoredComposerDrafts = Record<string, StoredComposerDraft>;

const STORAGE_KEY = 'koryphaios-composer-drafts-v1';
const MAX_TEXT_CHARS = 64_000;
// Only reachable when payloads must share the localStorage budget: the whole
// origin gets ~5 MB, so a single inline attachment above this cannot be stored.
// The ceiling bounds the stored copy only; the composer keeps the attachment.
const MAX_ATTACHMENT_CHARS = 160_000;
const MAX_TOTAL_ATTACHMENT_CHARS = 480_000;
const MAX_ATTACHMENT_NAME_CHARS = 240;
// localStorage text budget, deliberately well under the origin quota so the rest
// of the app still has room. Drafts are evicted oldest-first to stay inside it,
// but eviction only drops a text record: payloads are never removed with it.
const MAX_DRAFT_TEXT_BUDGET_CHARS = 800_000;

let attachmentStore: DraftAttachmentStore | null | undefined;
// The attachment array last written per draft key, so unchanged payloads are
// not rewritten on every keystroke.
const lastPayloadWrite = new Map<string, readonly ComposerDraftAttachment[]>();

/** The payload store for this runtime. Injectable so both the disk-backed and
 *  the localStorage-only paths are testable. */
export function resolveDraftAttachmentStore(): DraftAttachmentStore | null {
  if (attachmentStore === undefined) attachmentStore = createIndexedDbAttachmentStore();
  return attachmentStore;
}

export function setDraftAttachmentStore(store: DraftAttachmentStore | null): void {
  attachmentStore = store;
}

/** True when attachment payloads are kept outside the localStorage string
 *  budget, so loading them is asynchronous. */
export function draftAttachmentsAreExternal(): boolean {
  return resolveDraftAttachmentStore() !== null;
}

function safeStorage(): Storage | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  return localStorage;
}

function safeKey(key: string | undefined): string {
  const normalized = key?.trim();
  return normalized ? normalized.slice(0, 256) : 'welcome';
}

function safeName(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_ATTACHMENT_NAME_CHARS) : 'attachment';
}

function isStoredAttachment(value: unknown): value is ComposerDraftAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    (item.type === 'image' || item.type === 'file') &&
    typeof item.data === 'string' &&
    typeof item.name === 'string'
  );
}

function parseStoredDrafts(storage: Storage | undefined = safeStorage()): StoredComposerDrafts {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: StoredComposerDrafts = {};
    for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const value = raw as Record<string, unknown>;
      if (typeof value.updatedAt !== 'number') continue;
      const text = typeof value.text === 'string' ? value.text.slice(0, MAX_TEXT_CHARS) : '';
      const legacy = Array.isArray(value.attachments)
        ? value.attachments.filter(isStoredAttachment)
        : [];
      // A record with no text is only a text index; its payload, if any, is
      // owned by the external store and recovered by draft key.
      if (!text && legacy.length === 0) continue;
      result[safeKey(key)] = {
        text,
        ...(legacy.length > 0 ? { attachments: legacy } : {}),
        updatedAt: value.updatedAt,
      };
    }
    return result;
  } catch {
    return {};
  }
}

/** Characters a stored record costs: its text plus any inline payload. */
function recordChars(draft: StoredComposerDraft): number {
  let chars = draft.text.length;
  for (const attachment of draft.attachments ?? []) chars += attachment.data.length;
  return chars;
}

/** Keep the newest drafts that fit the localStorage text budget.
 *
 *  This is a budget, not a retention policy: it evicts the oldest *text
 *  records* so the origin quota cannot swallow every draft at once. It must
 *  never touch the payload store — a draft that leaves the index still owns its
 *  images, and the user is the only one who can delete them. */
function fitDraftsToBudget(drafts: StoredComposerDrafts): StoredComposerDrafts {
  const newestFirst = Object.entries(drafts).sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
  const kept: [string, StoredComposerDraft][] = [];
  let chars = 0;
  for (const [key, draft] of newestFirst) {
    const cost = recordChars(draft);
    // Always keep the newest draft, however long, so the active chat's text is
    // recoverable even when it alone exceeds the budget.
    if (kept.length > 0 && chars + cost > MAX_DRAFT_TEXT_BUDGET_CHARS) continue;
    kept.push([key, draft]);
    chars += cost;
  }
  return Object.fromEntries(kept);
}

function writeDrafts(
  drafts: StoredComposerDrafts,
  storage: Storage | undefined = safeStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(fitDraftsToBudget(drafts)));
    return true;
  } catch {
    return false;
  }
}

/** Keep only the attachments that fit the shared localStorage string budget. */
function fitInlineBudget(
  attachments: readonly ComposerDraftAttachment[],
): ComposerDraftAttachment[] {
  const kept: ComposerDraftAttachment[] = [];
  let totalChars = 0;
  for (const attachment of attachments) {
    if (
      attachment.data.length <= MAX_ATTACHMENT_CHARS &&
      totalChars + attachment.data.length <= MAX_TOTAL_ATTACHMENT_CHARS
    ) {
      totalChars += attachment.data.length;
      kept.push(attachment);
    }
  }
  return kept;
}

export function loadComposerDraft(key?: string, storage?: Storage): ComposerDraft {
  const record = parseStoredDrafts(storage)[safeKey(key)];
  if (!record) return { text: '', attachments: [] };
  const store = resolveDraftAttachmentStore();
  if (store) {
    // Payloads are read asynchronously; the caller hydrates them with
    // `loadComposerDraftAttachments` before saving over this draft.
    return { text: record.text, attachments: [] };
  }
  return { text: record.text, attachments: record.attachments ?? [] };
}

/** Read a draft's attachment payloads from disk-backed storage, adopting
 *  payloads written before the move out of localStorage. */
export async function loadComposerDraftAttachments(
  key?: string,
  storage?: Storage,
): Promise<ComposerDraftAttachment[]> {
  const store = resolveDraftAttachmentStore();
  if (!store) return [];
  const normalizedKey = safeKey(key);
  const stored = await store.read(normalizedKey);
  if (stored.length > 0) return stored;
  const record = parseStoredDrafts(storage)[normalizedKey];
  const legacy = record?.attachments ?? [];
  if (legacy.length === 0) return [];
  if (!(await store.write(normalizedKey, legacy))) return [];
  const drafts = parseStoredDrafts(storage);
  const migrated = drafts[normalizedKey];
  if (migrated) {
    delete migrated.attachments;
    writeDrafts(drafts, storage);
  }
  return legacy;
}

export async function saveComposerDraft(
  key: string | undefined,
  text: string,
  value: readonly ComposerDraftAttachment[],
  storage?: Storage,
): Promise<boolean> {
  const drafts = parseStoredDrafts(storage);
  const normalizedKey = safeKey(key);
  const clippedText = text.slice(0, MAX_TEXT_CHARS);
  const attachments = value
    .filter((item) => item.type === 'image' || item.type === 'file')
    .map((item) => ({
      type: item.type,
      data: typeof item.data === 'string' ? item.data : '',
      name: safeName(item.name),
      ...(item.mimeType ? { mimeType: item.mimeType } : {}),
    }));
  const store = resolveDraftAttachmentStore();
  // The disk-backed store keeps an attachment of any size. Only the
  // localStorage-only runtime has a ceiling, and it bounds the stored copy so
  // the draft text stays recoverable.
  const keptAttachments = store ? attachments : fitInlineBudget(attachments);

  if (!clippedText && keptAttachments.length === 0) {
    // The user removed the text and every attachment themselves.
    delete drafts[normalizedKey];
    const persisted = writeDrafts(drafts, storage);
    if (store) await store.remove(normalizedKey);
    return persisted;
  }

  drafts[normalizedKey] = {
    text: clippedText,
    ...(store ? {} : { attachments: keptAttachments }),
    updatedAt: Date.now(),
  };
  const persisted = writeDrafts(drafts, storage);

  if (store) {
    // Typing must not rewrite megabytes of image data on every keystroke. The
    // composer keeps the same array instance until an attachment actually
    // changes, so an unchanged reference means the stored payload is current.
    if (lastPayloadWrite.get(normalizedKey) === value) return persisted;
    lastPayloadWrite.set(normalizedKey, value);
    if (!(await store.write(normalizedKey, keptAttachments))) {
      // The platform refused the payload (quota, private mode). The draft text
      // is already saved and the attachment stays attached in the composer.
      // Forget the memo so the next save retries instead of assuming the stored
      // payload is current, and never remove what is already on disk: a refused
      // write replaced nothing.
      lastPayloadWrite.delete(normalizedKey);
    }
  }

  return persisted;
}

export function clearComposerDraft(key?: string, storage?: Storage): void {
  const drafts = parseStoredDrafts(storage);
  const normalizedKey = safeKey(key);
  delete drafts[normalizedKey];
  writeDrafts(drafts, storage);
  lastPayloadWrite.delete(normalizedKey);
  const store = resolveDraftAttachmentStore();
  if (store) void store.remove(normalizedKey);
}
