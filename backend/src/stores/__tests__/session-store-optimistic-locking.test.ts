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
import { mkdtempSync, rmSync } from 'node:fs';
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
