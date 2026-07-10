import { test, expect, describe } from 'bun:test';
import {
  deriveKey,
  encryptRecords,
  decryptRecords,
  diffSince,
  mergeRecords,
  NotesSyncSession,
  type NoteRecord,
} from '../notes-sync';

function rec(id: string, updatedAt: number, over: Partial<NoteRecord> = {}): NoteRecord {
  return { id, title: id, content: `body-${id}`, folderPath: '/', tags: [], updatedAt, ...over };
}

describe('E2EE crypto', () => {
  test('encrypt → decrypt round-trips with the same passphrase+salt', async () => {
    const key = await deriveKey('correct horse battery staple', 'room-1');
    const records = [rec('a', 1000), rec('b', 2000, { tags: ['x', 'y'] })];
    const env = await encryptRecords(key, records);
    expect(env.v).toBe(1);
    expect(typeof env.iv).toBe('string');
    expect(typeof env.ct).toBe('string');
    const out = await decryptRecords(key, env);
    expect(out).toEqual(records);
  });

  test('a wrong passphrase fails to decrypt (GCM auth)', async () => {
    const good = await deriveKey('right', 'room-1');
    const bad = await deriveKey('wrong', 'room-1');
    const env = await encryptRecords(good, [rec('a', 1)]);
    await expect(decryptRecords(bad, env)).rejects.toBeTruthy();
  });

  test('a wrong salt fails to decrypt', async () => {
    const a = await deriveKey('pw', 'room-1');
    const b = await deriveKey('pw', 'room-2');
    const env = await encryptRecords(a, [rec('a', 1)]);
    await expect(decryptRecords(b, env)).rejects.toBeTruthy();
  });

  test('the relay never sees plaintext (ciphertext contains no note body)', async () => {
    const key = await deriveKey('pw', 'room-1');
    const env = await encryptRecords(key, [rec('secret', 1, { content: 'TOPSECRET' })]);
    const wire = JSON.stringify(env);
    expect(wire).not.toContain('TOPSECRET');
    expect(wire).not.toContain('secret');
  });
});

describe('diffSince', () => {
  test('returns only records at/after the watermark', () => {
    const all = [rec('a', 100), rec('b', 200), rec('c', 300)];
    expect(diffSince(all, 200).map((r) => r.id)).toEqual(['b', 'c']);
  });
});

describe('mergeRecords (last-write-wins)', () => {
  test('adds remote-only records', () => {
    const { merged } = mergeRecords([rec('a', 1)], [rec('b', 1)]);
    expect(merged.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  test('newer updatedAt wins', () => {
    const local = [rec('a', 100, { content: 'old' })];
    const remote = [rec('a', 200, { content: 'new' })];
    expect(mergeRecords(local, remote).merged[0].content).toBe('new');
    // and the reverse keeps local
    expect(mergeRecords(remote, local).merged[0].content).toBe('new');
  });

  test('a delete tombstone propagates when newer', () => {
    const local = [rec('a', 100)];
    const remote = [rec('a', 200, { deleted: true })];
    expect(mergeRecords(local, remote).merged[0].deleted).toBe(true);
  });

  test('equal-timestamp divergence is a deterministic conflict', () => {
    const local = [rec('a', 100, { content: 'aaa' })];
    const remote = [rec('a', 100, { content: 'bbb' })];
    const r1 = mergeRecords(local, remote);
    const r2 = mergeRecords(remote, local);
    // Both peers converge to the same content regardless of merge direction.
    expect(r1.merged[0].content).toBe(r2.merged[0].content);
    expect(r1.merged[0].content).toBe('bbb'); // lexicographically greater wins
    expect(r1.conflicts).toHaveLength(1);
    expect(r1.conflicts[0].id).toBe('a');
  });

  test('identical equal-timestamp records are not conflicts', () => {
    const { conflicts } = mergeRecords([rec('a', 100)], [rec('a', 100)]);
    expect(conflicts).toHaveLength(0);
  });
});

describe('NotesSyncSession', () => {
  test('two peers converge after exchanging encrypted deltas', async () => {
    const key = await deriveKey('shared-pw', 'room-42');

    let alice: NoteRecord[] = [rec('a', 100, { content: 'alice-a' })];
    let bob: NoteRecord[] = [rec('b', 150, { content: 'bob-b' })];

    const aliceSession = new NotesSyncSession(key, () => alice, (m) => { alice = m; });
    const bobSession = new NotesSyncSession(key, () => bob, (m) => { bob = m; });

    // Alice pushes → Bob applies; Bob pushes → Alice applies.
    const aPush = await aliceSession.createPush();
    await bobSession.applyPull(aPush);
    const bPush = await bobSession.createPush();
    await aliceSession.applyPull(bPush);

    const ids = (rs: NoteRecord[]) => rs.map((r) => r.id).sort().join(',');
    expect(ids(alice)).toBe('a,b');
    expect(ids(bob)).toBe('a,b');
    expect(bob.find((r) => r.id === 'a')?.content).toBe('alice-a');
    expect(alice.find((r) => r.id === 'b')?.content).toBe('bob-b');
  });

  test('watermark advances so a second push skips already-synced edits', async () => {
    const key = await deriveKey('pw', 'room-1');
    let store: NoteRecord[] = [rec('a', 100)];
    const session = new NotesSyncSession(key, () => store, () => {});
    // Prime the watermark by pulling a remote delta up to ts 200.
    await session.applyPull(await encryptRecords(key, [rec('z', 200)]));
    expect(session.watermark).toBe(200);
    // 'a' (ts 100 < watermark) is excluded; only the newer 'b' is pushed.
    // (diffSince is inclusive at the boundary by design — re-sending a
    // boundary record is harmless because the merge is idempotent.)
    store = [rec('a', 100), rec('b', 300)];
    const env = await session.createPush();
    const pushed = await decryptRecords(key, env);
    expect(pushed.map((r) => r.id)).toEqual(['b']);
  });
});
