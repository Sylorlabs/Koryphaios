import { describe, expect, test } from 'bun:test';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildRequestsAppImage,
  macosBundleArtifacts,
  shouldBakeBundleIcon,
  tauriBundleDir,
} from './build-desktop';

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

describe('local macOS icon baking', () => {
  test('bakes only local macOS builds, never CI', () => {
    expect(shouldBakeBundleIcon('darwin', {})).toBe(true);
    expect(shouldBakeBundleIcon('darwin', { CI: 'true' })).toBe(false);
    expect(shouldBakeBundleIcon('linux', {})).toBe(false);
    expect(shouldBakeBundleIcon('win32', {})).toBe(false);
  });

  test('follows the tauri target and profile to the bundle directory', () => {
    expect(tauriBundleDir([])).toEndWith(join('src-tauri', 'target', 'release', 'bundle'));
    expect(tauriBundleDir(['--target', 'universal-apple-darwin'])).toEndWith(
      join('target', 'universal-apple-darwin', 'release', 'bundle'),
    );
    expect(tauriBundleDir(['--target=aarch64-apple-darwin', '--debug'])).toEndWith(
      join('target', 'aarch64-apple-darwin', 'debug', 'bundle'),
    );
  });

  test('finds the built app and disk images', () => {
    const bundle = mkdtempSync(join(tmpdir(), 'kory-bundle-dir-'));
    try {
      expect(macosBundleArtifacts(bundle)).toEqual([]);
      mkdirSync(join(bundle, 'macos', 'Koryphaios.app'), { recursive: true });
      mkdirSync(join(bundle, 'dmg'));
      writeFileSync(join(bundle, 'dmg', 'Koryphaios_0.5.0_aarch64.dmg'), '');
      writeFileSync(join(bundle, 'dmg', 'bundle_dmg.sh'), '');
      expect(macosBundleArtifacts(bundle)).toEqual([
        join(bundle, 'macos', 'Koryphaios.app'),
        join(bundle, 'dmg', 'Koryphaios_0.5.0_aarch64.dmg'),
      ]);
    } finally {
      rmSync(bundle, { recursive: true, force: true });
    }
  });
});
