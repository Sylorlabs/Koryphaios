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

afterAll(async () => {
  // Restore the shared `db` singleton to its original path so subsequent
  // test files see the real database. Then clean up the temp directory.
  // Do NOT close getDb() — reopenDatabase() already created a fresh live
  // connection that subsequent tests need.
  await reopenDatabase();
  rmSync(tempDir, { recursive: true, force: true });
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
});
