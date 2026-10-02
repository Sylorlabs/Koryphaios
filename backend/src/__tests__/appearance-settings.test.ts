import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAppearanceSettings, saveAppearanceSettings } from '../appearance-settings';

const originalPath = process.env.KORYPHAIOS_APPEARANCE_SETTINGS_PATH;
const tempRoots: string[] = [];

afterEach(() => {
  if (originalPath === undefined) delete process.env.KORYPHAIOS_APPEARANCE_SETTINGS_PATH;
  else process.env.KORYPHAIOS_APPEARANCE_SETTINGS_PATH = originalPath;
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('appearance settings', () => {
  test('persists primary and secondary custom accents as device settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-appearance-'));
    tempRoots.push(root);
    const path = join(root, 'appearance.json');
    process.env.KORYPHAIOS_APPEARANCE_SETTINGS_PATH = path;

    const saved = saveAppearanceSettings({
      preset: 'midnight',
      accent: 'custom',
      secondaryAccent: 'custom',
      font: 'geist',
      customAccent: { main: '#123456', hover: '#345678' },
      customSecondaryAccent: { main: '#ABCDEF', hover: '#CDEFFF' },
    });

    expect(saved.updatedAt).toBeNumber();
    expect(loadAppearanceSettings()).toEqual(saved);
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual(saved);
  });

  test('returns null before this device has saved appearance settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-appearance-empty-'));
    tempRoots.push(root);
    process.env.KORYPHAIOS_APPEARANCE_SETTINGS_PATH = join(root, 'missing.json');

    expect(loadAppearanceSettings()).toBeNull();
  });
});
