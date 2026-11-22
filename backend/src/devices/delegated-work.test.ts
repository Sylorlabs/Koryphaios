import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { exportWorkspaceChanges, materializeDelegatedWork } from './delegated-work';
import { normalizeComputeDelegation } from '@koryphaios/shared/src/compute-delegation';

const roots: string[] = [];
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-delegated-work-'));
  roots.push(root);
  return root;
}
function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('exports tracked and untracked changes without committing or pushing', () => {
  const root = temp();
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'kory@example.test');
  git(root, 'config', 'user.name', 'Kory Test');
  writeFileSync(join(root, 'app.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, 'notes.txt'), 'keep\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  const base = git(root, 'rev-parse', 'HEAD').trim();

  writeFileSync(join(root, 'app.ts'), 'export const value = 2;\n');
  writeFileSync(join(root, 'new-file.ts'), 'export const fresh = true;\n');
  writeFileSync(join(root, '.env'), 'SECRET=do-not-return\n');
  const before = git(root, 'status', '--porcelain=v1');

  const bundle = exportWorkspaceChanges({
    workspaceRoot: root,
    sessionId: 'target-chat',
    sourceSessionId: 'origin-chat',
    deviceId: 'target-device',
    deviceName: 'VPS',
    workspaceName: 'project',
    placement: 'return',
    commit: 'none',
    summary: 'bun test passed',
  });

  expect(bundle.baseCommit).toBe(base);
  expect(bundle.patch).toContain('value = 2');
  expect(bundle.files.map((file) => file.path)).toContain('app.ts');
  expect(bundle.files.map((file) => file.path)).toContain('new-file.ts');
  expect(bundle.files.map((file) => file.path)).not.toContain('.env');
  expect(bundle.files.find((file) => file.path === 'new-file.ts')?.content).toContain('fresh');
  expect(bundle.sourceSessionId).toBe('origin-chat');
  expect(bundle.commit).toBe('none');
  // Export is read-only: no commit, no index mutation, no push.
  expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(base);
  expect(git(root, 'status', '--porcelain=v1')).toBe(before);
});

test('materializes a returned bundle for review without applying it', () => {
  const target = temp();
  git(target, 'init', '-q');
  git(target, 'config', 'user.email', 'kory@example.test');
  git(target, 'config', 'user.name', 'Kory Test');
  writeFileSync(join(target, 'app.ts'), 'one\n');
  git(target, 'add', '.');
  git(target, 'commit', '-qm', 'base');
  writeFileSync(join(target, 'app.ts'), 'two\n');
  writeFileSync(join(target, 'untracked.txt'), 'hello\n');
  const bundle = exportWorkspaceChanges({
    workspaceRoot: target,
    sessionId: 'target-chat',
    deviceId: 'target-device',
    deviceName: 'VPS',
    workspaceName: 'project',
    placement: 'return',
    commit: 'none',
    transferId: 'transfer-1',
  });

  const origin = temp();
  writeFileSync(join(origin, 'app.ts'), 'one\n');
  const result = materializeDelegatedWork(origin, bundle);
  expect(result.directory).toContain('.koryphaios/incoming/transfer-1');
  expect(existsSync(join(result.directory, 'changes.patch'))).toBe(true);
  expect(readFileSync(join(result.directory, 'TRANSFER.md'), 'utf8')).toContain('Nothing was committed or pushed');
  expect(readFileSync(join(result.directory, 'files', 'untracked.txt'), 'utf8')).toBe('hello\n');
  // The origin checkout is untouched until the user applies the patch.
  expect(readFileSync(join(origin, 'app.ts'), 'utf8')).toBe('one\n');
});

test('normalizes delegation defaults and refuses a local commit for stay work', () => {
  expect(normalizeComputeDelegation(undefined)).toEqual({ placement: 'stay', commit: 'none' });
  expect(normalizeComputeDelegation({ placement: 'return', commit: 'local' })).toEqual({
    placement: 'return',
    commit: 'local',
  });
  expect(normalizeComputeDelegation({ placement: 'stay', commit: 'local' })).toEqual({
    placement: 'stay',
    commit: 'none',
  });
  expect(normalizeComputeDelegation({ placement: 'nonsense' })).toEqual({
    placement: 'stay',
    commit: 'none',
  });
});
