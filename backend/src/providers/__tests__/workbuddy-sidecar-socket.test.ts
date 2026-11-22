import { describe, expect, it } from 'vitest';
import { isSidecarControlSocketName } from '../workbuddy-desktop-runtime';

/**
 * WorkBuddy AI 5.9.4 names its sidecar control socket `s-<hash>.sock`; older
 * builds used `sidecar-<uuid>.sock`. The detector must see both, because a
 * missed socket silently downgrades a turn to a direct spawn that cannot
 * authenticate (the runtime answers `stopReason: refusal`).
 */
describe('WorkBuddy sidecar control socket names', () => {
  it('accepts the 5.9.4 hashed name', () => {
    expect(isSidecarControlSocketName('s-4f3a9c2b71de0a55.sock')).toBe(true);
  });

  it('accepts the older uuid name', () => {
    expect(isSidecarControlSocketName('sidecar-6f2c1d1e-8d2a-4a6f-9a1c-2b3c4d5e6f70.sock')).toBe(
      true,
    );
  });

  it('ignores unrelated sockets and sidecar files', () => {
    for (const name of [
      'sidecar.pid',
      'sessions',
      'wb-office-1234.sock',
      's-.sock',
      's-4f3a9c2b71de0a55.sock.bak',
      'control.sock',
    ]) {
      expect(isSidecarControlSocketName(name)).toBe(false);
    }
  });
});
