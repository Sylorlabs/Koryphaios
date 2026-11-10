import { describe, expect, test } from 'bun:test';
import {
  automaticProjectIcon,
  normalizeProjectIconCustomColor,
  normalizeProjectIconMode,
  normalizeProjectIconSpec,
  resolveProjectIcon,
} from './project-identity';

describe('project identity icon contract', () => {
  test('unknown icon modes fall back to automatic', () => {
    expect(normalizeProjectIconMode('gradient')).toBe('automatic');
    expect(normalizeProjectIconSpec({ mode: 'gradient', value: '#fff' })).toEqual({
      mode: 'automatic',
    });
    expect(
      resolveProjectIcon({ id: 'project-1', name: 'Koryphaios' }, { mode: 'future' }).mode,
    ).toBe('monogram');
  });

  test('bounds emoji and monograms by Unicode grapheme count', () => {
    expect(normalizeProjectIconSpec({ mode: 'emoji', value: '👨‍👩‍👧‍👦' })).toEqual({
      mode: 'emoji',
      value: '👨‍👩‍👧‍👦',
      color: undefined,
    });
    expect(normalizeProjectIconSpec({ mode: 'emoji', value: '🚀⭐' })).toEqual({
      mode: 'automatic',
    });
    expect(normalizeProjectIconSpec({ mode: 'monogram', value: 'Á🧪' })).toMatchObject({
      mode: 'monogram',
      value: 'Á🧪',
    });
    expect(normalizeProjectIconSpec({ mode: 'monogram', value: 'ABC' })).toEqual({
      mode: 'automatic',
    });
  });

  test('automatic icons are deterministic and include a curated color token', () => {
    const identity = { id: 'opaque-project-id', name: '✨ Design Lab' };
    const first = automaticProjectIcon(identity);
    expect(automaticProjectIcon(identity)).toEqual(first);
    expect(first.value).toBe('✨D');
    expect(first.color).toBeDefined();
    if (first.color === undefined) {
      throw new Error('Automatic project icons must include a curated color token');
    }
    expect(['accent', 'blue', 'green', 'orange', 'pink', 'purple', 'teal']).toContain(first.color);
    expect(resolveProjectIcon(identity, { mode: 'automatic' })).toEqual(first);
  });

  test('image icons carry opaque asset IDs rather than paths or URLs', () => {
    expect(normalizeProjectIconSpec({ mode: 'image', assetId: 'asset_01HQ' })).toEqual({
      mode: 'image',
      assetId: 'asset_01HQ',
      color: undefined,
    });
    expect(normalizeProjectIconSpec({ mode: 'image', assetId: '/tmp/project.png' })).toEqual({
      mode: 'automatic',
    });
    expect(
      normalizeProjectIconSpec({ mode: 'image', assetId: 'https://example.test/icon.png' }),
    ).toEqual({
      mode: 'automatic',
    });
    expect(
      normalizeProjectIconSpec({ mode: 'emoji', value: '🚀', color: 'var(--danger)' }),
    ).toEqual({
      mode: 'emoji',
      value: '🚀',
      color: undefined,
    });
    expect(normalizeProjectIconSpec({ mode: 'color', color: 'teal' })).toEqual({
      mode: 'color',
      color: 'teal',
    });
    expect(normalizeProjectIconSpec({ mode: 'color', color: '#fff' })).toEqual({
      mode: 'automatic',
    });
  });

  test('normalizes custom colors and preserves the supported icon shapes', () => {
    expect(normalizeProjectIconCustomColor('#abc')).toBe('#AABBCC');
    expect(normalizeProjectIconCustomColor('not-a-color')).toBeUndefined();
    expect(
      normalizeProjectIconSpec({
        mode: 'monogram',
        value: 'DL',
        customColor: '#36c',
        shape: 'circle',
      }),
    ).toEqual({
      mode: 'monogram',
      value: 'DL',
      customColor: '#3366CC',
      shape: 'circle',
    });
    expect(
      normalizeProjectIconSpec({ mode: 'color', customColor: '#123456', shape: 'square' }),
    ).toEqual({
      mode: 'color',
      customColor: '#123456',
      shape: 'square',
    });
    expect(normalizeProjectIconSpec({ mode: 'emoji', value: '🧪', shape: 'pill' })).toEqual({
      mode: 'emoji',
      value: '🧪',
      color: undefined,
    });
  });
});
