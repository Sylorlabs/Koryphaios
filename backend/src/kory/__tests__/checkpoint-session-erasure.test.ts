import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CheckpointStore } from '../checkpoint-store';
import { ShadowRepo } from '../shadow-repo';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  const result = spawnSync(['git', ...args], {
    cwd: repo,
    env: { ...process.env, ...ShadowRepo.shadowEnv(repo) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  return new TextDecoder().decode(result.stdout).trim();
}

function repo(): string {
  const root = join(tmpdir(), `kory-checkpoint-erase-${crypto.randomUUID()}`);
  roots.push(root);
  mkdirSync(root, { recursive: true });
  expect(spawnSync(['git', 'init', '-b', 'main'], { cwd: root }).exitCode).toBe(0);
  expect(spawnSync(['git', 'config', 'user.name', 'Erasure Test'], { cwd: root }).exitCode).toBe(
    0,
  );
  expect(
    spawnSync(['git', 'config', 'user.email', 'erasure@example.test'], { cwd: root }).exitCode,
  ).toBe(0);
  writeFileSync(join(root, 'README.md'), '# checkpoint erasure\n');
  expect(spawnSync(['git', 'add', 'README.md'], { cwd: root }).exitCode).toBe(0);
  expect(spawnSync(['git', 'commit', '-m', 'base'], { cwd: root }).exitCode).toBe(0);
  return root;
}

describe('CheckpointStore session erasure', () => {
  test('removes only the selected session refs, metadata, notes, and timeline across restart', async () => {
    const root = repo();
    const store = new CheckpointStore(root);
    writeFileSync(join(root, 'target.txt'), 'TARGET-CHECKPOINT-SENTINEL');
    const targetHash = await store.createGhostCommit('target checkpoint', {
      agentId: 'target-session',
      changedFiles: [{ path: 'target.txt', operation: 'create' }],
    });
    writeFileSync(join(root, 'keep.txt'), 'KEEP-CHECKPOINT-SENTINEL');
    const keepHash = await store.createGhostCommit('keep checkpoint', {
      agentId: 'keep-session',
      changedFiles: [{ path: 'keep.txt', operation: 'create' }],
    });
    expect(targetHash).toBeTruthy();
    expect(keepHash).toBeTruthy();
    expect((await store.getTimeline(50, 'target-session')).length).toBe(1);
    expect((await store.getTimeline(50, 'keep-session')).length).toBe(1);

    const report = await store.eraseSession('target-session');
    expect(report.removedRefs).toBeGreaterThan(0);
    expect(await store.getTimeline(50, 'target-session')).toEqual([]);
    expect((await store.getTimeline(50, 'keep-session')).map((entry) => entry.hash)).toEqual([
      keepHash,
    ]);
    expect(git(root, 'show-ref')).not.toContain(targetHash!);
    expect(git(root, 'show-ref')).toContain(keepHash!);

    const restarted = new CheckpointStore(root);
    expect(await restarted.getTimeline(50, 'target-session')).toEqual([]);
    expect((await restarted.getTimeline(50, 'keep-session')).map((entry) => entry.hash)).toEqual([
      keepHash,
    ]);
  }, 60_000);
});

