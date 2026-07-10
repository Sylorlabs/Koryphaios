import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanProject, buildSync, newSyncState } from '../project-sync';

describe('project-sync', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ps-test-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('scan skips junk dirs and binaries, keeps source', async () => {
    await writeFile(join(root, 'index.ts'), 'export const x = 1;');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'app.ts'), 'run();');
    await mkdir(join(root, 'node_modules', 'dep'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'dep', 'index.js'), 'junk');
    await writeFile(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const scanned = await scanProject(root);
    const paths = scanned.map((f) => f.path).sort();
    expect(paths).toEqual(['index.ts', 'src/app.ts']);
  });

  test('.gitignore top-level names are excluded', async () => {
    await writeFile(join(root, '.gitignore'), 'secret.txt\n*.log\n');
    await writeFile(join(root, 'keep.ts'), 'ok');
    await writeFile(join(root, 'secret.txt'), 'nope');
    await writeFile(join(root, 'debug.log'), 'nope');
    const paths = (await scanProject(root)).map((f) => f.path).sort();
    // .gitignore itself is a harmless text file and syncs (the host CLI can
    // honor it); secret.txt and *.log are excluded.
    expect(paths).toEqual(['.gitignore', 'keep.ts']);
  });

  test('first sync is full, second is delta with only changed + deleted', async () => {
    await writeFile(join(root, 'a.ts'), 'a1');
    await writeFile(join(root, 'b.ts'), 'b1');
    const state = newSyncState();

    const full = buildSync(await scanProject(root), state);
    expect(full.mode).toBe('full');
    expect(full.files.map((f) => f.path).sort()).toEqual(['a.ts', 'b.ts']);
    expect(full.deletes).toEqual([]);

    // Change a.ts (bump mtime forward), delete b.ts, add c.ts.
    await writeFile(join(root, 'a.ts'), 'a2');
    const future = new Date(Date.now() + 5000);
    await utimes(join(root, 'a.ts'), future, future);
    await rm(join(root, 'b.ts'));
    await writeFile(join(root, 'c.ts'), 'c1');

    const delta = buildSync(await scanProject(root), state);
    expect(delta.mode).toBe('delta');
    expect(delta.files.map((f) => f.path).sort()).toEqual(['a.ts', 'c.ts']);
    expect(delta.deletes).toEqual(['b.ts']);
  });

  test('unchanged project yields an empty delta', async () => {
    await writeFile(join(root, 'a.ts'), 'a1');
    const state = newSyncState();
    buildSync(await scanProject(root), state);
    const delta = buildSync(await scanProject(root), state);
    expect(delta.files).toEqual([]);
    expect(delta.deletes).toEqual([]);
  });
});
