import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../../db';
import { ValidationError } from '../../errors/types';
import * as notes from '../notes-service';
import {
  deleteFolderAppearance,
  deleteTagAppearance,
  listNotesAppearance,
  moveFolderAppearance,
  renameNoteFolder,
  setFolderAppearance,
  setTagAppearance,
} from '../notes-appearance';

const root = mkdtempSync(join(tmpdir(), 'kory-note-appearance-'));

beforeAll(async () => {
  await initDb();
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function reset(): void {
  writeFileSync(join(root, 'koryphaios.json'), '{}');
}

describe('folder appearance', () => {
  test('merges fields, clears on null, and drops a record with nothing left', () => {
    reset();
    setFolderAppearance(root, { path: '/Projects/api', emoji: '🚀' });
    setFolderAppearance(root, { path: '/Projects/api', color: 'teal' });
    expect(listNotesAppearance(root).folders).toEqual([
      { path: '/Projects/api', emoji: '🚀', color: 'teal' },
    ]);

    setFolderAppearance(root, { path: '/Projects/api', emoji: null });
    expect(listNotesAppearance(root).folders).toEqual([{ path: '/Projects/api', color: 'teal' }]);

    expect(setFolderAppearance(root, { path: '/Projects/api', color: null })).toBeNull();
    expect(listNotesAppearance(root).folders).toEqual([]);
  });

  test('rejects invalid input with a validation error and stores nothing', () => {
    reset();
    expect(() => setFolderAppearance(root, { path: '/x', emoji: 'two 🚀🚀' })).toThrow(
      ValidationError,
    );
    expect(() => setFolderAppearance(root, { path: '/x', color: 'red' })).toThrow(ValidationError);
    expect(() => setFolderAppearance(root, { path: '/a/../b', emoji: '🚀' })).toThrow(
      ValidationError,
    );
    expect(listNotesAppearance(root).folders).toEqual([]);
  });

  test('deleting a folder drops its appearance and descendants, not siblings sharing a prefix', () => {
    reset();
    setFolderAppearance(root, { path: '/Projects', emoji: '📁' });
    setFolderAppearance(root, { path: '/Projects/api', emoji: '🚀' });
    setFolderAppearance(root, { path: '/Projectsx', emoji: '🧪' });
    expect(deleteFolderAppearance(root, '/Projects')).toBe(2);
    expect(listNotesAppearance(root).folders.map((folder) => folder.path)).toEqual(['/Projectsx']);
  });

  test('moving a folder carries its appearance and its sub-folders, replacing the target', () => {
    reset();
    setFolderAppearance(root, { path: '/Old', emoji: '📦' });
    setFolderAppearance(root, { path: '/Old/deep', color: 'rose' });
    setFolderAppearance(root, { path: '/New', emoji: '🗃️' });
    expect(moveFolderAppearance(root, '/Old', '/New')).toBe(true);
    expect(listNotesAppearance(root).folders).toEqual([
      { path: '/New', emoji: '📦' },
      { path: '/New/deep', color: 'rose' },
    ]);
    expect(moveFolderAppearance(root, '/Missing', '/Anywhere')).toBe(false);
  });

  test('hand-edited invalid entries are dropped instead of breaking the project', () => {
    reset();
    writeFileSync(
      join(root, 'koryphaios.json'),
      JSON.stringify({
        notesAppearance: {
          folders: [
            { path: '/good', emoji: '✅' },
            { path: '/bad', color: 'url(x)' },
            'not-an-object',
          ],
          tags: [{ tag: 'ok', color: 'blue' }, { tag: '' }],
        },
      }),
    );
    expect(listNotesAppearance(root)).toEqual({
      folders: [{ path: '/good', emoji: '✅' }],
      tags: [{ tag: 'ok', color: 'blue' }],
    });
  });
});

describe('tag appearance', () => {
  test('sets, updates and deletes tag appearance without touching folders', () => {
    reset();
    setTagAppearance(root, { tag: 'urgent', color: 'rose', emoji: '🔥' });
    expect(setTagAppearance(root, { tag: 'urgent', emoji: null })).toEqual({
      tag: 'urgent',
      color: 'rose',
    });
    expect(listNotesAppearance(root)).toEqual({
      folders: [],
      tags: [{ tag: 'urgent', color: 'rose' }],
    });
    expect(deleteTagAppearance(root, 'urgent')).toBe(true);
    expect(deleteTagAppearance(root, 'urgent')).toBe(false);
  });

  test('the appearance lives in the project koryphaios.json next to notesSettings', () => {
    reset();
    setTagAppearance(root, { tag: 'idea', emoji: '💡' });
    const config = JSON.parse(readFileSync(join(root, 'koryphaios.json'), 'utf-8'));
    expect(config.notesAppearance.tags).toEqual([{ tag: 'idea', emoji: '💡' }]);
  });
});

describe('folder rename', () => {
  test('moves notes beneath the folder, carries appearance, and leaves look-alike folders alone', async () => {
    reset();
    const inside = await notes.createNote(
      { title: 'Spec', content: 'body', folderPath: '/Projects/api' },
      root,
    );
    const nested = await notes.createNote(
      { title: 'Nested', content: 'body', folderPath: '/Projects/api/v1' },
      root,
    );
    const lookalike = await notes.createNote(
      { title: 'Other', content: 'body', folderPath: '/Projects/apiv2' },
      root,
    );
    setFolderAppearance(root, { path: '/Projects/api', emoji: '🚀' });

    const result = await renameNoteFolder(root, '/Projects/api', '/Archive/api');

    expect(result).toMatchObject({
      from: '/Projects/api',
      to: '/Archive/api',
      movedNotes: 2,
      skippedProjectDocuments: 0,
      appearanceMoved: true,
    });
    expect((await notes.getNote(inside.id, root))!.folderPath).toBe('/Archive/api');
    expect((await notes.getNote(nested.id, root))!.folderPath).toBe('/Archive/api/v1');
    expect((await notes.getNote(lookalike.id, root))!.folderPath).toBe('/Projects/apiv2');
    expect(listNotesAppearance(root).folders).toEqual([{ path: '/Archive/api', emoji: '🚀' }]);
  });

  test('refuses to rename the root or move a folder into itself', async () => {
    reset();
    await expect(renameNoteFolder(root, '/', '/x')).rejects.toThrow(ValidationError);
    await expect(renameNoteFolder(root, '/a', '/a/b')).rejects.toThrow(ValidationError);
    await expect(renameNoteFolder(root, '/a', '/a')).rejects.toThrow(ValidationError);
  });
});
