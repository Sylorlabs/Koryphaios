import { describe, expect, it } from 'bun:test';
import { ComputerScreenshotStore } from './screenshots';

describe('computer screenshot store', () => {
  it('scopes expiring pixels to the session and exposes only an opaque receipt', () => {
    let now = 1000;
    const store = new ComputerScreenshotStore(() => now, 1024, 60_000);
    const receipt = store.put('session-a', 'cG5n');
    const pixels = store.get('session-a', receipt.id);
    expect(receipt).toMatchObject({ id: expect.any(String), expiresAt: 61_000 });
    expect(pixels).toEqual(new Uint8Array([112, 110, 103]));
    expect(store.get('session-b', receipt.id)).toBeUndefined();
    now = 61_000;
    expect(store.get('session-a', receipt.id)).toBeUndefined();
  });

  it('evicts oldest images when the bounded preview store is full', () => {
    let now = 1000;
    const store = new ComputerScreenshotStore(() => now++, 3, 1000);
    const first = store.put('session', 'YWJj');
    const second = store.put('session', 'ZGVm');
    expect(store.get('session', first.id)).toBeUndefined();
    expect(store.get('session', second.id)).toEqual(new Uint8Array([100, 101, 102]));
  });
});
