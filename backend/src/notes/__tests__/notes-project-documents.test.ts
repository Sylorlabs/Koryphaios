import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

// These tests do heavy filesystem operations (mkdtemp, file sync, project
// scans) that are slow under parallel test load. Give them a generous timeout.
setDefaultTimeout(60000);
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDb } from '../../db';
import {
  createNote,
  deleteNote,
  getNote,
  importMemoryAsNotes,
  listNotes,
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
    const note = (await listNotes(undefined, firstProject)).find((entry) => entry.sourcePath === 'plan.md');
    expect(note).toBeTruthy();
    await updateNote(note!.id, { content: '# Revised plan\n\nVerified from Koryphaios.\n' });
    expect(readFileSync(join(firstProject, 'plan.md'), 'utf8')).toContain('Verified from Koryphaios.');
    expect((await getNote(note!.id))?.content).toContain('Revised plan');
  });

  test('deletes the backing Markdown file only for its matching project note', async () => {
    const note = (await listNotes(undefined, secondProject)).find((entry) => entry.sourcePath === 'plan.md');
    expect(note).toBeTruthy();
    await deleteNote(note!.id);
    expect(existsSync(join(secondProject, 'plan.md'))).toBe(false);
    expect(existsSync(join(firstProject, 'plan.md'))).toBe(true);
  });

  test('imports every project memory document without overwriting same-titled notes', async () => {
    const memoryRoot = join(fixtureRoot, 'memory-import-project');
    mkdirSync(join(memoryRoot, '.koryphaios', 'memory'), { recursive: true });
    writeProjectMemory(memoryRoot, '# Project memory\n\nFirst version.\n');
    writeFileSync(join(memoryRoot, '.koryphaios', 'memory', 'decisions.md'), '# Decisions\n\nUse local-first storage.\n');

    const unrelated = await createNote({ title: 'Project Memory', content: 'Do not replace this note.' });
    const imported = await importMemoryAsNotes(memoryRoot);
    const projectTag = `koryphaios-memory-import:project:${join(memoryRoot, '.koryphaios', 'memory', 'project.md')}`;
    const decisionTag = `koryphaios-memory-import:project:${join(memoryRoot, '.koryphaios', 'memory', 'decisions.md')}`;
    const importedProject = imported.find((note) => note.tags.includes(projectTag));
    const importedDecisions = imported.find((note) => note.tags.includes(decisionTag));

    expect(importedProject?.content).toContain('First version');
    expect(importedDecisions?.content).toContain('local-first storage');
    expect((await getNote(unrelated.id))?.content).toBe('Do not replace this note.');

    writeProjectMemory(memoryRoot, '# Project memory\n\nUpdated version.\n');
    const reimported = await importMemoryAsNotes(memoryRoot);
    const updatedProject = reimported.find((note) => note.tags.includes(projectTag));
    expect(updatedProject?.id).toBe(importedProject?.id);
    expect(updatedProject?.content).toContain('Updated version');

    await Promise.all([
      unrelated,
      ...reimported.filter((note) => note.tags.includes(projectTag) || note.tags.includes(decisionTag)),
    ].map((note) => deleteNote(note.id)));
  });
});
