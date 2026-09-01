import { describe, expect, it } from 'vitest';
import {
  defaultNoteBaseFilterValue,
  normalizedNoteBasePropertyKey,
  noteBaseFieldCanSort,
  noteBaseFieldType,
} from './note-base-editor';

describe('Base editor type contract', () => {
  it('maps system fields to the same types enforced by the backend', () => {
    expect(noteBaseFieldType({ source: 'system', field: 'tags' })).toBe('tags');
    expect(noteBaseFieldType({ source: 'system', field: 'pinned' })).toBe('checkbox');
    expect(noteBaseFieldType({ source: 'system', field: 'context' })).toBe('checkbox');
    expect(noteBaseFieldType({ source: 'system', field: 'created' })).toBe('datetime');
    expect(noteBaseFieldType({ source: 'system', field: 'updated' })).toBe('datetime');
    expect(noteBaseFieldType({ source: 'system', field: 'title' })).toBe('text');
  });

  it('does not offer sorts or invalid defaults that persistence will reject', () => {
    const now = new Date('2026-08-30T20:42:00.000Z');
    expect(noteBaseFieldCanSort({ source: 'system', field: 'tags' })).toBe(false);
    expect(noteBaseFieldCanSort(null)).toBe(false);
    expect(noteBaseFieldCanSort({ source: 'property', key: 'owners', type: 'list' })).toBe(false);
    expect(noteBaseFieldCanSort({ source: 'property', key: 'score', type: 'number' })).toBe(true);
    expect(defaultNoteBaseFilterValue({ source: 'system', field: 'pinned' })).toBe(true);
    expect(defaultNoteBaseFilterValue({ source: 'property', key: 'score', type: 'number' })).toBe(
      0,
    );
    expect(defaultNoteBaseFilterValue({ source: 'property', key: 'due', type: 'date' }, now)).toBe(
      '2026-08-30',
    );
    expect(defaultNoteBaseFilterValue({ source: 'system', field: 'updated' }, now)).toBe(
      '2026-08-30T20:42:00.000Z',
    );
  });

  it('uses the same Unicode key normalization as property projection', () => {
    expect(normalizedNoteBasePropertyKey('caf\u00e9')).toBe(
      normalizedNoteBasePropertyKey('cafe\u0301'),
    );
  });
});
