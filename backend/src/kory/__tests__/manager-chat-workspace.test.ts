import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KoryManager } from '../manager';
import { SessionRuntimeRegistry } from '../services/SessionRuntime';
import { createSessionWorkspace } from '../session-workspace';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kory-manager-chat-')));
  roots.push(root);
  const source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'file.txt'), 'source');
  return { root, source };
}
function manager(rows: Map<string, any>, fallback: string) {
  const instance = Object.create(KoryManager.prototype);
  Object.assign(instance, {
    workingDirectory: fallback,
    runtimes: new SessionRuntimeRegistry(),
    sessions: {
      get: async (id: string) => rows.get(id),
      update: async (id: string, updates: object, version: number) => {
        const current = rows.get(id);
        if (current?.version !== version) return undefined;
        const next = { ...current, ...updates, version: version + 1 };
        rows.set(id, next);
        return next;
      },
    },
    emitWSMessage() {},
  });
  return instance as KoryManager;
}

test('sibling sessions resolve their persisted checkouts and missing checkout never falls back to source', async () => {
  const { root, source } = fixture();
  const a = await createSessionWorkspace(source, { storageRoot: join(root, 'storage') });
  const b = await createSessionWorkspace(source, { storageRoot: join(root, 'storage') });
  const rows = new Map([
    ['a', { id: 'a', workingDirectory: source, gitWorkspace: a, version: 1 }],
    ['b', { id: 'b', workingDirectory: source, gitWorkspace: b, version: 1 }],
  ]);
  const kory = manager(rows, source);
  expect(await kory.resolveSessionWorkingDirectoryPublic('a')).toBe(a.path);
  expect(await kory.resolveSessionWorkingDirectoryPublic('b')).toBe(b.path);
  rmSync(a.path, { recursive: true });
  await expect(kory.resolveSessionWorkingDirectoryPublic('a')).rejects.toThrow('unavailable');
  expect(await kory.resolveSessionWorkingDirectoryPublic('b')).toBe(b.path);
  await expect(kory.resolveSessionWorkingDirectoryPublic('missing')).rejects.toThrow('unavailable');
});

test('concurrent first-use calls resolve a legacy chat directly in its folder', async () => {
  const { source } = fixture();
  const rows = new Map([['legacy', { id: 'legacy', workingDirectory: source, version: 1 }]]);
  const kory = manager(rows, source);
  const [a, b] = await Promise.all([
    kory.resolveSessionWorkingDirectoryPublic('legacy'),
    kory.resolveSessionWorkingDirectoryPublic('legacy'),
  ]);
  expect(a).toBe(b);
  expect(a).toBe(source);
  expect(rows.get('legacy')!.version).toBe(1);
  expect(await manager(rows, source).resolveSessionWorkingDirectoryPublic('legacy')).toBe(a);
});

test('retries a workspace after a transient directory outage instead of serving a stale failure', async () => {
  const { root, source } = fixture();
  const project = join(root, 'temporary-project');
  mkdirSync(project);
  const rows = new Map([['temporary', { id: 'temporary', workingDirectory: project, version: 1 }]]);
  const kory = manager(rows, source);

  expect(await kory.resolveSessionWorkingDirectoryPublic('temporary')).toBe(project);
  rmSync(project, { recursive: true, force: true });
  await expect(kory.resolveSessionWorkingDirectoryPublic('temporary')).rejects.toThrow(
    'unavailable',
  );
  await expect(kory.resolveSessionWorkingDirectoryPublic('temporary')).rejects.toThrow(project);

  writeFileSync(project, 'not a directory');
  await expect(kory.resolveSessionWorkingDirectoryPublic('temporary')).rejects.toThrow(
    'unavailable',
  );
  rmSync(project);

  mkdirSync(project);
  expect(await kory.resolveSessionWorkingDirectoryPublic('temporary')).toBe(project);
  expect(rows.get('temporary')!.workingDirectory).toBe(project);
  expect(rows.get('temporary')!.version).toBe(1);
});
