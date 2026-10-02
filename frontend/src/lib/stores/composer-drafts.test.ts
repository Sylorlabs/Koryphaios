import { beforeEach, describe, expect, test } from 'vitest';
import {
  clearComposerDraft,
  draftAttachmentsAreExternal,
  loadComposerDraft,
  loadComposerDraftAttachments,
  saveComposerDraft,
  setDraftAttachmentStore,
  type ComposerDraftAttachment,
} from './composer-drafts';
import type { DraftAttachmentStore } from './composer-draft-attachments';

/** An in-memory stand-in for the disk-backed payload store, including a mode
 *  where the platform refuses writes the way a full quota does. */
function memoryStore(options: { refuseWrites?: boolean } = {}): DraftAttachmentStore & {
  payloads: Map<string, ComposerDraftAttachment[]>;
  writes: number;
} {
  const payloads = new Map<string, ComposerDraftAttachment[]>();
  const store = {
    external: true,
    payloads,
    writes: 0,
    async read(key: string) {
      return payloads.get(key) ?? [];
    },
    async write(key: string, attachments: readonly ComposerDraftAttachment[]) {
      if (options.refuseWrites) return false;
      store.writes++;
      if (attachments.length === 0) payloads.delete(key);
      else
        payloads.set(
          key,
          attachments.map((item) => ({ ...item })),
        );
      return true;
    },
    async remove(key: string) {
      payloads.delete(key);
    },
  };
  return store;
}

const STORAGE_KEY = 'koryphaios-composer-drafts-v1';

function readRecord(key: string): Record<string, unknown> {
  const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<
    string,
    Record<string, unknown>
  >;
  return parsed[key] ?? {};
}

describe('composer draft recovery', () => {
  beforeEach(() => {
    localStorage.clear();
    setDraftAttachmentStore(null);
  });

  test('recovers text and attachments per session from local storage only', async () => {
    const attachments: ComposerDraftAttachment[] = [
      { type: 'file', name: 'brief.txt', mimeType: 'text/plain', data: 'aGVsbG8=' },
    ];
    expect(await saveComposerDraft('session-a', 'Keep this', attachments)).toBe(true);

    expect(loadComposerDraft('session-a')).toEqual({ text: 'Keep this', attachments });
    expect(loadComposerDraft('session-b').text).toBe('');
  });

  test('keeps images of any size when payloads are stored outside localStorage', async () => {
    const store = memoryStore();
    setDraftAttachmentStore(store);
    const image: ComposerDraftAttachment = {
      type: 'image',
      name: 'screenshot.png',
      mimeType: 'image/png',
      // Far past the old ~160k character inline ceiling.
      data: 'A'.repeat(3_000_000),
    };

    expect(await saveComposerDraft('session-a', 'look at this', [image])).toBe(true);
    expect(draftAttachmentsAreExternal()).toBe(true);
    // The localStorage record keeps text only, so the origin budget is intact.
    expect(readRecord('session-a')).not.toHaveProperty('attachments');
    expect(loadComposerDraft('session-a').text).toBe('look at this');
    expect(await loadComposerDraftAttachments('session-a')).toEqual([image]);
  });

  test('a refused payload write leaves the draft text and the stored image alone', async () => {
    const store = memoryStore();
    setDraftAttachmentStore(store);
    const image: ComposerDraftAttachment = {
      type: 'image',
      name: 'huge.png',
      data: 'B'.repeat(2_000_000),
    };
    expect(await saveComposerDraft('session-a', 'keep the prompt', [image])).toBe(true);

    // The platform now refuses writes the way a full quota does. The draft text
    // is still saved, and a refused write must not destroy what is on disk.
    setDraftAttachmentStore(memoryStore({ refuseWrites: true }));
    expect(await saveComposerDraft('session-a', 'keep the prompt', [])).toBe(true);
    expect(loadComposerDraft('session-a').text).toBe('keep the prompt');
    expect(store.payloads.get('session-a')).toEqual([image]);
  });

  test('adopts payloads written before drafts moved to disk-backed storage', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        'session-a': {
          text: 'older draft',
          updatedAt: Date.now(),
          attachments: [{ type: 'image', name: 'legacy.png', data: 'Z'.repeat(500_000) }],
        },
      }),
    );
    const store = memoryStore();
    setDraftAttachmentStore(store);

    expect(loadComposerDraft('session-a').text).toBe('older draft');
    const attachments = await loadComposerDraftAttachments('session-a');
    expect(attachments).toHaveLength(1);
    expect(attachments[0].name).toBe('legacy.png');
    expect(store.payloads.get('session-a')).toHaveLength(1);
    // The inline copy is dropped once the payload store owns it.
    expect(readRecord('session-a')).not.toHaveProperty('attachments');
  });

  test('bounds the inline budget so the draft text stays recoverable', async () => {
    const attachments: ComposerDraftAttachment[] = [
      { type: 'file', name: 'oversized.log', data: 'c'.repeat(200_000) },
      { type: 'file', name: 'first.log', data: 'a'.repeat(160_000) },
      { type: 'file', name: 'second.log', data: 'b'.repeat(160_000) },
      { type: 'file', name: 'third.log', data: 'd'.repeat(160_000) },
      { type: 'file', name: 'over-budget.log', data: 'e' },
    ];
    expect(await saveComposerDraft('session-a', 'Keep the prompt', attachments)).toBe(true);
    // The attachments that fit are stored; the oversized ones are left out of
    // the shared string budget so the prompt itself is never the casualty.
    const recovered = loadComposerDraft('session-a');
    expect(recovered.text).toBe('Keep the prompt');
    expect(recovered.attachments).toEqual(attachments.slice(1, 4));
  });

  test('uses matching browser storage globals with independent session storage', async () => {
    expect(localStorage).toBe(window.localStorage);
    expect(sessionStorage).toBe(window.sessionStorage);
    expect(localStorage).not.toBe(sessionStorage);
    await saveComposerDraft('session-a', 'Local draft', []);
    expect(window.localStorage.getItem(STORAGE_KEY)).toContain('Local draft');
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test('does not rewrite an unchanged payload on every keystroke', async () => {
    const store = memoryStore();
    setDraftAttachmentStore(store);
    const image: ComposerDraftAttachment = {
      type: 'image',
      name: 'shot.png',
      data: 'D'.repeat(1_000_000),
    };
    const attachments = [image];
    await saveComposerDraft('session-a', 'fir', attachments);
    expect(store.writes).toBe(1);

    // Same array instance, new text: the stored image is already current.
    await saveComposerDraft('session-a', 'first', attachments);
    expect(store.writes).toBe(1);

    // A new attachment is a real change and must be written.
    await saveComposerDraft('session-a', 'first', [...attachments, image]);
    expect(store.writes).toBe(2);
  });

  test('never expires a draft or its images by age', async () => {
    const store = memoryStore();
    setDraftAttachmentStore(store);
    const image: ComposerDraftAttachment = {
      type: 'image',
      name: 'old.png',
      data: 'E'.repeat(400_000),
    };
    await saveComposerDraft('session-a', 'still unsent', [image]);

    // A month later the draft is exactly as recoverable as it was.
    const monthLater = Date.now() + 31 * 24 * 60 * 60 * 1_000;
    const realNow = Date.now;
    Date.now = () => monthLater;
    try {
      expect(loadComposerDraft('session-a').text).toBe('still unsent');
      expect(await loadComposerDraftAttachments('session-a')).toEqual([image]);
    } finally {
      Date.now = realNow;
    }
  });

  test('evicting draft text to fit the budget never deletes the payload', async () => {
    const store = memoryStore();
    setDraftAttachmentStore(store);
    // Distinct timestamps so eviction order is deterministic, not arrival order.
    let now = Date.now();
    const realNow = Date.now;
    Date.now = () => (now += 1_000);
    const keys: string[] = [];
    try {
      // Far more text than the budget allows, each draft owning an image.
      for (let index = 0; index < 40; index += 1) {
        const key = `session-${index}`;
        keys.push(key);
        await saveComposerDraft(key, `${index}`.repeat(60_000), [
          { type: 'image', name: `${index}.png`, data: 'F'.repeat(200_000) },
        ]);
      }
    } finally {
      Date.now = realNow;
    }

    const storedKeys = Object.keys(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as object);
    expect(storedKeys.length).toBeLessThan(keys.length);
    expect(storedKeys).toContain(keys[keys.length - 1]);
    // Every image is still on disk, including the ones whose draft text aged out
    // of the index: only the user may remove an attachment.
    for (const key of keys) expect(store.payloads.has(key)).toBe(true);
  });

  test('removes a sent or discarded draft and its payloads', async () => {
    const store = memoryStore();
    setDraftAttachmentStore(store);
    await saveComposerDraft('session-a', 'Send me', [
      { type: 'image', name: 'shot.png', data: 'C'.repeat(400_000) },
    ]);
    expect(store.payloads.get('session-a')).toHaveLength(1);

    clearComposerDraft('session-a');
    expect(loadComposerDraft('session-a')).toEqual({ text: '', attachments: [] });
    expect(store.payloads.has('session-a')).toBe(false);
  });
});
