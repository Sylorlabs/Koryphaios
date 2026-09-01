import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, initDb } from '../../db';
import { noteAttachments } from '../../db/schema';
import { eq } from 'drizzle-orm';
import {
  createNote,
  deleteAttachment,
  deleteNote,
  getAttachment,
  getNote,
  getProjectSyncStatus,
  PROJECT_DOCUMENT_SCAN_LIMIT,
  listNotes,
  saveAttachment,
  syncProjectDocuments,
  updateNote,
} from '../notes-service';
import { saveNotesSettings } from '../notes-settings';
import {
  createProjectMemoryDocument,
  getProjectMemoryPath,
  getRulesPath,
  initializeProjectMemory,
  initializeRules,
  readProjectMemory,
  readProjectMemoryDocument,
  readRules,
  getNotesContext,
  writeProjectMemoryDocument,
} from '../../memory/unified-memory';

let fixtureRoot = '';
let firstProject = '';
let secondProject = '';

beforeAll(async () => {
  await initDb();
  fixtureRoot = mkdtempSync(join(tmpdir(), 'kory-notes-hardening-'));
  firstProject = join(fixtureRoot, 'first');
  secondProject = join(fixtureRoot, 'second');
  mkdirSync(firstProject, { recursive: true });
  mkdirSync(secondProject, { recursive: true });
});

afterAll(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('long-form Notes hardening', () => {
  test('isolates plain notes by authenticated project scope', async () => {
    const first = await createNote(
      { title: 'Shared title', content: 'first project body' },
      firstProject,
    );
    const second = await createNote(
      { title: 'Shared title', content: 'second project body' },
      secondProject,
    );

    expect((await listNotes(undefined, firstProject)).map((note) => note.id)).toContain(first.id);
    expect((await listNotes(undefined, firstProject)).map((note) => note.id)).not.toContain(
      second.id,
    );
    expect(await getNote(second.id, firstProject)).toBeNull();
    expect((await getNote(second.id, secondProject))?.content).toBe('second project body');

    await deleteNote(first.id, firstProject);
    await deleteNote(second.id, secondProject);
  });

  test('rejects stale saves instead of silently overwriting a newer revision', async () => {
    const note = await createNote({ title: 'Revision contract', content: 'v1' }, firstProject);
    const saved = await updateNote(
      note.id,
      { content: 'v2', expectedRevision: note.revision },
      firstProject,
    );

    expect(saved.revision).toBe(note.revision + 1);
    await expect(
      updateNote(
        note.id,
        { content: 'stale overwrite', expectedRevision: note.revision },
        firstProject,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    expect((await getNote(note.id, firstProject))?.content).toBe('v2');

    await expect(deleteNote(note.id, firstProject, note.revision)).rejects.toMatchObject({
      code: 'CONFLICT',
      statusCode: 409,
    });
    expect(await getNote(note.id, firstProject)).not.toBeNull();
    await deleteNote(note.id, firstProject, saved.revision);
  });

  test('supports essay-length notes and enforces a configured byte budget without truncation', async () => {
    const essay = `# Essay\n\n${'Long-form paragraph. '.repeat(12_000)}`;
    const note = await createNote({ title: 'Long essay', content: essay }, firstProject);
    expect((await getNote(note.id, firstProject))?.content).toBe(essay);

    saveNotesSettings(firstProject, { noteSizeLimitEnabled: true, maxNoteBytes: 65_536 });
    await expect(
      createNote({ title: 'Over budget', content: 'x'.repeat(70_000) }, firstProject),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE', statusCode: 413 });
    expect((await getNote(note.id, firstProject))?.content).toBe(essay);

    await deleteNote(note.id, firstProject);
  });

  test('validates and scopes generated-name attachments without exposing storage paths', async () => {
    const note = await createNote({ title: 'Attachment owner' }, firstProject);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const attachment = await saveAttachment(note.id, 'diagram.png', 'image/png', png, firstProject);

    expect(attachment).not.toHaveProperty('storagePath');
    expect(await getAttachment(attachment.id, secondProject)).toBeNull();
    const stored = await getAttachment(attachment.id, firstProject);
    expect(stored?.storagePath).toContain(join('.koryphaios', 'attachments'));
    expect(stored?.storagePath).not.toContain('diagram.png');

    await expect(
      saveAttachment(note.id, 'mismatch.png', 'image/png', Buffer.from('not a png'), firstProject),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      saveAttachment(note.id, 'quote".png', 'image/png', png, firstProject),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const unrelatedFile = join(fixtureRoot, 'must-not-be-read-or-deleted.txt');
    writeFileSync(unrelatedFile, 'unrelated user content');
    await db
      .update(noteAttachments)
      .set({ storagePath: unrelatedFile })
      .where(eq(noteAttachments.id, attachment.id));
    expect(await getAttachment(attachment.id, firstProject)).toBeNull();

    await deleteNote(note.id, firstProject);
    expect(existsSync(unrelatedFile)).toBe(true);
  });

  test('deletes an attachment file and its metadata together', async () => {
    const project = join(fixtureRoot, 'attachment-delete-normal');
    mkdirSync(project, { recursive: true });
    const note = await createNote({ title: 'Normal attachment delete' }, project);
    const attachment = await saveAttachment(
      note.id,
      'normal.txt',
      'text/plain',
      Buffer.from('delete me'),
      project,
    );
    const stored = await getAttachment(attachment.id, project);
    expect(stored).not.toBeNull();
    expect(existsSync(stored!.storagePath)).toBe(true);

    await deleteAttachment(attachment.id, project);

    expect(existsSync(stored!.storagePath)).toBe(false);
    expect(await getAttachment(attachment.id, project)).toBeNull();
    await deleteNote(note.id, project);
  });

  test('removes stale attachment metadata when its file is already missing', async () => {
    const project = join(fixtureRoot, 'attachment-delete-missing');
    mkdirSync(project, { recursive: true });
    const note = await createNote({ title: 'Missing attachment delete' }, project);
    const attachment = await saveAttachment(
      note.id,
      'missing.txt',
      'text/plain',
      Buffer.from('already gone'),
      project,
    );
    const stored = await getAttachment(attachment.id, project);
    expect(stored).not.toBeNull();
    unlinkSync(stored!.storagePath);

    await deleteAttachment(attachment.id, project);

    expect(await getAttachment(attachment.id, project)).toBeNull();
    await deleteNote(note.id, project);
  });

  test('retains attachment metadata when filesystem deletion fails so retry can recover', async () => {
    const project = join(fixtureRoot, 'attachment-delete-retry');
    mkdirSync(project, { recursive: true });
    const note = await createNote({ title: 'Retryable attachment delete' }, project);
    const attachment = await saveAttachment(
      note.id,
      'retry.txt',
      'text/plain',
      Buffer.from('retry me'),
      project,
    );
    const stored = await getAttachment(attachment.id, project);
    expect(stored).not.toBeNull();

    // A directory at the authorized attachment path makes unlink fail
    // reliably, including in privileged test environments where chmod
    // cannot reproduce EACCES/EPERM. On Linux the error code is EISDIR;
    // on macOS, unlink on a directory returns EPERM instead.
    unlinkSync(stored!.storagePath);
    mkdirSync(stored!.storagePath);

    await expect(deleteAttachment(attachment.id, project)).rejects.toMatchObject({
      code: expect.stringMatching(/^E(ISDIR|PERM)$/),
    });
    expect(await getAttachment(attachment.id, project)).not.toBeNull();
    expect(existsSync(stored!.storagePath)).toBe(true);

    rmSync(stored!.storagePath, { recursive: true, force: true });
    writeFileSync(stored!.storagePath, 'repaired storage entry');
    await deleteAttachment(attachment.id, project);

    expect(await getAttachment(attachment.id, project)).toBeNull();
    expect(existsSync(stored!.storagePath)).toBe(false);
    await deleteNote(note.id, project);
  });

  test('waits for the first project scan instead of returning a false empty catalog', async () => {
    const freshProject = join(fixtureRoot, 'fresh-catalog');
    mkdirSync(freshProject, { recursive: true });
    writeFileSync(join(freshProject, 'first-note.md'), '# Visible on first load\n');

    const firstLoad = await listNotes(undefined, freshProject);
    expect(firstLoad.some((note) => note.sourcePath === 'first-note.md')).toBe(true);
  });

  test('joins concurrent first readers to the same complete project scan', async () => {
    const freshProject = join(fixtureRoot, 'concurrent-catalog');
    mkdirSync(freshProject, { recursive: true });
    for (let index = 0; index < 80; index++) {
      writeFileSync(join(freshProject, `note-${index}.md`), `# Note ${index}\n`);
    }

    const [first, second] = await Promise.all([
      listNotes(undefined, freshProject),
      listNotes(undefined, freshProject),
    ]);
    expect(first.filter((note) => note.sourcePath).length).toBe(80);
    expect(second.filter((note) => note.sourcePath).length).toBe(80);
  });

  test('does not let a concurrent project scan overwrite an editor save', async () => {
    const project = join(fixtureRoot, 'sync-save-race');
    mkdirSync(project, { recursive: true });
    const source = join(project, 'decision.md');
    writeFileSync(source, '# Base\n');
    await syncProjectDocuments(project);
    const note = (await listNotes(undefined, project)).find(
      (candidate) => candidate.sourcePath === 'decision.md',
    );
    expect(note).toBeTruthy();

    // Force the scanner down its changed-file path without changing the bytes
    // the editor originally loaded.
    const future = new Date(Date.now() + 2_000);
    utimesSync(source, future, future);
    await Promise.all([
      syncProjectDocuments(project),
      updateNote(
        note!.id,
        { content: '# Saved in editor\n', expectedRevision: note!.revision },
        project,
      ),
    ]);

    expect((await getNote(note!.id, project))?.content).toBe('# Saved in editor\n');
    expect(readFileSync(source, 'utf8')).toBe('# Saved in editor\n');
  });

  test('refreshes an external disk edit into a reviewable revision before retrying a local draft', async () => {
    const project = join(fixtureRoot, 'external-disk-conflict');
    mkdirSync(project, { recursive: true });
    const source = join(project, 'budget.md');
    writeFileSync(source, '# Budget\n\nOriginal.\n');
    await syncProjectDocuments(project);
    const opened = (await listNotes(undefined, project)).find(
      (candidate) => candidate.sourcePath === 'budget.md',
    );
    expect(opened).toBeTruthy();

    writeFileSync(source, '# Budget\n\nChanged by another editor.\n');
    await expect(
      updateNote(
        opened!.id,
        {
          content: '# Budget\n\nMy local draft.\n',
          expectedRevision: opened!.revision,
        },
        project,
      ),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      statusCode: 409,
      details: { sourceChanged: true },
    });

    const refreshed = await getNote(opened!.id, project);
    expect(refreshed?.content).toContain('Changed by another editor');
    expect(refreshed?.revision).toBe(opened!.revision + 1);

    const retried = await updateNote(
      opened!.id,
      {
        content: '# Budget\n\nMy local draft.\n',
        expectedRevision: refreshed!.revision,
      },
      project,
    );
    expect(retried.revision).toBe(refreshed!.revision + 1);
    expect(readFileSync(source, 'utf8')).toContain('My local draft');
  });

  test('requires explicit review before recreating an externally deleted source', async () => {
    const project = join(fixtureRoot, 'external-disk-delete');
    mkdirSync(project, { recursive: true });
    const source = join(project, 'removed.md');
    writeFileSync(source, '# Removed\n\nOriginal.\n');
    await syncProjectDocuments(project);
    const opened = (await listNotes(undefined, project)).find(
      (candidate) => candidate.sourcePath === 'removed.md',
    );
    expect(opened).toBeTruthy();

    unlinkSync(source);
    await expect(
      updateNote(
        opened!.id,
        { content: '# Restored\n\nLocal draft.\n', expectedRevision: opened!.revision },
        project,
      ),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      statusCode: 409,
      details: { sourceDeleted: true, currentRevision: opened!.revision },
    });
    expect(existsSync(source)).toBe(false);

    const restored = await updateNote(
      opened!.id,
      {
        content: '# Restored\n\nLocal draft.\n',
        expectedRevision: opened!.revision,
        restoreDeletedSource: true,
      },
      project,
    );
    expect(restored.revision).toBe(opened!.revision + 1);
    expect(readFileSync(source, 'utf8')).toContain('Local draft');
  });

  test('skips an oversized selected note so a later small note can still enter context', async () => {
    const oversized = await createNote(
      {
        title: 'Oversized selected essay',
        content: `# Oversized\n\n${'large paragraph '.repeat(160)}`,
        includeInContext: true,
      },
      secondProject,
    );
    const small = await createNote(
      {
        title: 'Small selected decision',
        content: 'Keep the smaller decision visible.',
        includeInContext: true,
      },
      secondProject,
    );

    const context = await getNotesContext(120, secondProject);
    expect(context).toContain('Small selected decision');
    expect(context).not.toContain('Oversized selected essay');

    await deleteNote(oversized.id, secondProject);
    await deleteNote(small.id, secondProject);
  });

  test('serializes simultaneous attachment uploads at the configured count boundary', async () => {
    const note = await createNote({ title: 'Attachment count owner' }, secondProject);
    saveNotesSettings(secondProject, { maxAttachmentsPerNote: 1 });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const results = await Promise.allSettled([
      saveAttachment(note.id, 'first.png', 'image/png', png, secondProject),
      saveAttachment(note.id, 'second.png', 'image/png', png, secondProject),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    await deleteNote(note.id, secondProject);
  });

  test('reports a truncated project scan and never prunes documents it could not inspect', async () => {
    const scanProject = join(fixtureRoot, 'partial-scan');
    mkdirSync(scanProject, { recursive: true });
    const authoritative = join(scanProject, 'previous.md');
    writeFileSync(authoritative, '# Previous document\n');
    expect((await syncProjectDocuments(scanProject)).truncated).toBe(false);
    const previous = (await listNotes(undefined, scanProject)).find(
      (note) => note.sourcePath === 'previous.md',
    );
    expect(previous).toBeTruthy();
    // listNotes starts a throttled background refresh on first access. Join it
    // before mutating the fixture so this test exercises one deterministic scan.
    await syncProjectDocuments(scanProject);

    unlinkSync(authoritative);
    for (let index = 0; index < PROJECT_DOCUMENT_SCAN_LIMIT + 1; index++) {
      writeFileSync(join(scanProject, `document-${String(index).padStart(4, '0')}.md`), '# Doc\n');
    }
    const partial = await syncProjectDocuments(scanProject);

    expect(partial.truncated).toBe(true);
    expect(partial.scanLimitReached).toBe(true);
    expect(partial.discovered).toBe(PROJECT_DOCUMENT_SCAN_LIMIT);
    expect(partial.message).toContain('scan limit was reached');
    expect(getProjectSyncStatus(scanProject)).toMatchObject({
      state: 'partial',
      discovered: PROJECT_DOCUMENT_SCAN_LIMIT,
    });
    expect(await getNote(previous!.id, scanProject)).not.toBeNull();
  });
});

describe('long-form Memory documents', () => {
  test('keeps missing documents read-only until the user initializes them', () => {
    const emptyProject = join(fixtureRoot, 'empty-memory');
    mkdirSync(emptyProject, { recursive: true });

    expect(readProjectMemory(emptyProject).exists).toBe(false);
    expect(readRules(emptyProject).exists).toBe(false);
    expect(existsSync(getProjectMemoryPath(emptyProject))).toBe(false);
    expect(existsSync(getRulesPath(emptyProject))).toBe(false);

    expect(initializeProjectMemory(emptyProject).content).toContain('# Project Memory');
    expect(initializeRules(emptyProject).content).toContain('# Koryphaios Rules');
  });

  test('returns strong revisions and rejects stale custom-document updates', () => {
    const created = createProjectMemoryDocument(firstProject, 'architecture', 'memory');
    const initial = readProjectMemoryDocument(firstProject, created.name, 'memory');
    const essay = `# Architecture\n\n${'Decision record. '.repeat(8_000)}`;
    const saved = writeProjectMemoryDocument(
      firstProject,
      created.name,
      'memory',
      essay,
      initial.revision,
    );

    expect(saved.content).toBe(essay);
    expect(saved.revision).not.toBe(initial.revision);
    expect(() =>
      writeProjectMemoryDocument(
        firstProject,
        created.name,
        'memory',
        'stale overwrite',
        initial.revision,
      ),
    ).toThrow();
    expect(readProjectMemoryDocument(firstProject, created.name, 'memory').content).toBe(essay);
  });
});
