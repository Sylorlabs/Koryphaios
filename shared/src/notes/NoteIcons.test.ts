import { describe, expect, test } from 'bun:test';
import {
  MAX_NOTE_EMOJI_LENGTH,
  MAX_NOTE_ICON_DATA_LENGTH,
  NOTE_ICON_CHOICES,
  isNoteEmoji,
  isNoteIcon,
} from './NoteIcons';
import { NOTE_EMOJI_CATALOG, searchNoteEmoji } from './NoteIconEmojiCatalog';

describe('free emoji validation', () => {
  test.each([
    ['👩🏽‍💻', 'ZWJ sequence with skin tone'],
    ['🇯🇵', 'regional indicator flag'],
    ['❤️', 'pictograph with variation selector'],
    ['🙂', 'single pictograph'],
    ['👨‍👩‍👧', 'family ZWJ sequence'],
    ['1️⃣', 'keycap sequence'],
  ])('accepts %s (%s)', (value) => {
    expect(isNoteEmoji(value)).toBe(true);
  });

  test.each([
    ['ab', 'plain text'],
    ['1', 'bare digit'],
    ['🙂🙂', 'two emoji'],
    ['🙂 🙂', 'two emoji with a space'],
    ['a🙂', 'emoji with text'],
    ['🙂\n', 'trailing control character'],
    ['\u0007🙂', 'leading bell control'],
    [' 🙂', 'leading whitespace'],
    ['', 'empty string'],
    ['🙂'.repeat(20), 'oversized sequence'],
    ['👩🏽‍💻'.repeat(3), 'several emoji run together'],
    ['👨' + '\u200d👨'.repeat(12), 'one ZWJ sequence over the length cap'],
  ])('rejects %j (%s)', (value) => {
    expect(isNoteEmoji(value)).toBe(false);
  });

  test('rejects non-string values', () => {
    expect(isNoteEmoji(undefined)).toBe(false);
    expect(isNoteEmoji(42)).toBe(false);
  });

  test('the length cap is the documented bound', () => {
    expect(isNoteEmoji('🙂'.repeat(MAX_NOTE_EMOJI_LENGTH / 2))).toBe(false); // two graphemes
    expect(isNoteEmoji('👩🏽‍💻')).toBe(true);
  });
});

describe('note icon records', () => {
  test('stored builtin icons written before free emoji still validate', () => {
    for (const choice of NOTE_ICON_CHOICES) {
      expect(isNoteIcon({ kind: 'builtin', value: choice.value })).toBe(true);
    }
    expect(isNoteIcon({ kind: 'builtin', value: 'not an icon' })).toBe(false);
  });

  test('accepts any single emoji as kind emoji, with an optional label', () => {
    expect(isNoteIcon({ kind: 'emoji', value: '👩🏽‍💻', label: 'Code' })).toBe(true);
    expect(isNoteIcon({ kind: 'emoji', value: 'ab' })).toBe(false);
    expect(isNoteIcon({ kind: 'emoji', value: '🙂🙂' })).toBe(false);
  });

  test('rejects control characters and oversized labels', () => {
    expect(isNoteIcon({ kind: 'emoji', value: '🙂', label: 'ok\u0001' })).toBe(false);
    expect(isNoteIcon({ kind: 'emoji', value: '🙂', label: 'x'.repeat(49) })).toBe(false);
    expect(isNoteIcon({ kind: 'emoji', value: '🙂', label: '   ' })).toBe(false);
  });

  test('keeps image icons bounded and raster-only', () => {
    expect(isNoteIcon({ kind: 'image', value: 'data:image/png;base64,iVBORw0KGgo=' })).toBe(true);
    expect(isNoteIcon({ kind: 'image', value: 'https://example.com/icon.png' })).toBe(false);
    const oversized = `data:image/png;base64,${'A'.repeat(MAX_NOTE_ICON_DATA_LENGTH)}`;
    expect(isNoteIcon({ kind: 'image', value: oversized })).toBe(false);
  });
});

describe('emoji quick-pick catalog', () => {
  test('every catalog entry is one valid emoji and entries are unique', () => {
    const all = NOTE_EMOJI_CATALOG.flatMap((category) =>
      category.entries.map((entry) => entry.emoji),
    );
    expect(all.length).toBeGreaterThan(100);
    for (const emoji of all) expect(isNoteEmoji(emoji)).toBe(true);
    expect(new Set(all).size).toBe(all.length);
  });

  test('search matches names and category labels case-insensitively', () => {
    expect(searchNoteEmoji('LIGHT').map((row) => row.emoji)).toContain('💡');
    expect(searchNoteEmoji('ideas thinking').map((row) => row.emoji)).toContain('🧠');
    expect(searchNoteEmoji('no-such-word-here')).toEqual([]);
    expect(searchNoteEmoji('   ')).toHaveLength(
      NOTE_EMOJI_CATALOG.flatMap((c) => c.entries).length,
    );
  });
});
