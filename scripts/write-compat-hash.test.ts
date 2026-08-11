import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inspectGitSnapshot, resolveHash } from './write-compat-hash';

const temporaryRoots: string[] = [];

function makeRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-compat-hash-test-'));
  temporaryRoots.push(root);
  const runGit = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });

  runGit(['init', '-q']);
  runGit(['config', 'user.email', 'koryphaios-tests@example.invalid']);
  runGit(['config', 'user.name', 'Koryphaios tests']);
  writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
  runGit(['add', 'source.ts']);
  runGit(['commit', '-qm', 'initial source']);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('release compatibility hash provenance', () => {
  test('uses actual worktree content and records the commit', () => {
    const root = makeRepository();
    const first = resolveHash({ projectRoot: root, requireClean: true });

    expect(first.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(first.sourceDigest).toBe(first.hash);
    expect(first.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(first.dirtyEntries).toEqual([]);
    expect(inspectGitSnapshot(root)?.sourceDigest).toBe(first.hash);

    writeFileSync(join(root, 'source.ts'), 'export const value = 2;\n');
    const edited = resolveHash({ projectRoot: root, requireClean: false });
    expect(edited.hash).not.toBe(first.hash);
    expect(edited.dirtyEntries.some((entry) => entry.includes('source.ts'))).toBe(true);
    expect(() => resolveHash({ projectRoot: root, requireClean: true })).toThrow('dirty checkout');
  });

  test('includes non-ignored untracked files in non-release identity', () => {
    const root = makeRepository();
    const first = resolveHash({ projectRoot: root, requireClean: false });
    writeFileSync(join(root, 'new-imported-module.ts'), 'export const added = true;\n');
    const withUntracked = resolveHash({ projectRoot: root, requireClean: false });

    expect(withUntracked.hash).not.toBe(first.hash);
    expect(
      withUntracked.dirtyEntries.some((entry) => entry.includes('new-imported-module.ts')),
    ).toBe(true);
    expect(() => resolveHash({ projectRoot: root, requireClean: true })).toThrow('dirty checkout');
  });

  test('fails closed when release provenance has no git HEAD', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-compat-hash-no-git-'));
    temporaryRoots.push(root);
    expect(() => resolveHash({ projectRoot: root, requireClean: true })).toThrow(
      'not a git checkout',
    );
    expect(resolveHash({ projectRoot: root, requireClean: false }).hash).toBe('dev');
  });
});
