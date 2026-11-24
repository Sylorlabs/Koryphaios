import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictError, ValidationError } from '../errors/types';
import {
  applyHunkAction,
  assertRepoRelativePath,
  buildHunkPatch,
  diffRevision,
  normalizeRepoFilePath,
  parseFileDiff,
  readFileHunks,
} from './git-hunks';

let root: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

function numbered(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
}

/** Two changes separated by more than 2*3 context lines, so they are two hunks. */
function editTwoRegions(): void {
  const lines = numbered(30).split('\n');
  lines[2] = 'line 3 changed';
  lines[24] = 'line 25 changed';
  writeFileSync(join(repo, 'notes.txt'), lines.join('\n'));
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kory-hunks-')));
  repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Hunk Test');
  git(repo, 'config', 'user.email', 'hunk@example.test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'notes.txt'), numbered(30));
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Initial');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('parseFileDiff', () => {
  test('splits the file header from hunks and counts additions and deletions', () => {
    const diff = [
      'diff --git a/notes.txt b/notes.txt',
      'index 1111111..2222222 100644',
      '--- a/notes.txt',
      '+++ b/notes.txt',
      '@@ -1,3 +1,3 @@',
      ' line 1',
      '-line 2',
      '+line two',
      ' line 3',
      '@@ -10 +10 @@',
      '-line 10',
      '+line ten',
      '',
    ].join('\n');
    const parsed = parseFileDiff(diff);
    expect(parsed.prelude).toEqual([
      'diff --git a/notes.txt b/notes.txt',
      'index 1111111..2222222 100644',
      '--- a/notes.txt',
      '+++ b/notes.txt',
    ]);
    expect(parsed.hunks.map((hunk) => hunk.header)).toEqual(['@@ -1,3 +1,3 @@', '@@ -10 +10 @@']);
    expect(parsed.hunks[0]).toMatchObject({
      index: 0,
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      additions: 1,
      deletions: 1,
    });
    expect(parsed.hunks[1]).toMatchObject({
      index: 1,
      oldLines: 1,
      newLines: 1,
      additions: 1,
      deletions: 1,
    });
    expect(buildHunkPatch(parsed.prelude, parsed.hunks[1]!)).toBe(
      [...parsed.prelude, '@@ -10 +10 @@', '-line 10', '+line ten', ''].join('\n'),
    );
  });

  test('returns no hunks for an empty diff', () => {
    expect(parseFileDiff('')).toEqual({ prelude: [], hunks: [] });
  });
});

describe('repository path validation', () => {
  test('accepts repository-relative paths and rejects traversal, absolute and backslash forms', () => {
    expect(assertRepoRelativePath('src/app.ts')).toBe('src/app.ts');
    for (const bad of [
      '',
      '../outside.txt',
      'src/../../x',
      '/etc/passwd',
      'C:/x',
      'a\\b',
      'a//b',
      'a\0b',
    ]) {
      expect(() => assertRepoRelativePath(bad)).toThrow(ValidationError);
    }
    expect(() => normalizeRepoFilePath(repo, '../escape.txt')).toThrow(ValidationError);
  });
});

describe('hunk stage, unstage and revert', () => {
  test('stages exactly the selected hunk and leaves the other in the worktree diff', async () => {
    editTwoRegions();
    const listed = await readFileHunks(repo, 'notes.txt', false);
    expect(listed.hunks).toHaveLength(2);

    const after = await applyHunkAction(repo, {
      action: 'stage',
      file: 'notes.txt',
      hunkIndex: 0,
      hunkHeader: listed.hunks[0]!.header,
      revision: listed.revision,
    });

    const cached = git(repo, 'diff', '--cached', '--', 'notes.txt');
    expect(cached).toContain('+line 3 changed');
    expect(cached).not.toContain('line 25 changed');
    expect(after.hunks).toHaveLength(1);
    expect(after.hunks[0]!.lines).toContain('+line 25 changed');
    expect(after.revision).not.toBe(listed.revision);
  });

  test('unstages a staged hunk without touching the other staged hunk', async () => {
    editTwoRegions();
    // Stage both hunks, one at a time, re-reading the diff each time.
    for (let pass = 0; pass < 2; pass += 1) {
      const current = await readFileHunks(repo, 'notes.txt', false);
      await applyHunkAction(repo, {
        action: 'stage',
        file: 'notes.txt',
        hunkIndex: 0,
        hunkHeader: current.hunks[0]!.header,
        revision: current.revision,
      });
    }
    expect(git(repo, 'diff', '--', 'notes.txt')).toBe('');

    const staged = await readFileHunks(repo, 'notes.txt', true);
    expect(staged.hunks).toHaveLength(2);
    const result = await applyHunkAction(repo, {
      action: 'unstage',
      file: 'notes.txt',
      hunkIndex: 1,
      hunkHeader: staged.hunks[1]!.header,
      revision: staged.revision,
    });

    expect(result.staged).toBe(true);
    expect(result.hunks).toHaveLength(1);
    expect(git(repo, 'diff', '--cached', '--', 'notes.txt')).toContain('+line 3 changed');
    expect(git(repo, 'diff', '--cached', '--', 'notes.txt')).not.toContain('line 25 changed');
    expect(git(repo, 'diff', '--', 'notes.txt')).toContain('+line 25 changed');
  });

  test('reverts one worktree hunk and keeps the other change', async () => {
    editTwoRegions();
    const listed = await readFileHunks(repo, 'notes.txt', false);
    await applyHunkAction(repo, {
      action: 'revert',
      file: 'notes.txt',
      hunkIndex: 1,
      hunkHeader: listed.hunks[1]!.header,
      revision: listed.revision,
    });

    const content = readFileSync(join(repo, 'notes.txt'), 'utf8');
    expect(content).toContain('line 3 changed');
    expect(content).toContain('\nline 25\n');
    expect(content).not.toContain('line 25 changed');
    expect(git(repo, 'diff', '--cached', '--', 'notes.txt')).toBe('');
  });

  test('refuses a stale diff revision and changes nothing', async () => {
    editTwoRegions();
    const listed = await readFileHunks(repo, 'notes.txt', false);
    // The file changes after the diff was rendered.
    writeFileSync(join(repo, 'notes.txt'), numbered(30).replace('line 1\n', 'line one\n'));
    const before = git(repo, 'diff', '--', 'notes.txt');

    await expect(
      applyHunkAction(repo, {
        action: 'stage',
        file: 'notes.txt',
        hunkIndex: 0,
        hunkHeader: listed.hunks[0]!.header,
        revision: listed.revision,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(git(repo, 'diff', '--cached', '--', 'notes.txt')).toBe('');
    expect(git(repo, 'diff', '--', 'notes.txt')).toBe(before);
  });

  test('refuses a hunk whose header no longer matches the index it names', async () => {
    editTwoRegions();
    const listed = await readFileHunks(repo, 'notes.txt', false);
    await expect(
      applyHunkAction(repo, {
        action: 'stage',
        file: 'notes.txt',
        hunkIndex: 0,
        hunkHeader: listed.hunks[1]!.header,
        revision: listed.revision,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(git(repo, 'diff', '--cached', '--', 'notes.txt')).toBe('');
  });

  test('lists nothing for an untracked file, since it has no hunks to address', async () => {
    writeFileSync(join(repo, 'fresh.txt'), 'new\n');
    const listed = await readFileHunks(repo, 'fresh.txt', false);
    expect(listed.hunks).toEqual([]);
  });

  test('the revision token distinguishes the staged and unstaged views of the same text', () => {
    expect(diffRevision('x', false)).not.toBe(diffRevision('x', true));
    expect(diffRevision('x', false)).toBe(diffRevision('x', false));
  });
});
