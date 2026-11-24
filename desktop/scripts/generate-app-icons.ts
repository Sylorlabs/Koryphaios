#!/usr/bin/env bun
/**
 * Regenerates every shipped app icon from one master image.
 *
 *   bun run desktop/scripts/generate-app-icons.ts          # write the icons
 *   bun run desktop/scripts/generate-app-icons.ts --check  # fail if any is stale
 *
 * The master is `desktop/src-tauri/icons/source/app-icon-master.png`: the bare
 * black-and-gold hexagon on a transparent square canvas. Every surface draws the
 * same pixels from it:
 *
 *   - icon.icns       a real multi-resolution ICNS (16–1024 px) for the bundle
 *   - dock-icon.png   1024 px; embedded in the binary for the running Dock tile
 *                     and the launch-time custom Finder icon
 *   - 32x32.png, 128x128.png, 128x128@2x.png   Tauri bundle / Linux icons
 *   - icon.ico        16–256 px PNG-compressed entries for Windows
 *
 * Resampling uses `sips` and the ICNS is assembled by `iconutil`, so this runs
 * on macOS. Both tools are deterministic: the same master always produces the
 * same bytes, which is what `--check` relies on.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ICONS_DIR = join(import.meta.dir, '..', 'src-tauri', 'icons');
export const MASTER_PATH = join(ICONS_DIR, 'source', 'app-icon-master.png');

/** iconutil's required iconset members: name → pixel size. */
export const ICONSET_ENTRIES: ReadonlyArray<readonly [string, number]> = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

/** Loose PNGs in desktop/src-tauri/icons: file name → pixel size. */
export const PNG_OUTPUTS: ReadonlyArray<readonly [string, number]> = [
  ['32x32.png', 32],
  ['128x128.png', 128],
  ['128x128@2x.png', 256],
  ['dock-icon.png', 1024],
];

export const ICO_SIZES: readonly number[] = [16, 24, 32, 48, 64, 256];

/** Every file this script owns, relative to desktop/src-tauri/icons. */
export const GENERATED_FILES: readonly string[] = [
  'icon.icns',
  'icon.ico',
  ...PNG_OUTPUTS.map(([name]) => name),
];

/**
 * Packs PNG images into a Windows ICO container. Each entry keeps its PNG
 * encoding (valid since Vista); a 256 px entry is written as size byte 0.
 */
export function encodeIco(images: ReadonlyArray<{ size: number; png: Uint8Array }>): Uint8Array {
  const headerSize = 6;
  const entrySize = 16;
  let offset = headerSize + entrySize * images.length;
  const total = offset + images.reduce((sum, image) => sum + image.png.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // type: icon
  view.setUint16(4, images.length, true);
  images.forEach((image, index) => {
    if (!Number.isInteger(image.size) || image.size < 1 || image.size > 256) {
      throw new Error(`ICO entries must be 1–256 px, got ${image.size}`);
    }
    const entry = headerSize + entrySize * index;
    out[entry] = image.size === 256 ? 0 : image.size;
    out[entry + 1] = image.size === 256 ? 0 : image.size;
    out[entry + 2] = 0; // palette colors
    out[entry + 3] = 0; // reserved
    view.setUint16(entry + 4, 1, true); // color planes
    view.setUint16(entry + 6, 32, true); // bits per pixel
    view.setUint32(entry + 8, image.png.length, true);
    view.setUint32(entry + 12, offset, true);
    out.set(image.png, offset);
    offset += image.png.length;
  });
  return out;
}

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) {
    throw new Error(
      `${command} is unavailable (${result.error.message}); icon generation needs macOS sips and iconutil`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function imageProperty(path: string, key: string): string {
  const match = run('sips', ['-g', key, path]).match(new RegExp(`${key}:\\s*(\\S+)`));
  if (!match) throw new Error(`sips did not report ${key} for ${path}`);
  return match[1];
}

function validateMaster(path: string): void {
  if (!existsSync(path)) throw new Error(`missing icon master: ${path}`);
  const width = Number(imageProperty(path, 'pixelWidth'));
  const height = Number(imageProperty(path, 'pixelHeight'));
  const format = imageProperty(path, 'format');
  const alpha = imageProperty(path, 'hasAlpha');
  if (format !== 'png') throw new Error(`icon master must be a PNG, got ${format}`);
  if (width !== height) throw new Error(`icon master must be square, got ${width}x${height}`);
  if (width < 1024) throw new Error(`icon master must be at least 1024 px, got ${width}`);
  // The hexagon is drawn on a transparent canvas; an opaque master would ship
  // a square tile behind it on every surface.
  if (alpha !== 'yes') throw new Error('icon master must have an alpha channel');
}

function resize(master: string, size: number, out: string): void {
  run('sips', ['-s', 'format', 'png', '-z', String(size), String(size), master, '--out', out]);
}

/** Renders every generated file into `outDir`. */
export function renderIcons(master: string, outDir: string): void {
  validateMaster(master);
  const scratch = mkdtempSync(join(tmpdir(), 'kory-app-icons-'));
  try {
    const iconset = join(scratch, 'AppIcon.iconset');
    mkdirSync(iconset);
    for (const [name, size] of ICONSET_ENTRIES) resize(master, size, join(iconset, name));
    run('iconutil', ['-c', 'icns', iconset, '-o', join(outDir, 'icon.icns')]);

    for (const [name, size] of PNG_OUTPUTS) resize(master, size, join(outDir, name));

    const icoImages = ICO_SIZES.map((size) => {
      const file = join(scratch, `ico-${size}.png`);
      resize(master, size, file);
      return { size, png: new Uint8Array(readFileSync(file)) };
    });
    writeFileSync(join(outDir, 'icon.ico'), encodeIco(icoImages));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main(): void {
  const check = process.argv.includes('--check');
  if (!check) {
    renderIcons(MASTER_PATH, ICONS_DIR);
    console.log(`Regenerated ${GENERATED_FILES.join(', ')} from ${MASTER_PATH}`);
    return;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'kory-app-icons-check-'));
  try {
    renderIcons(MASTER_PATH, scratch);
    const stale = GENERATED_FILES.filter((name) => {
      const committed = join(ICONS_DIR, name);
      return (
        !existsSync(committed) || !readFileSync(committed).equals(readFileSync(join(scratch, name)))
      );
    });
    if (stale.length > 0) {
      console.error(
        `App icons are stale: ${stale.join(', ')}. Run bun run desktop/scripts/generate-app-icons.ts`,
      );
      process.exit(1);
    }
    console.log('App icons match the master.');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) main();
