import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDb } from '../../db';
import {
  deleteNote,
  getNote,
  listNotes,
  syncProjectDocuments,
  updateNote,
} from '../notes-service';

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
    expect(firstNotes.filter((note) => note.sourcePath === 'plan.md')).toHaveLength(1);
    expect(secondNotes.filter((note) => note.sourcePath === 'plan.md')).toHaveLength(1);
    expect(firstNotes.find((note) => note.sourcePath === 'plan.md')?.content).toContain('First plan');
    expect(secondNotes.find((note) => note.sourcePath === 'plan.md')?.content).toContain('Second plan');
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
});
