import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDb } from '../../db';
import {
  createNote,
  getNote,
  getNoteOutlinks,
  linkNotes,
  listNotes,
  syncProjectDocuments,
  updateNote,
} from '../notes-service';
let root: string;
beforeAll(() => initDb());
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kory-document-edges-'));
  mkdirSync(join(root, 'docs'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function byPath(path: string) {
  return (await listNotes(undefined, root)).find((note) => note.sourcePath === path)!;
}
describe('consistent document-reference projection', () => {
  test('editor saves and synchronized link changes retain Markdown/HTML path references', async () => {
    writeFileSync(
      join(root, 'docs', 'source.md'),
      '# Source\n[Target](../target.md)\n<a href="../other.html">Other</a>',
    );
    writeFileSync(join(root, 'target.md'), '# Target');
    writeFileSync(join(root, 'other.html'), '<h1>Other</h1>');
    await syncProjectDocuments(root);
    const source = await byPath('docs/source.md');
    const target = await byPath('target.md');
    const other = await byPath('other.html');
    const current = (await getNote(source.id, root))!;
    await updateNote(
      source.id,
      { content: current.content + '\nAn editor change.', expectedRevision: current.revision },
      root,
    );
    expect((await getNoteOutlinks(source.id, root)).map((note) => note.id).sort()).toEqual(
      [target.id, other.id].sort(),
    );
    const linked = await createNote({ title: 'Independent evidence', content: 'Evidence.' }, root);
    await linkNotes(source.id, linked.id, { syncContent: true }, root);
    expect((await getNoteOutlinks(source.id, root)).map((note) => note.id).sort()).toEqual(
      [target.id, other.id, linked.id].sort(),
    );
  });

  test('new project targets resolve older ordinary path references without editing the source', async () => {
    writeFileSync(join(root, 'docs', 'source.md'), '# Source\n[Future](../future.md)');
    await syncProjectDocuments(root);
    const source = await byPath('docs/source.md');
    expect(await getNoteOutlinks(source.id, root)).toHaveLength(0);
    writeFileSync(join(root, 'future.md'), '# Future');
    await syncProjectDocuments(root);
    const target = await byPath('future.md');
    expect((await getNoteOutlinks(source.id, root)).map((note) => note.id)).toContain(target.id);
  });
});
