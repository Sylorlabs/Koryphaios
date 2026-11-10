import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, 'ProjectIdentitySettings.svelte'), 'utf8');

describe('ProjectIdentitySettings', () => {
  test('keeps project icon controls honest and uses the native settings primitives', () => {
    expect(source).toContain('modeOptions');
    expect(source).toContain("label: 'Automatic'");
    // Letters and emoji share one field so the icon can draw them together.
    expect(source).toContain("label: 'Monogram & emoji'");
    expect(source).toContain("label: 'Color tile'");
    expect(source).toContain("label: 'Uploaded image'");
    expect(source).toContain('ColorPickerModal');
    expect(source).not.toContain('Use palette');
    expect(source).toContain("value: 'circle'");
    expect(source).toContain("value: 'rounded-square'");
    expect(source).toContain("value: 'square'");
    expect(source).toContain('customColor');
    expect(source).toContain('/api/workspace/project-identity');
    expect(source).toMatch(/image data is stored in browser\s+storage\./iu);
    expect(source).toContain('<KorySelect');
    expect(source).toContain('disabled={loading || saving}');
    expect(source).toContain('disabled={loading || saving || !identity}');
    expect(source).not.toMatch(/<select\b/u);
  });
});
