import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  artFingerprint,
  bakeApp,
  finderInfoHasCustomIcon,
  ICON_ART_PATH,
  main,
  parseTargets,
  verifyBakedApp,
} from './apply-bundle-icon';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('bundle icon fingerprint', () => {
  test('matches the runtime fingerprint of the shipped dock icon', () => {
    // Recorded from the installed app's Icon\r marker, written by bundle_icon.rs.
    expect(artFingerprint(new Uint8Array(readFileSync(ICON_ART_PATH)))).toBe(
      'fnv1a64:971b5cf88850780e:1395926',
    );
  });

  test('matches the Rust test vectors in bundle_icon.rs', () => {
    expect(artFingerprint(bytes(''))).toBe('fnv1a64:cbf29ce484222325:0');
    expect(artFingerprint(bytes('a'))).toBe('fnv1a64:af63dc4c8601ec8c:1');
    expect(artFingerprint(bytes('koryphaios'))).toBe('fnv1a64:864d0699d8a68e6a:10');
  });

  test('reads the custom-icon flag from Finder flags byte 8', () => {
    const info = new Uint8Array(32);
    expect(finderInfoHasCustomIcon(info)).toBe(false);
    info[8] = 0x04;
    expect(finderInfoHasCustomIcon(info)).toBe(true);
    expect(finderInfoHasCustomIcon(new Uint8Array())).toBe(false);
  });
});

describe('apply-bundle-icon arguments', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'kory-bake-args-'));
  const app = join(scratch, 'Fake.app');
  const dmg = join(scratch, 'Fake.dmg');
  mkdirSync(app);
  writeFileSync(dmg, '');
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  test('accepts .app directories and .dmg files', () => {
    expect(parseTargets([`${app}/`, dmg])).toEqual([
      { kind: 'app', path: app },
      { kind: 'dmg', path: dmg },
    ]);
  });

  test('rejects no arguments, other extensions, missing paths and wrong kinds', () => {
    expect(() => parseTargets([])).toThrow(/usage/);
    expect(() => parseTargets([join(scratch, 'notes.txt')])).toThrow(/not a \.app or \.dmg/);
    expect(() => parseTargets([join(scratch, 'Missing.app')])).toThrow(/no such file/);
    const fileApp = join(scratch, 'File.app');
    writeFileSync(fileApp, '');
    expect(() => parseTargets([fileApp])).toThrow(/not an app bundle directory/);
    const dirDmg = join(scratch, 'Dir.dmg');
    mkdirSync(dirDmg);
    expect(() => parseTargets([dirDmg])).toThrow(/not a disk image file/);
  });

  test('skips without touching anything on other hosts', () => {
    const lines: string[] = [];
    expect(main([join(scratch, 'Missing.app')], 'linux', (line) => lines.push(line))).toBe(0);
    expect(main([], 'win32', (line) => lines.push(line))).toBe(0);
    expect(lines).toEqual([
      '[apply-bundle-icon] skipped: not macOS',
      '[apply-bundle-icon] skipped: not macOS',
    ]);
  });
});

// bun 1.3.14 hands children stale descriptors when `bun test` is given a path
// without a leading `./` (filter mode): they run, but nothing they print is
// captured, so osascript/xattr output reads as empty. Probe for that instead of
// reporting it as an icon failure; `bun test ./desktop/scripts/...` runs it.
const childOutputIsCaptured =
  spawnSync('/bin/echo', ['probe'], { encoding: 'utf8' }).stdout === 'probe\n';

describe.skipIf(process.platform !== 'darwin' || !childOutputIsCaptured)(
  'baking a throwaway app (macOS)',
  () => {
    test('leaves Icon\\r with artwork, the Finder flag and the current marker', () => {
      const scratch = mkdtempSync(join(tmpdir(), 'kory-bake-app-'));
      try {
        const app = join(scratch, 'Throwaway.app');
        mkdirSync(join(app, 'Contents'), { recursive: true });
        const fingerprint = bakeApp(app);
        expect(fingerprint).toBe(artFingerprint(new Uint8Array(readFileSync(ICON_ART_PATH))));
        expect(verifyBakedApp(app, fingerprint)).toEqual([]);
        expect(verifyBakedApp(app, 'fnv1a64:0000000000000000:0')).toHaveLength(1);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  },
);
