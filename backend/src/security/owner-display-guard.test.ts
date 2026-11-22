import { describe, expect, test } from 'bun:test';
import { OWNER_DISPLAY_REASON, killOwnerDisplayProcesses, ownerDisplayRefusal } from './owner-display-guard';

describe('owner display guard', () => {
  test('a Kory operations process is refused with the reason it belongs on the VM', () => {
    expect(ownerDisplayRefusal('target/debug/kory operations')).toBe(OWNER_DISPLAY_REASON);
    expect(ownerDisplayRefusal('/Applications/kory-operations.app/Contents/MacOS/kory_operations'))
      .toBe(OWNER_DISPLAY_REASON);
    expect(OWNER_DISPLAY_REASON).toMatch(/virtual machine/iu);
  });

  test('unrelated windows keep running', () => {
    expect(ownerDisplayRefusal('bun run --filter backend dev')).toBeNull();
    expect(ownerDisplayRefusal('target/debug/koryphaios')).toBeNull();
    expect(ownerDisplayRefusal('node /opt/koryphaios/frontend/vite')).toBeNull();
  });

  test('the sweep never reports its own process', () => {
    const stopped = killOwnerDisplayProcesses();
    expect(stopped.every((entry) => entry.pid !== process.pid)).toBe(true);
    expect(stopped.every((entry) => ownerDisplayRefusal(entry.command) !== null)).toBe(true);
  });
});
