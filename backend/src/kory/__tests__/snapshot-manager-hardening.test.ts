import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotManager } from '../snapshot-manager';

describe('SnapshotManager containment and recovery truth', () => {
  let project: string;
  let outside: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'kory-snapshot-project-'));
    outside = mkdtempSync(join(tmpdir(), 'kory-snapshot-outside-'));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test('rejects session traversal and never prunes outside storage', async () => {
    const manager = new SnapshotManager(project);
    const marker = join(outside, 'preserve.txt');
    writeFileSync(marker, 'preserve');
    writeFileSync(join(project, 'owned.txt'), 'owned');

    await expect(
      manager.createSnapshot('../../outside', 'latest', ['owned.txt'], project),
    ).rejects.toThrow('Invalid snapshot session id');
    expect(() => manager.prune('../../outside')).toThrow('Invalid snapshot session id');
    expect(readFileSync(marker, 'utf8')).toBe('preserve');
  });

  test('rejects absolute files outside the project and reserved metadata', async () => {
    const manager = new SnapshotManager(project);
    const external = join(outside, 'external.txt');
    writeFileSync(external, 'external');
    mkdirSync(join(project, '.git'));
    writeFileSync(join(project, '.git', 'config'), 'secret');

    await expect(manager.createSnapshot('session', 'latest', [external], project)).rejects.toThrow(
      'escaped its owned directory',
    );
    await expect(
      manager.createSnapshot('session', 'latest', ['.git/config'], project),
    ).rejects.toThrow('Reserved project metadata');
  });

  test('rejects symlinked storage and symlinked project files', async () => {
    mkdirSync(join(project, '.koryphaios'));
    symlinkSync(outside, join(project, '.koryphaios', 'snapshots'));
    expect(() => new SnapshotManager(project)).toThrow(
      'snapshot storage is not an owned directory',
    );

    rmSync(join(project, '.koryphaios'), { recursive: true, force: true });
    const manager = new SnapshotManager(project);
    const external = join(outside, 'external.txt');
    writeFileSync(external, 'external');
    symlinkSync(external, join(project, 'linked.txt'));
    await expect(
      manager.createSnapshot('session', 'latest', ['linked.txt'], project),
    ).rejects.toThrow('symbolic link');
  });

  test('fails restoration after a target is swapped to an outside symlink', async () => {
    const manager = new SnapshotManager(project);
    const owned = join(project, 'owned.txt');
    const external = join(outside, 'external.txt');
    writeFileSync(owned, 'snapshot value');
    writeFileSync(external, 'outside value');
    await manager.createSnapshot('session', 'latest', ['owned.txt'], project);

    rmSync(owned);
    symlinkSync(external, owned);
    const restored = await manager.restoreSnapshot('session', 'latest', project);

    expect(restored.success).toBe(false);
    expect(restored.error).toContain('not a regular project file');
    expect(readFileSync(external, 'utf8')).toBe('outside value');
  });

  test('rejects a tampered manifest path without writing outside the project', async () => {
    const manager = new SnapshotManager(project);
    writeFileSync(join(project, 'owned.txt'), 'snapshot value');
    await manager.createSnapshot('session', 'latest', ['owned.txt'], project);
    writeFileSync(
      join(project, '.koryphaios', 'snapshots', 'session', 'latest', 'manifest.json'),
      JSON.stringify({ version: 1, timestamp: Date.now(), files: ['../../outside.txt'] }),
    );

    const restored = await manager.restoreSnapshot('session', 'latest', project);
    expect(restored.success).toBe(false);
    expect(existsSync(join(outside, 'outside.txt'))).toBe(false);
  });

  test('atomically replaces a reused snapshot instead of retaining stale files', async () => {
    const manager = new SnapshotManager(project);
    writeFileSync(join(project, 'first.txt'), 'first');
    writeFileSync(join(project, 'stale.txt'), 'stale');
    await manager.createSnapshot('session', 'latest', ['first.txt', 'stale.txt'], project);
    await manager.createSnapshot('session', 'latest', ['first.txt'], project);

    const result = await manager.restoreFiles('session', 'latest', project, ['stale.txt']);
    expect(result.success).toBe(true);
    expect(result.restored).toEqual([]);
    expect(result.missing).toEqual(['stale.txt']);
    expect(
      existsSync(join(project, '.koryphaios', 'snapshots', 'session', 'latest', 'stale.txt')),
    ).toBe(false);
  });
});
