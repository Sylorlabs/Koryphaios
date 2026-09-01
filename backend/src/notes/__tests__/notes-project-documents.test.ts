import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

// These tests do heavy filesystem operations (mkdtemp, file sync, project
// scans) that are slow under parallel test load. Give them a generous timeout.
setDefaultTimeout(60000);
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDb } from '../../db';
import {
  createNote,
  deleteNote,
  getAttachment,
  getNote,
  getNoteRevision,
  importMemoryAsNotes,
  importMemoryAsNotesWithReport,
  listNotes,
  listNoteRevisions,
  resolveNoteRef,
  restoreNote,
  saveAttachment,
  syncProjectDocuments,
  updateNote,
} from '../notes-service';
import { writeProjectMemory } from '../../memory/unified-memory';

let fixtureRoot = '';
let firstProject = '';
let secondProject = '';

beforeAll(async () => {
  await initDb();
  fixtureRoot = mkdtempSync(join(tmpdir(), 'koryphaios-notes-'));
  firstProject = join(fixtureRoot, 'first-project');
  secondProject = join(fixtureRoot, 'second-project');
  mkdirSync(firstProject, { recursive: true });
  mkdirSync(secondProject, { recursive: true });
  writeFileSync(join(firstProject, 'plan.md'), '# First plan\n\n[[Shared decision]]\n');
  writeFileSync(join(secondProject, 'plan.md'), '# Second plan\n');
});

afterAll(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('project documents', () => {
  test('are scoped to their active project root even when paths overlap', async () => {
    await syncProjectDocuments(firstProject);
    await syncProjectDocuments(secondProject);

    const firstNotes = await listNotes(undefined, firstProject);
    const secondNotes = await listNotes(undefined, secondProject);
    const firstPlan = firstNotes.find((note) => note.sourcePath === 'plan.md');
    const secondPlan = secondNotes.find((note) => note.sourcePath === 'plan.md');
    expect(firstNotes.filter((note) => note.sourcePath === 'plan.md')).toHaveLength(1);
    expect(secondNotes.filter((note) => note.sourcePath === 'plan.md')).toHaveLength(1);
    expect(firstPlan?.id).not.toBe(secondPlan?.id);
    // listNotes intentionally returns metadata-only rows for the fast panel
    // listing path. Resolve content through the single-note contract, exactly
    // as the frontend does when a note is opened.
    expect((await getNote(firstPlan!.id))?.content).toContain('First plan');
    expect((await getNote(secondPlan!.id))?.content).toContain('Second plan');
  });

  test('writes agent/UI edits through to the authoritative Markdown file', async () => {
    const note = (await listNotes(undefined, firstProject)).find(
      (entry) => entry.sourcePath === 'plan.md',
    );
    expect(note).toBeTruthy();
    await updateNote(note!.id, { content: '# Revised plan\n\nVerified from Koryphaios.\n' });
    expect(readFileSync(join(firstProject, 'plan.md'), 'utf8')).toContain(
      'Verified from Koryphaios.',
    );
    expect((await getNote(note!.id))?.content).toContain('Revised plan');
  });

  test('does not rebuild links when only an unchanged file mtime moved', async () => {
    const unchangedProject = join(fixtureRoot, 'unchanged-mtime-project');
    mkdirSync(unchangedProject, { recursive: true });
    const source = join(unchangedProject, 'linked.md');
    writeFileSync(source, '# Linked\n\nSee [[Target]].\n');
    writeFileSync(join(unchangedProject, 'target.md'), '# Target\n');
    await syncProjectDocuments(unchangedProject);

    const future = new Date(Date.now() + 5_000);
    utimesSync(source, future, future);

    const result = await syncProjectDocuments(unchangedProject);

    expect(result).toMatchObject({ created: 0, updated: 0, relinked: 0 });
  });

  test('preserves frontmatter tags and resolves duplicate filenames by source path', async () => {
    const project = join(fixtureRoot, 'frontmatter-and-qualified-links');
    mkdirSync(join(project, 'one'), { recursive: true });
    mkdirSync(join(project, 'two'), { recursive: true });
    writeFileSync(
      join(project, 'one', 'topic.md'),
      '---\ntags: [architecture, durable]\n---\n# First topic\n',
    );
    writeFileSync(join(project, 'two', 'topic.md'), '# Second topic\n');

    await syncProjectDocuments(project);
    const projectNotes = await listNotes(undefined, project);
    const first = projectNotes.find((note) => note.sourcePath === 'one/topic.md');
    const second = projectNotes.find((note) => note.sourcePath === 'two/topic.md');

    expect(first?.tags).toEqual(['project-file', 'markdown', 'architecture', 'durable']);
    expect(await resolveNoteRef('topic', project)).toBeNull();
    expect(await resolveNoteRef('one/topic.md', project)).toBe(first?.id);
    expect(await resolveNoteRef('/Project/two/topic', project)).toBe(second?.id);
  });

  test('preserves DB-owned metadata across an unambiguous byte-identical source move', async () => {
    const project = join(fixtureRoot, 'identity-relocation');
    mkdirSync(project, { recursive: true });
    const beforePath = join(project, 'before.md');
    const linkerPath = join(project, 'linker.md');
    writeFileSync(beforePath, '---\ntags: [decision]\n---\n# Durable decision\n');
    writeFileSync(linkerPath, '# Linker\n\nSee [[before]].\n');
    await syncProjectDocuments(project);

    const before = (await listNotes(undefined, project)).find(
      (note) => note.sourcePath === 'before.md',
    );
    expect(before).toBeTruthy();
    const personalized = await updateNote(
      before!.id,
      { pinned: true, includeInContext: true, expectedRevision: before!.revision },
      project,
    );
    const attachment = await saveAttachment(
      personalized.id,
      'evidence.txt',
      'text/plain',
      Buffer.from('move-safe evidence'),
      project,
    );

    mkdirSync(join(project, 'decisions'), { recursive: true });
    renameSync(beforePath, join(project, 'decisions', 'after.md'));
    const result = await syncProjectDocuments(project);
    const after = (await listNotes(undefined, project)).find(
      (note) => note.sourcePath === 'decisions/after.md',
    );

    expect(result).toMatchObject({
      identityRelocations: 1,
      ambiguousMoveCandidates: 0,
      created: 0,
      removed: 0,
    });
    expect(after).toMatchObject({
      pinned: true,
      includeInContext: true,
      tags: ['project-file', 'markdown', 'decision'],
    });
    expect(after?.id).not.toBe(before?.id);
    expect(await getNote(before!.id, project)).toBeNull();
    expect((await getAttachment(attachment.id, project))?.noteId).toBe(after?.id);
    expect((await listNoteRevisions(after!.id, project)).map((entry) => entry.revision)).toEqual([
      3, 2, 1,
    ]);
    expect((await getNoteRevision(after!.id, 1, project))?.sourcePath).toBe('before.md');
    expect(readFileSync(linkerPath, 'utf8')).toContain('[[after]]');
  });

  test('does not transfer metadata between unrelated files with identical content', async () => {
    const project = join(fixtureRoot, 'identity-copy-not-move');
    mkdirSync(project, { recursive: true });
    const oldPath = join(project, 'old.md');
    const newPath = join(project, 'new.md');
    const repeatedContent = '# Template\n\nSame bytes do not prove identity.\n';
    writeFileSync(oldPath, repeatedContent);
    await syncProjectDocuments(project);
    const oldNote = (await listNotes(undefined, project)).find(
      (note) => note.sourcePath === 'old.md',
    );
    expect(oldNote).toBeTruthy();
    await updateNote(oldNote!.id, { pinned: true, expectedRevision: oldNote!.revision }, project);

    // Create the copy while the old inode still exists, then remove the old
    // path. The bytes match exactly but this is provably not a rename.
    writeFileSync(newPath, repeatedContent);
    rmSync(oldPath);
    const result = await syncProjectDocuments(project);
    const newNote = (await listNotes(undefined, project)).find(
      (note) => note.sourcePath === 'new.md',
    );

    expect(result).toMatchObject({
      identityRelocations: 0,
      ambiguousMoveCandidates: 1,
      created: 1,
      removed: 1,
    });
    expect(newNote?.pinned).toBe(false);
    expect(newNote?.id).not.toBe(oldNote?.id);
  });

  test('moves a project note to recoverable trash without deleting its Markdown source', async () => {
    const note = (await listNotes(undefined, secondProject)).find(
      (entry) => entry.sourcePath === 'plan.md',
    );
    expect(note).toBeTruthy();
    const trashed = await deleteNote(note!.id, secondProject, note!.revision);
    expect(existsSync(join(secondProject, 'plan.md'))).toBe(true);
    expect(existsSync(join(firstProject, 'plan.md'))).toBe(true);
    expect(await getNote(note!.id, secondProject)).toBeNull();
    expect((await restoreNote(note!.id, secondProject, trashed.revision)).sourcePath).toBe(
      'plan.md',
    );
  });

  test('imports every project memory document without overwriting same-titled notes', async () => {
    const memoryRoot = join(fixtureRoot, 'memory-import-project');
    mkdirSync(join(memoryRoot, '.koryphaios', 'memory'), { recursive: true });
    writeProjectMemory(memoryRoot, '# Project memory\n\nFirst version.\n');
    writeFileSync(
      join(memoryRoot, '.koryphaios', 'memory', 'decisions.md'),
      '# Decisions\n\nUse local-first storage.\n',
    );

    const unrelated = await createNote({
      title: 'Project Memory',
      content: 'Do not replace this note.',
    });
    const fixtureImport = { readUniversalContent: () => '' };
    const imported = await importMemoryAsNotes(memoryRoot, fixtureImport);
    const importedProject = imported.find(
      (note) => note.title === 'Project Memory' && note.folderPath === '/Memory/Project',
    );
    const importedDecisions = imported.find((note) => note.title === 'Memory: decisions');

    expect(importedProject?.content).toContain('First version');
    expect(importedDecisions?.content).toContain('local-first storage');
    expect(importedProject?.tags.some((tag) => tag.includes(memoryRoot))).toBe(false);
    expect((await getNote(unrelated.id))?.content).toBe('Do not replace this note.');

    const unchanged = await importMemoryAsNotesWithReport(memoryRoot, fixtureImport);
    expect(unchanged.counts.created).toBe(0);
    expect(unchanged.counts.updated).toBe(0);
    expect(unchanged.counts.unchanged).toBeGreaterThanOrEqual(2);
    expect(unchanged.partial).toBe(false);

    const retagged = await updateNote(
      importedProject!.id,
      { tags: ['reviewed'], expectedRevision: importedProject!.revision },
      memoryRoot,
    );
    expect(retagged.tags).toEqual(['reviewed']);
    const afterPublicRetag = await importMemoryAsNotesWithReport(memoryRoot, fixtureImport);
    expect(
      afterPublicRetag.entries.find((entry) => entry.source.name === 'project.md')?.note?.id,
    ).toBe(importedProject?.id);
    expect(afterPublicRetag.counts.created).toBe(0);

    writeProjectMemory(memoryRoot, '# Project memory\n\nUpdated version.\n');
    const reimported = await importMemoryAsNotes(memoryRoot, fixtureImport);
    const updatedProject = reimported.find(
      (note) => note.title === 'Project Memory' && note.folderPath === '/Memory/Project',
    );
    expect(updatedProject?.id).toBe(importedProject?.id);
    expect(updatedProject?.content).toContain('Updated version');

    await Promise.all(
      [unrelated, ...reimported.filter((note) => note.folderPath === '/Memory/Project')].map(
        (note) => deleteNote(note.id),
      ),
    );
  });
});
