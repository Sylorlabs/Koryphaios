import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('MenuBar window controls', () => {
  it('uses native fullscreen for the macOS expansion control', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/components/MenuBar.svelte'), 'utf8');

    expect(source).toContain("import { getModKeyName, isMac } from '$lib/utils/platform'");
    expect(source).toMatch(
      /if \(usesNativeFullscreen\)[\s\S]*?invoke<boolean>\('toggle_fullscreen'\)[\s\S]*?else[\s\S]*?invoke\('toggle_maximize'\)[\s\S]*?isMaximized\(\)/,
    );
    expect(source).toContain("'Enter Full Screen'");
    expect(source).toContain("'Exit Full Screen'");
  });
});
