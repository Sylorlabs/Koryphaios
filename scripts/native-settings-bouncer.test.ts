import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFiles, isBannedName, scanDirs } from './native-settings-bouncer';

/**
 * The backstop sweep is the last line of defence for a provider that never went
 * through the tool pipeline, so its coverage is asserted rather than assumed: an
 * `.app`, a LaunchAgent that would relaunch it, the saved application state that
 * restores its window, and a preferences plist that keeps the name in `defaults`.
 */
describe('native-settings backstop sweep', () => {
  it('matches the name in any spelling, including inside a bundle id', () => {
    for (const name of [
      'Native Settings',
      'Native Settings.app',
      'com.example.native-settings.plist',
    ]) {
      expect(isBannedName(name)).toBe(true);
    }
    for (const name of ['Settings', 'native-controls', 'com.example.settings.plist']) {
      expect(isBannedName(name)).toBe(false);
    }
  });

  it('scans the places a deleted app hides in, not just the Desktop', () => {
    const home = '/Users/example';
    const dirs = scanDirs(home);
    expect(dirs).toContain(join(home, 'Applications'));
    expect(dirs).toContain(join(home, 'Library', 'LaunchAgents'));
    expect(dirs).toContain(join(home, 'Library', 'Saved Application State'));
    expect(dirs).toContain(join(home, 'Library', 'Preferences'));
    expect(dirs).toContain('/Applications');
  });

  it('finds every surface in a throwaway home and reports each real path once', () => {
    const home = mkdtempSync(join(tmpdir(), 'kory-bouncer-sweep-'));
    try {
      const app = join(home, 'Applications', 'Native Settings.app', 'Contents');
      mkdirSync(app, { recursive: true });
      writeFileSync(join(app, 'Info.plist'), '<plist/>');
      mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
      writeFileSync(
        join(home, 'Library', 'LaunchAgents', 'com.example.native-settings.plist'),
        '<plist/>',
      );
      mkdirSync(join(home, 'Library', 'Preferences'), { recursive: true });
      writeFileSync(
        join(home, 'Library', 'Preferences', 'com.example.native-settings.plist'),
        '<plist/>',
      );
      mkdirSync(join(home, 'Desktop'), { recursive: true });
      writeFileSync(join(home, 'Desktop', 'ship-it.md'), '# clean\n');

      const hits = findFiles(home).filter(
        (hit) => hit.kind === 'file' && hit.path.startsWith(home),
      );
      const paths = hits.map((hit) => hit.path).sort();
      expect(paths).toEqual(
        [
          join(home, 'Applications', 'Native Settings.app'),
          join(home, 'Library', 'LaunchAgents', 'com.example.native-settings.plist'),
          join(home, 'Library', 'Preferences', 'com.example.native-settings.plist'),
        ].sort(),
      );
      // One hit per canonical path, even where `/tmp` and `/private/tmp` overlap.
      expect(new Set(paths).size).toBe(paths.length);
      // An unrelated file is never reported.
      expect(paths.some((path) => path.endsWith('ship-it.md'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
