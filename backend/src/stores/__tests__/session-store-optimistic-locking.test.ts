// Tests for SessionStore optimistic locking (expectedVersion).
//
// The SessionStore.update() method implements optimistic concurrency control:
// callers pass the `version` they last read as `expectedVersion`. The update
// only succeeds if the row's current version still matches; otherwise it
// returns `undefined` (concurrent modification detected). On a successful
// update the version is incremented so that stale readers fail on retry.
//
// These tests use a temp-file SQLite database via `reopenDatabase()` so the
// real `db` module singleton points at an isolated database. We avoid
// `mock.module()` because it is process-wide in Bun and `mock.restore()` does
// NOT undo it — any `mock.module('../../db', ...)` would permanently replace
// the `db` module for all subsequent test files, breaking e.g.
// routes/v1/__tests__/providers.test.ts.

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Reopen the shared `db` singleton at a temp file BEFORE importing
// SessionStore, so SessionStore's module-level `import { db } from '../db'`
// captures the same drizzle instance that now points at our temp database.
const tempDir = mkdtempSync(join(tmpdir(), 'kory-session-store-optimistic-'));
const tempDbPath = join(tempDir, 'test.sqlite');

const { db, reopenDatabase, getDb } = await import('../../db');
await reopenDatabase(tempDbPath);

// Import SessionStore AFTER reopening the database so it picks up the
// temp-file drizzle instance.
const { SessionStore } = await import('../session-store');
const { MessageStore } = await import('../message-store');
const { getJulesSessionMeta, setJulesSessionMeta, clearJulesSessionMeta } =
  await import('../../providers/jules-session-store');

afterAll(async () => {
  // Restore the shared `db` singleton to its original path so subsequent
  // test files see the real database. Then clean up the temp directory.
  // Do NOT close getDb() — reopenDatabase() already created a fresh live
  // connection that subsequent tests need.
  await reopenDatabase();
  // Windows may still hold a file lock on the SQLite database immediately
  // after reopening; force:true suppresses ENOENT but not EPERM, so wrap
  // in a try-catch. The temp dir is in os.tmpdir() and will be cleaned up
  // by the OS.
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; temp dir is in os.tmpdir().
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionStore optimistic locking (expectedVersion)', () => {
  let store: InstanceType<typeof SessionStore>;

  test('ordinary chats persist distinct execution repositories while retaining the same source identity', async () => {
    const source = join(tempDir, 'source');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'draft.txt'), 'source unchanged');
    const [a, b] = await Promise.all([
      store.create('local-user', 'A', undefined, source),
      store.create('local-user', 'B', undefined, source),
    ]);
    expect(a.workingDirectory).toBe(source);
    expect(b.workingDirectory).toBe(source);
    expect(a.gitWorkspace?.isolation).toBe('independent-repository');
    expect(a.gitWorkspace?.path).not.toBe(b.gitWorkspace?.path);
    writeFileSync(join(a.gitWorkspace!.path, 'draft.txt'), 'A only');
    expect(readFileSync(join(b.gitWorkspace!.path, 'draft.txt'), 'utf8')).toBe('source unchanged');
    expect(readFileSync(join(source, 'draft.txt'), 'utf8')).toBe('source unchanged');
    expect((await new SessionStore().get(a.id))?.gitWorkspace).toEqual(a.gitWorkspace);
    const { sessionWorkspaceOwnership } = await import('../../kory/session-workspace');
    expect(sessionWorkspaceOwnership(a.gitWorkspace!.path)?.sourceRoot).toBe(realpathSync(source));
  });

  beforeEach(async () => {
    // Wipe any rows left over from a previous test so each test starts clean.
    getDb().run('DELETE FROM sessions;');
    store = new SessionStore();
  });

  afterEach(() => {
    getDb().run('DELETE FROM sessions;');
  });

  test('update() with correct expectedVersion succeeds and increments the version', async () => {
    const created = await store.create();
    expect(created.version).toBe(1);

    const updated = await store.update(created.id, { title: 'new title' }, created.version);

    expect(updated).toBeDefined();
    expect(updated!.title).toBe('new title');
    // A successful update must bump the version so stale readers fail later.
    expect(updated!.version).toBe(created.version + 1);

    // Confirm the increment persisted by re-reading.
    const reread = await store.get(created.id);
    expect(reread?.version).toBe(created.version + 1);
  });

  test('update() with wrong expectedVersion returns undefined', async () => {
    const created = await store.create();
    expect(created.version).toBe(1);

    // A version that was never the row's version (e.g. version + 1).
    const result = await store.update(
      created.id,
      { title: 'should not apply' },
      created.version + 1,
    );

    expect(result).toBeUndefined();

    // The row must be untouched.
    const unchanged = await store.get(created.id);
    expect(unchanged?.title).toBe(created.title);
    expect(unchanged?.version).toBe(1);
  });

  test('update() with stale expectedVersion returns undefined', async () => {
    const created = await store.create();
    const initial = await store.get(created.id);
    expect(initial?.version).toBe(1);

    // First update succeeds and bumps the version to 2.
    const firstUpdate = await store.update(created.id, { title: 'first' }, initial!.version);
    expect(firstUpdate).toBeDefined();
    expect(firstUpdate!.version).toBe(2);

    // A stale reader still holding version=1 must be rejected.
    const staleUpdate = await store.update(created.id, { title: 'stale' }, initial!.version);
    expect(staleUpdate).toBeUndefined();

    // The row retains the first update's title and version=2.
    const current = await store.get(created.id);
    expect(current?.title).toBe('first');
    expect(current?.version).toBe(2);
  });

  test('updateWithCurrentVersion() always uses the latest version', async () => {
    const created = await store.create();
    expect(created.version).toBe(1);

    // No version provided — the wrapper reads the current version then updates.
    const updated = await store.updateWithCurrentVersion(created.id, { title: 'via wrapper' });

    expect(updated).toBeDefined();
    expect(updated!.title).toBe('via wrapper');
    expect(updated!.version).toBe(created.version + 1);
  });

  test('concurrent updates: second writer gets undefined', async () => {
    const created = await store.create();

    // Both writers read the session at the same version.
    const readerA = await store.get(created.id);
    const readerB = await store.get(created.id);
    expect(readerA?.version).toBe(1);
    expect(readerB?.version).toBe(1);

    // First writer wins; version becomes 2.
    const firstWrite = await store.update(created.id, { title: 'writer A' }, readerA!.version);
    expect(firstWrite).toBeDefined();
    expect(firstWrite!.version).toBe(2);

    // Second writer still holds version=1 and must lose the race.
    const secondWrite = await store.update(created.id, { title: 'writer B' }, readerB!.version);
    expect(secondWrite).toBeUndefined();

    // Writer A's title prevails; version is 2.
    const final = await store.get(created.id);
    expect(final?.title).toBe('writer A');
    expect(final?.version).toBe(2);
  });

  test('concurrent settings updates cannot erase a newly persisted Git workspace', async () => {
    const created = await store.create('local-user', 'Concurrent Git binding');
    const gitWorkspace = {
      path: join(tempDir, 'checkout'),
      repositoryPath: join(tempDir, 'source'),
      branch: 'chat-main',
      baseCommit: 'a'.repeat(40),
      isolation: 'independent-repository' as const,
    };
    await Promise.all([
      store.update(created.id, { gitWorkspace }),
      store.update(created.id, { agentOverrides: { permissionMode: 'guarded' } }),
      store.update(created.id, { interactionMode: 'plan' }),
    ]);
    const current = await store.get(created.id);
    expect(current?.gitWorkspace).toEqual(gitWorkspace);
    expect(current?.agentOverrides).toEqual({ permissionMode: 'guarded' });
    expect(current?.interactionMode).toBe('plan');
    expect(current?.version).toBe(created.version + 3);
  });

  test('clearing overrides concurrently with revision selection retains both updates', async () => {
    const created = await store.create('local-user', 'Concurrent revision');
    await store.update(created.id, { agentOverrides: { permissionMode: 'ask' } });
    const gitWorkspace = {
      path: join(tempDir, 'checkout'),
      repositoryPath: join(tempDir, 'source'),
      branch: 'chat-main',
      baseCommit: 'a'.repeat(40),
      isolation: 'independent-repository' as const,
    };
    await Promise.all([
      store.update(created.id, { gitWorkspace }),
      store.update(created.id, { agentOverrides: {} }),
    ]);
    const current = await store.get(created.id);
    expect(current?.gitWorkspace).toEqual(gitWorkspace);
    expect(current?.agentOverrides).toBeUndefined();
  });

  test('provider continuity updates cannot erase a concurrent Git binding or settings update', async () => {
    const created = await store.create('local-user', 'Provider continuity');
    const gitWorkspace = {
      path: join(tempDir, 'checkout'),
      repositoryPath: join(tempDir, 'source'),
      branch: 'chat-main',
      baseCommit: 'a'.repeat(40),
      isolation: 'independent-repository' as const,
    };
    const meta = { sessionId: 'jules-test-session', updatedAt: Date.now() };
    await Promise.all([
      store.update(created.id, { gitWorkspace }),
      setJulesSessionMeta(created.id, meta),
    ]);
    expect((await store.get(created.id))?.gitWorkspace).toEqual(gitWorkspace);
    expect(await getJulesSessionMeta(created.id)).toEqual(meta);
    await Promise.all([
      store.update(created.id, { interactionMode: 'plan' }),
      clearJulesSessionMeta(created.id),
    ]);
    const current = await store.get(created.id);
    expect(current?.gitWorkspace).toEqual(gitWorkspace);
    expect(current?.interactionMode).toBe('plan');
    expect(await getJulesSessionMeta(created.id)).toBeUndefined();
  });

  test('metadata updates preserve unknown keys and stale writes leave the binding intact', async () => {
    const created = await store.create();
    const metadata = { extension: { enabled: true }, gitWorkspace: { path: 'persisted-checkout' } };
    getDb().run('UPDATE sessions SET metadata = ? WHERE id = ?', [
      JSON.stringify(metadata),
      created.id,
    ]);
    await store.update(created.id, { interactionMode: 'plan', planNoteId: 'plan-note' });
    expect(await store.update(created.id, { agentOverrides: {} }, created.version)).toBeUndefined();
    const row = getDb().query('SELECT metadata FROM sessions WHERE id = ?').get(created.id) as {
      metadata: string;
    };
    expect(JSON.parse(row.metadata)).toEqual({
      ...metadata,
      interactionMode: 'plan',
      planNoteId: 'plan-note',
    });
  });

  test('metadata updates recover malformed and non-object legacy metadata', async () => {
    for (const metadata of ['invalid-json', 'null', '[]', '42', '"legacy"']) {
      const created = await store.create();
      getDb().run('UPDATE sessions SET metadata = ? WHERE id = ?', [metadata, created.id]);
      const updated = await store.update(created.id, { interactionMode: 'plan' });
      expect(updated?.interactionMode).toBe('plan');
      const meta = { sessionId: 'jules-recovery', updatedAt: 123 };
      await setJulesSessionMeta(created.id, meta);
      expect(await getJulesSessionMeta(created.id)).toEqual(meta);
      expect((await store.get(created.id))?.interactionMode).toBe('plan');
    }
  });

  test('archive filtering and ordering are explicit while listAll remains complete', async () => {
    const active = await store.create('local-user', 'Active');
    const olderArchive = await store.create('local-user', 'Older archive');
    const newerArchive = await store.create('local-user', 'Newer archive');

    await store.archive(olderArchive.id, 10_000);
    await store.archive(newerArchive.id, 20_000);

    expect((await store.listActive()).map((session) => session.id)).toEqual([active.id]);
    expect((await store.listArchived()).map((session) => session.id)).toEqual([
      newerArchive.id,
      olderArchive.id,
    ]);
    expect(new Set((await store.listAll()).map((session) => session.id))).toEqual(
      new Set([active.id, olderArchive.id, newerArchive.id]),
    );
    // The legacy inventory alias deliberately stays all-inclusive.
    expect(new Set((await store.list()).map((session) => session.id))).toEqual(
      new Set([active.id, olderArchive.id, newerArchive.id]),
    );
    expect(await store.getActive(olderArchive.id)).toBeUndefined();
  });

  test('archive and restore are atomic, retry-safe, and preserve last-active ordering time', async () => {
    const created = await store.create('local-user', 'Preserve activity time');
    const originalUpdatedAt = created.updatedAt;

    const archived = await store.archive(created.id, 123_456);
    expect(archived).toMatchObject({ archivedAt: 123_456, status: 'archived', version: 2 });
    expect(archived?.updatedAt).toBe(originalUpdatedAt);

    const archiveRetry = await store.archive(created.id, 999_999);
    expect(archiveRetry).toEqual(archived);
    expect(archiveRetry?.version).toBe(2);
    expect(archiveRetry?.archivedAt).toBe(123_456);

    const restored = await store.restore(created.id);
    expect(restored).toMatchObject({ status: 'active', version: 3 });
    expect(restored?.archivedAt).toBeUndefined();
    expect(restored?.updatedAt).toBe(originalUpdatedAt);

    const restoreRetry = await store.restore(created.id);
    expect(restoreRetry).toEqual(restored);
    expect(restoreRetry?.version).toBe(3);
    expect((await store.listArchived()).map((session) => session.id)).not.toContain(created.id);
    expect((await store.listActive()).map((session) => session.id)).toContain(created.id);
  });

  test('message persistence fails closed inside the transaction for archived chats', async () => {
    const created = await store.create('local-user', 'Read only archive');
    await store.archive(created.id, 12_345);
    const messages = new MessageStore();

    await expect(
      messages.add(created.id, {
        id: 'blocked-message',
        sessionId: created.id,
        role: 'user',
        content: 'must not persist',
        createdAt: 99_999,
      }),
    ).rejects.toThrow('Recover this archived chat');

    expect(
      getDb().query('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get(created.id),
    ).toEqual({ count: 0 });
    expect((await store.get(created.id))?.messageCount).toBe(0);
  });
});
