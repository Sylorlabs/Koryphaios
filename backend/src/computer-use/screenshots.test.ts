import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerScreenshotStore } from './screenshots';

function storeAt(root: string, options: { now?: () => number; retentionMs?: number; maxTotalBytes?: number } = {}) {
  return new ComputerScreenshotStore({ root: () => root, ...options });
}

describe('computer screenshot store', () => {
  it('scopes captures to the session and returns an opaque content-addressed receipt', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-shots-scope-'));
    const store = storeAt(root, { now: () => 1000, retentionMs: 60_000 });
    const receipt = store.put('session-a', 'cG5n');
    // Plain assertions: toMatchObject with an asymmetric matcher rewrote receipt.id in this runner.
    expect(receipt.id).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.expiresAt).toBe(61_000);
    expect(store.get('session-a', receipt.id)).toEqual(new Uint8Array([112, 110, 103]));
    expect(store.get('session-b', receipt.id)).toBeUndefined();
    expect(store.get('session-a', '../../etc/passwd')).toBeUndefined();
  });

  it('serves a capture from a fresh store instance, as after a restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-shots-restart-'));
    const receipt = storeAt(root).put('session-a', 'cG5n');
    expect(storeAt(root).get('session-a', receipt.id)).toEqual(new Uint8Array([112, 110, 103]));
  });

  it('expires captures after the retention window and refreshes them when re-observed', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-shots-ttl-'));
    let now = 1_000_000;
    const store = storeAt(root, { now: () => now, retentionMs: 60_000 });
    const receipt = store.put('session-a', 'cG5n');
    now += 50_000;
    expect(store.put('session-a', 'cG5n').id).toBe(receipt.id);
    now += 50_000;
    expect(store.get('session-a', receipt.id)).toBeDefined();
    now += 60_000;
    expect(store.get('session-a', receipt.id)).toBeUndefined();
  });

  it('bounds the captures folder by evicting the oldest captures first', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-shots-bound-'));
    let now = 1_000;
    const store = storeAt(root, { now: () => now++, maxTotalBytes: 6 });
    const first = store.put('session', 'YWJj');
    const second = store.put('session', 'ZGVm');
    store.put('session', 'Z2hp');
    expect(store.get('session', first.id)).toBeUndefined();
    expect(store.get('session', second.id)).toEqual(new Uint8Array([100, 101, 102]));
  });

  it('removes every capture a deleted chat owned and leaves other chats alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-shots-delete-'));
    const store = storeAt(root);
    const erased = store.put('chat-erased', 'YWJj');
    const kept = store.put('chat-kept', 'ZGVm');
    store.deleteSession('chat-erased');
    expect(store.get('chat-erased', erased.id)).toBeUndefined();
    expect(store.get('chat-kept', kept.id)).toEqual(new Uint8Array([100, 101, 102]));
  });
});
