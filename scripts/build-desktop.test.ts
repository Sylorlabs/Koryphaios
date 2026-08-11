import { describe, expect, test } from 'bun:test';

import { buildRequestsAppImage } from './build-desktop';

describe('desktop bundle selection', () => {
  test('detects AppImage in the default Linux target set', () => {
    expect(buildRequestsAppImage([], 'linux')).toBe(true);
    expect(buildRequestsAppImage([], 'darwin')).toBe(false);
  });

  test('respects explicit bundle filters', () => {
    expect(buildRequestsAppImage(['--bundles', 'deb,rpm'], 'linux')).toBe(false);
    expect(buildRequestsAppImage(['--bundles', 'deb,appimage'], 'linux')).toBe(true);
    expect(buildRequestsAppImage(['--bundles=appimage'], 'linux')).toBe(true);
  });
});
