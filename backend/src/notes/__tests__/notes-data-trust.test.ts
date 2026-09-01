import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../../db';
import {
  createNote,
  createVaultExport,
  deleteNote,
  getAttachment,
  getNote,
  getNoteRevision,
  listNoteRevisions,
  listNotes,
  listTrashedNotes,
  restoreNote,
  restoreNoteRevision,
  saveAttachment,
  syncProjectDocuments,
  updateNote,
} from '../notes-service';

let fixtureRoot = '';

beforeAll(async () => {
  await initDb();
  fixtureRoot = mkdtempSync(join(tmpdir(), 'kory-notes-data-trust-'));
});

afterAll(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

async function readArtifact(body: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(body).arrayBuffer());
}

function readTar(buffer: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    const start = offset + 512;
    files.set(name, Buffer.from(buffer.subarray(start, start + size)));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

describe('Notes data trust', () => {
  test('trash is reversible and retains attachment bytes and immutable history', async () => {
    const project = join(fixtureRoot, 'trash-restore');
    mkdirSync(project, { recursive: true });
    const created = await createNote(
      {
        title: 'Durable decision',
        content: 'Version one',
        folderPath: '/Decisions',
        tags: ['durable'],
        pinned: true,
        includeInContext: true,
      },
      project,
    );
    const updated = await updateNote(
      created.id,
      { content: 'Version two', expectedRevision: created.revision },
      project,
    );
    const attachment = await saveAttachment(
      created.id,
      'evidence.txt',
      'text/plain',
      Buffer.from('retained evidence'),
      project,
    );
    const storedAttachment = await getAttachment(attachment.id, project);
    expect(storedAttachment).not.toBeNull();

    const trashed = await deleteNote(created.id, project, updated.revision);
    expect(trashed.revision).toBe(updated.revision + 1);
    expect(await getNote(created.id, project)).toBeNull();
    expect((await listTrashedNotes(project)).map((note) => note.id)).toContain(created.id);
    expect(existsSync(storedAttachment!.storagePath)).toBe(true);

    const restored = await restoreNote(created.id, project, trashed.revision);
    expect(restored).toMatchObject({
      content: 'Version two',
      folderPath: '/Decisions',
      tags: ['durable'],
      pinned: true,
      includeInContext: true,
    });
    expect(await getAttachment(attachment.id, project)).not.toBeNull();

    const history = await listNoteRevisions(created.id, project);
    expect(history.map((entry) => entry.operation)).toEqual([
      'restore',
      'trash',
      'update',
      'create',
    ]);
    expect(history.map((entry) => entry.revision)).toEqual([4, 3, 2, 1]);
    expect((await getNoteRevision(created.id, 1, project))?.content).toBe('Version one');
  });

  test('restores any historical state as a new monotonic revision', async () => {
    const project = join(fixtureRoot, 'revision-restore');
    mkdirSync(project, { recursive: true });
    const original = await createNote(
      { title: 'Rollback target', content: 'Original body', tags: ['original'] },
      project,
    );
    const changed = await updateNote(
      original.id,
      {
        title: 'Changed title',
        content: 'Changed body',
        tags: ['changed'],
        expectedRevision: original.revision,
      },
      project,
    );

    const restored = await restoreNoteRevision(original.id, 1, changed.revision, project);
    expect(restored).toMatchObject({
      title: 'Rollback target',
      content: 'Original body',
      tags: ['original'],
      revision: 3,
    });
    expect((await listNoteRevisions(original.id, project))[0]).toMatchObject({
      revision: 3,
      operation: 'revision_restore',
    });
  });

  test('ordinary trash never deletes a project-backed source document', async () => {
    const project = join(fixtureRoot, 'project-source-trash');
    mkdirSync(project, { recursive: true });
    const source = join(project, 'source.md');
    writeFileSync(source, '# Source\n\nKeep me.\n');
    await syncProjectDocuments(project);
    const note = (await listNotes(undefined, project)).find(
      (candidate) => candidate.sourcePath === 'source.md',
    );
    expect(note).toBeTruthy();

    const trashed = await deleteNote(note!.id, project, note!.revision);
    expect(existsSync(source)).toBe(true);
    expect(readFileSync(source, 'utf8')).toContain('Keep me');
    expect(await getNote(note!.id, project)).toBeNull();

    const restored = await restoreNote(note!.id, project, trashed.revision);
    expect(restored.content).toContain('Keep me');
    expect(existsSync(source)).toBe(true);
  });

  test('external source removal is recoverable and a reappeared file restores automatically', async () => {
    const project = join(fixtureRoot, 'external-source-recovery');
    mkdirSync(project, { recursive: true });
    const source = join(project, 'returning.md');
    writeFileSync(source, '# Returning\n\nFirst copy.\n');
    await syncProjectDocuments(project);
    const note = (await listNotes(undefined, project)).find(
      (candidate) => candidate.sourcePath === 'returning.md',
    );
    expect(note).toBeTruthy();

    rmSync(source);
    expect((await syncProjectDocuments(project)).removed).toBe(1);
    expect(await getNote(note!.id, project)).toBeNull();
    expect((await listTrashedNotes(project))[0]).toMatchObject({
      id: note!.id,
      trashReason: 'source_removed',
    });

    writeFileSync(source, '# Returning\n\nSecond copy.\n');
    await syncProjectDocuments(project);
    expect((await getNote(note!.id, project))?.content).toContain('Second copy');
    expect((await listNoteRevisions(note!.id, project)).map((entry) => entry.operation)).toEqual([
      'restore',
      'source_removed',
      'create',
    ]);
  });

  test('whole-vault export is deterministic, complete, and project scoped', async () => {
    const firstProject = join(fixtureRoot, 'export-first');
    const secondProject = join(fixtureRoot, 'export-second');
    mkdirSync(firstProject, { recursive: true });
    mkdirSync(secondProject, { recursive: true });
    const first = await createNote(
      {
        title: 'Exported note',
        content: '# First\n\nVersion one.',
        folderPath: '/Export',
        tags: ['portable'],
        pinned: true,
        includeInContext: true,
      },
      firstProject,
    );
    const revised = await updateNote(
      first.id,
      { content: '# First\n\nVersion two.', expectedRevision: first.revision },
      firstProject,
    );
    const attachment = await saveAttachment(
      first.id,
      'proof.txt',
      'text/plain',
      Buffer.from('archive proof'),
      firstProject,
    );
    const hidden = await createNote(
      { title: 'Recoverable export', content: 'Still exported from trash.' },
      firstProject,
    );
    await deleteNote(hidden.id, firstProject, hidden.revision);
    const foreign = await createNote(
      { title: 'Must never cross scope', content: 'foreign project' },
      secondProject,
    );

    const firstArchive = await createVaultExport(firstProject);
    const firstBytes = await readArtifact(firstArchive.body);
    const secondArchive = await createVaultExport(firstProject);
    const secondBytes = await readArtifact(secondArchive.body);
    expect(firstBytes.equals(secondBytes)).toBe(true);

    const files = readTar(firstBytes);
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8')) as {
      notes: Array<Record<string, unknown>>;
      revisions: Array<Record<string, unknown>>;
      attachments: Array<Record<string, unknown>>;
    };
    expect(manifest.notes.map((note) => note.id)).toContain(first.id);
    expect(manifest.notes.map((note) => note.id)).toContain(hidden.id);
    expect(manifest.notes.map((note) => note.id)).not.toContain(foreign.id);
    expect(manifest.notes.find((note) => note.id === first.id)).toMatchObject({
      folderPath: '/Export',
      tags: ['portable'],
      pinned: true,
      includeInContext: true,
      revision: revised.revision,
    });
    expect(
      manifest.revisions.filter((revision) => revision.noteId === first.id).map((r) => r.revision),
    ).toEqual([1, 2]);
    const exportedAttachment = manifest.attachments.find((entry) => entry.id === attachment.id);
    expect(exportedAttachment).toMatchObject({
      noteId: first.id,
      filename: 'proof.txt',
      mimeType: 'text/plain',
      size: 13,
    });
    expect(files.get(exportedAttachment!.path as string)?.toString('utf8')).toBe('archive proof');
  });
});
