import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { encodeIco, GENERATED_FILES, ICO_SIZES, ICONSET_ENTRIES } from './generate-app-icons';

const TAURI_CONF = join(import.meta.dir, '..', 'src-tauri', 'tauri.conf.json');

describe('app icon generation', () => {
  test('ICO entries point at their PNG payloads and encode 256 px as 0', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5]);
    const ico = encodeIco([
      { size: 16, png: a },
      { size: 256, png: b },
    ]);
    const view = new DataView(ico.buffer);
    expect(view.getUint16(2, true)).toBe(1);
    expect(view.getUint16(4, true)).toBe(2);
    expect(ico[6]).toBe(16);
    expect(ico[22]).toBe(0);
    expect(view.getUint32(6 + 8, true)).toBe(3);
    const firstOffset = view.getUint32(6 + 12, true);
    const secondOffset = view.getUint32(22 + 12, true);
    expect(firstOffset).toBe(6 + 16 * 2);
    expect([...ico.slice(firstOffset, firstOffset + 3)]).toEqual([1, 2, 3]);
    expect([...ico.slice(secondOffset, secondOffset + 2)]).toEqual([4, 5]);
    expect(ico.length).toBe(firstOffset + 5);
  });

  test('ICO rejects sizes Windows cannot index', () => {
    expect(() => encodeIco([{ size: 512, png: new Uint8Array() }])).toThrow();
  });

  test('the iconset covers every macOS slot up to 1024 px and the ICO stops at 256 px', () => {
    expect(ICONSET_ENTRIES.map(([, size]) => size)).toContain(1024);
    expect(ICONSET_ENTRIES).toHaveLength(10);
    expect(Math.max(...ICO_SIZES)).toBe(256);
  });

  test('every bundled icon in tauri.conf.json is generated from the master', () => {
    const conf = JSON.parse(readFileSync(TAURI_CONF, 'utf8')) as { bundle: { icon: string[] } };
    for (const icon of conf.bundle.icon) {
      expect(GENERATED_FILES).toContain(icon.replace(/^icons\//, ''));
    }
  });
});
