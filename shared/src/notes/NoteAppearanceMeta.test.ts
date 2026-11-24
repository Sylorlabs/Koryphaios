import { describe, expect, test } from 'bun:test';
import {
  normalizeFolderAppearance,
  normalizeFolderAppearancePath,
  normalizeNoteAppearanceColor,
  normalizeNoteAppearanceEmoji,
  normalizeTagAppearance,
  resolveNoteAppearanceColorCss,
} from './NoteAppearanceMeta';

describe('note appearance emoji', () => {
  test('accepts exactly one pictograph, including ZWJ families and flags', () => {
    expect(normalizeNoteAppearanceEmoji('📁')).toEqual({ ok: true, value: '📁' });
    expect(normalizeNoteAppearanceEmoji('  🧑‍💻  ')).toEqual({ ok: true, value: '🧑‍💻' });
    expect(normalizeNoteAppearanceEmoji('🇩🇪')).toEqual({ ok: true, value: '🇩🇪' });
  });

  test('blank and absent values mean no emoji', () => {
    expect(normalizeNoteAppearanceEmoji(undefined)).toEqual({ ok: true, value: undefined });
    expect(normalizeNoteAppearanceEmoji(null)).toEqual({ ok: true, value: undefined });
    expect(normalizeNoteAppearanceEmoji('   ')).toEqual({ ok: true, value: undefined });
  });

  test('rejects text, multiple emoji and non-pictographic graphemes', () => {
    for (const value of ['folder', '📁📁', 'a', '7', '1⃣', 42, '📁\u0007']) {
      expect(normalizeNoteAppearanceEmoji(value).ok).toBe(false);
    }
  });
});

describe('note appearance color', () => {
  test('accepts the theme accent keyword and palette tokens', () => {
    expect(normalizeNoteAppearanceColor('accent')).toEqual({ ok: true, value: 'accent' });
    expect(normalizeNoteAppearanceColor(' Teal ')).toEqual({ ok: true, value: 'teal' });
  });

  test('accepts hex and expands three-digit hex to lowercase six-digit', () => {
    expect(normalizeNoteAppearanceColor('#ABC')).toEqual({ ok: true, value: '#aabbcc' });
    expect(normalizeNoteAppearanceColor('#A1b2C3')).toEqual({ ok: true, value: '#a1b2c3' });
  });

  test('rejects CSS functions, unknown names and injection attempts', () => {
    for (const value of [
      'red',
      'rgb(1,2,3)',
      '#12',
      '#gggggg',
      'url(https://x)',
      '#fff;background:url(x)',
      42,
    ]) {
      expect(normalizeNoteAppearanceColor(value).ok).toBe(false);
    }
  });

  test('resolves accent to the theme token and palette names to hex', () => {
    expect(resolveNoteAppearanceColorCss('accent')).toBe('var(--color-accent)');
    expect(resolveNoteAppearanceColorCss('rose')).toBe('#e11d48');
    expect(resolveNoteAppearanceColorCss('#123456')).toBe('#123456');
    expect(resolveNoteAppearanceColorCss(undefined)).toBeUndefined();
  });
});

describe('note appearance folder paths', () => {
  test('canonicalizes to a leading-slash path and treats blank as root', () => {
    expect(normalizeFolderAppearancePath('')).toEqual({ ok: true, value: '/' });
    expect(normalizeFolderAppearancePath('/')).toEqual({ ok: true, value: '/' });
    expect(normalizeFolderAppearancePath('Projects//api/ ')).toEqual({
      ok: true,
      value: '/Projects/api',
    });
    expect(normalizeFolderAppearancePath('\\Work\\docs')).toEqual({
      ok: true,
      value: '/Work/docs',
    });
  });

  test('rejects relative segments and control characters', () => {
    expect(normalizeFolderAppearancePath('/a/../b').ok).toBe(false);
    expect(normalizeFolderAppearancePath('/a/./b').ok).toBe(false);
    expect(normalizeFolderAppearancePath('/a\u0000b').ok).toBe(false);
    expect(normalizeFolderAppearancePath(12).ok).toBe(false);
  });
});

describe('folder and tag appearance records', () => {
  test('an empty folder appearance normalizes to null so the record is dropped', () => {
    expect(normalizeFolderAppearance({ path: '/x', emoji: '', color: null })).toEqual({
      ok: true,
      value: null,
    });
  });

  test('a populated folder appearance keeps only set fields', () => {
    expect(normalizeFolderAppearance({ path: '/x/', emoji: '🚀' })).toEqual({
      ok: true,
      value: { path: '/x', emoji: '🚀' },
    });
  });

  test('tag appearance trims the tag and validates both fields', () => {
    expect(normalizeTagAppearance({ tag: ' urgent ', color: 'rose' })).toEqual({
      ok: true,
      value: { tag: 'urgent', color: 'rose' },
    });
    expect(normalizeTagAppearance({ tag: '   ' }).ok).toBe(false);
    expect(normalizeTagAppearance({ tag: 'x'.repeat(101) }).ok).toBe(false);
    expect(normalizeTagAppearance({ tag: 'ok', emoji: 'not an emoji' }).ok).toBe(false);
  });
});
