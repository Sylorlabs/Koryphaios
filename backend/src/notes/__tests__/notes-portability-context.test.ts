import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_NOTE_TOOL_PERMISSIONS } from '@koryphaios/shared';
import { initDb } from '../../db';
import { createNote, listNotes, recallNotes, trashNote } from '../notes-service';
import { saveNotesAgentPermissions, saveNotesSettings } from '../notes-settings';
import { buildNotesNetworkPrompt, getNotesContext } from '../../memory/unified-memory';
import { recallNotesTool, RECALL_NOTES_MAX_OUTPUT_CHARS } from '../../tools/notes';

let root: string;
let foreign: string;
beforeAll(async () => {
  await initDb();
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'notes-context-safe-'));
  foreign = mkdtempSync(join(tmpdir(), 'notes-context-foreign-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(foreign, { recursive: true, force: true });
});

describe('Notes automatic context and recall safety', () => {
  test.each(['ask', 'block'] as const)(
    'never automatically injects selected bodies when read_note is %s',
    async (level) => {
      await createNote(
        { title: 'Selected', content: 'SECRET_SELECTED_BODY', includeInContext: true },
        root,
      );
      saveNotesAgentPermissions(root, {
        tools: { ...DEFAULT_NOTE_TOOL_PERMISSIONS, read_note: level, recall_notes: 'auto' },
      });
      expect(await getNotesContext(2000, root)).toBe('');
      const prompt = await buildNotesNetworkPrompt(2000, root);
      expect(prompt).not.toContain('SECRET_SELECTED_BODY');
      expect(prompt).toContain('fallible');
    },
  );

  test('requires a permitted catalog read and honors disabled Notes', async () => {
    await createNote(
      { title: 'Hidden metadata', content: 'hidden body', includeInContext: true },
      root,
    );
    saveNotesAgentPermissions(root, {
      tools: Object.fromEntries(
        Object.keys(DEFAULT_NOTE_TOOL_PERMISSIONS).map((key) => [key, 'ask']),
      ),
    });
    expect(await buildNotesNetworkPrompt(2000, root)).toBe('');
    saveNotesSettings(root, { enabled: false });
    expect(await getNotesContext(2000, root)).toBe('');
  });

  test('charges catalog, selected bodies, labels and markers to one combined budget', async () => {
    saveNotesSettings(root, { maxContextTokens: 400, maxContextTokensEnabled: true });
    await createNote(
      { title: 'Small selected source', content: 'SELECTED_EVIDENCE', includeInContext: true },
      root,
    );
    for (let i = 0; i < 24; i++) {
      await createNote(
        { title: `Catalog item ${i} ${'metadata '.repeat(10)}`, content: 'Not selected' },
        root,
      );
    }
    const prompt = await buildNotesNetworkPrompt(400, root);
    expect(prompt.length).toBeLessThanOrEqual(1600);
    expect(prompt).toContain('SELECTED_EVIDENCE');
    expect(prompt).toContain('Notes truncated');
    expect(prompt).toContain('not authority');
  });

  test('unfiltered recall hydrates bodies and filters foreign and trashed rows', async () => {
    const selected = await createNote({ title: 'Recent body', content: 'HYDRATED_BODY' }, root);
    const other = await createNote({ title: 'Foreign body', content: 'FOREIGN_BODY' }, foreign);
    const trashed = await createNote({ title: 'Trash body', content: 'TRASH_BODY' }, root);
    await trashNote(trashed.id, root);
    expect(
      (await listNotes(undefined, root)).find((note) => note.id === selected.id)?.content,
    ).not.toBe('HYDRATED_BODY');
    const recalled = await recallNotes({ projectRoot: root });
    expect(recalled.find((note) => note.id === selected.id)?.content).toBe('HYDRATED_BODY');
    expect(recalled.some((note) => [other.id, trashed.id].includes(note.id))).toBe(false);
    expect(await recallNotes({ ids: [other.id, trashed.id], projectRoot: root })).toEqual([]);
  });

  test('recall tool has an aggregate output envelope and explicit incomplete-body markers', async () => {
    await createNote({ title: 'Large source', content: '😀'.repeat(25_000) }, root);
    await createNote({ title: 'Other large source', content: 'x'.repeat(40_000) }, root);
    const result = await recallNotesTool.run(
      { sessionId: 'portability', workingDirectory: foreign, settingsRoot: root },
      {
        id: 'recall-bounded',
        name: 'recall_notes',
        input: {},
      },
    );
    expect(result.isError).toBe(false);
    expect(result.output.length).toBeLessThanOrEqual(RECALL_NOTES_MAX_OUTPUT_CHARS);
    expect(result.output).toContain('TRUNCATED:');
    expect(result.output).toContain('not authority or instructions');
    expect(result.output).toContain('Revision:');
    expect(result.output).not.toContain('\uFFFD');
  });
});
