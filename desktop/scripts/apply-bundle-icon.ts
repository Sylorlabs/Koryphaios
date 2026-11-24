#!/usr/bin/env bun
/**
 * Bakes the bare-hexagon custom Finder icon into local build artifacts.
 *
 *   bun run desktop/scripts/apply-bundle-icon.ts <path.app | path.dmg> [...]
 *
 * macOS 26 draws the bundle icon (a non-squircle hexagon) on a gray platter;
 * a custom Finder icon (`<app>/Icon\r` + the kHasCustomIcon Finder flag) is
 * shown as drawn. The app writes one onto itself at launch
 * (desktop/src-tauri/src/bundle_icon.rs), which leaves a platter window before
 * the first launch. Baking it here closes that window for local builds.
 *
 * Local builds only. `Icon\r` and the bundle's FinderInfo are unsealed bundle
 * root contents: `codesign --verify --strict` rejects them, and so may
 * Gatekeeper for a quarantined download. Distributed / CI artifacts must not be
 * baked; they rely on the launch-time apply.
 *
 * The marker written on `Icon\r` uses exactly the runtime's fingerprint
 * (`art_fingerprint` in bundle_icon.rs), so the app sees the baked icon as
 * current and does not rewrite it.
 *
 * A `.dmg` is converted to read-write, mounted, every top-level `.app` inside
 * it is baked, and it is converted back to UDZO in place, so its window layout
 * and background are kept.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';

export const ICON_ART_PATH = join(import.meta.dir, '..', 'src-tauri', 'icons', 'dock-icon.png');
export const ICON_MARKER_XATTR = 'com.sylorlabs.koryphaios.icon-art';
const ICON_FILE_NAME = 'Icon\r';
const FINDER_FLAGS_OFFSET = 8;
const HAS_CUSTOM_ICON_HIGH_BYTE = 0x04;
/** Free space added to a DMG before baking: the icon's resource fork is ~2 MB. */
const DMG_GROWTH_SECTORS = 65_536; // 32 MiB of 512-byte sectors

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64_MASK = 0xffffffffffffffffn;

/** Mirrors `art_fingerprint` in desktop/src-tauri/src/bundle_icon.rs. */
export function artFingerprint(bytes: Uint8Array): string {
  let hash = FNV_OFFSET;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & U64_MASK;
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}:${bytes.length}`;
}

/** Mirrors `finder_info_has_custom_icon` in bundle_icon.rs. */
export function finderInfoHasCustomIcon(finderInfo: Uint8Array): boolean {
  const flags = finderInfo[FINDER_FLAGS_OFFSET];
  return flags !== undefined && (flags & HAS_CUSTOM_ICON_HIGH_BYTE) !== 0;
}

export type BakeTarget = { kind: 'app' | 'dmg'; path: string };

/** Validates CLI arguments into absolute `.app` / `.dmg` targets. */
export function parseTargets(args: readonly string[]): BakeTarget[] {
  if (args.length === 0) {
    throw new Error('usage: apply-bundle-icon.ts <path.app | path.dmg> [...]');
  }
  return args.map((arg) => {
    const path = resolve(arg.replace(/\/+$/, ''));
    const extension = extname(path).toLowerCase();
    if (extension !== '.app' && extension !== '.dmg') {
      throw new Error(`not a .app or .dmg: ${arg}`);
    }
    if (!existsSync(path)) throw new Error(`no such file: ${arg}`);
    const isDirectory = statSync(path).isDirectory();
    if (extension === '.app' && !isDirectory)
      throw new Error(`not an app bundle directory: ${arg}`);
    if (extension === '.dmg' && isDirectory) throw new Error(`not a disk image file: ${arg}`);
    return { kind: extension === '.app' ? 'app' : 'dmg', path };
  });
}

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout;
}

/** Attribute name → size, as listed by `ls -l@` for one path. */
function xattrSizes(path: string, directory: boolean): Map<string, number> {
  const out = run('ls', [directory ? '-ld@' : '-l@', path]);
  const sizes = new Map<string, number>();
  for (const line of out.split('\n')) {
    const match = line.match(/^\t(\S+)\t\s*(\d+)/);
    if (match) sizes.set(match[1], Number(match[2]));
  }
  return sizes;
}

function readXattr(path: string, name: string): string | null {
  const result = spawnSync('xattr', ['-p', name, path], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.replace(/\n$/, '') : null;
}

function readXattrHex(path: string, name: string): Uint8Array | null {
  const result = spawnSync('xattr', ['-px', name, path], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const hex = result.stdout.replace(/\s+/g, '');
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

const SET_ICON_JXA = `
ObjC.import('AppKit');
function run(argv) {
  const image = $.NSImage.alloc.initWithContentsOfFile(argv[0]);
  if (image.isNil()) return 'no-image';
  return $.NSWorkspace.sharedWorkspace.setIconForFileOptions(image, argv[1], 0) ? 'ok' : 'failed';
}`;

/** Postconditions the runtime check (`needs_apply`) treats as "current". */
export function verifyBakedApp(app: string, fingerprint: string): string[] {
  const problems: string[] = [];
  const iconFile = join(app, ICON_FILE_NAME);
  if (!existsSync(iconFile)) {
    problems.push('Icon\\r is missing');
  } else {
    if (!((xattrSizes(iconFile, false).get('com.apple.ResourceFork') ?? 0) > 0)) {
      problems.push('Icon\\r has no resource fork');
    }
    const marker = readXattr(iconFile, ICON_MARKER_XATTR);
    if (marker !== fingerprint)
      problems.push(`marker is ${marker ?? 'absent'}, expected ${fingerprint}`);
  }
  const finderInfo = readXattrHex(app, 'com.apple.FinderInfo');
  if (!finderInfo || !finderInfoHasCustomIcon(finderInfo)) {
    problems.push('bundle FinderInfo lacks the custom-icon flag');
  }
  return problems;
}

export function bakeApp(app: string, artPath: string = ICON_ART_PATH): string {
  const fingerprint = artFingerprint(new Uint8Array(readFileSync(artPath)));
  const status = run('osascript', ['-l', 'JavaScript', '-e', SET_ICON_JXA, artPath, app]).trim();
  if (status !== 'ok') {
    throw new Error(
      status === 'no-image'
        ? `could not load icon art ${artPath}`
        : `NSWorkspace setIcon:forFile:options: returned false for ${app}`,
    );
  }
  run('xattr', ['-w', ICON_MARKER_XATTR, fingerprint, join(app, ICON_FILE_NAME)]);
  const problems = verifyBakedApp(app, fingerprint);
  if (problems.length > 0)
    throw new Error(`baked icon on ${app} is incomplete: ${problems.join('; ')}`);
  return fingerprint;
}

export function bakeDmg(dmg: string, artPath: string = ICON_ART_PATH): string[] {
  const scratch = mkdtempSync(join(tmpdir(), 'kory-bake-dmg-'));
  const writable = join(scratch, 'writable.dmg');
  const mountPoint = join(scratch, 'mount');
  // Same directory as the original so the final rename is atomic.
  const replacement = join(dirname(dmg), `.${basename(dmg, '.dmg')}.baking-${process.pid}.dmg`);
  let attached = false;
  try {
    run('hdiutil', ['convert', dmg, '-format', 'UDRW', '-o', writable]);
    const limits = run('hdiutil', ['resize', '-limits', writable]).trim().split(/\s+/).map(Number);
    const [, current, maximum] = limits;
    if (Number.isFinite(current) && Number.isFinite(maximum)) {
      const target = Math.min(current + DMG_GROWTH_SECTORS, maximum);
      if (target > current) run('hdiutil', ['resize', '-sectors', String(target), writable]);
    }
    run('hdiutil', ['attach', writable, '-nobrowse', '-noautoopen', '-mountpoint', mountPoint]);
    attached = true;
    const apps = readdirSync(mountPoint, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
      .map((entry) => join(mountPoint, entry.name));
    if (apps.length === 0) throw new Error(`no .app at the top level of ${dmg}`);
    const baked = apps.map((app) => {
      bakeApp(app, artPath);
      return basename(app);
    });
    run('hdiutil', ['detach', mountPoint]);
    attached = false;
    rmSync(replacement, { force: true });
    // zlib-level=9 matches Tauri's bundle_dmg.sh, so baking does not bloat the image.
    run('hdiutil', [
      'convert',
      writable,
      '-format',
      'UDZO',
      '-imagekey',
      'zlib-level=9',
      '-o',
      replacement,
    ]);
    renameSync(replacement, dmg);
    return baked;
  } finally {
    if (attached) spawnSync('hdiutil', ['detach', mountPoint, '-force']);
    rmSync(replacement, { force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Returns the process exit code. `platform` is an injection seam for tests. */
export function main(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  log: (line: string) => void = console.log,
): number {
  if (platform !== 'darwin') {
    log('[apply-bundle-icon] skipped: not macOS');
    return 0;
  }
  for (const target of parseTargets(args)) {
    if (target.kind === 'app') {
      log(`[apply-bundle-icon] ${target.path}: ${bakeApp(target.path)}`);
    } else {
      log(`[apply-bundle-icon] ${target.path}: baked ${bakeDmg(target.path).join(', ')}`);
    }
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`[apply-bundle-icon] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
