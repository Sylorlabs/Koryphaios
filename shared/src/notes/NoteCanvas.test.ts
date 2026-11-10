import { describe, expect, test } from 'bun:test';
import { canvasFromNotes, validateNoteCanvas } from './NoteCanvas';
import { effectiveNotePermission } from './NotePermissionPolicy';
import {
  applyNotesPermissionPreset,
  normalizeNotesAgentPermissions,
  DEFAULT_NOTE_TOOL_PERMISSIONS,
} from '../types/NoteTypes';

describe('shared Canvas contract', () => {
  test('round trips portable note cards without changing links', () => {
    const doc = canvasFromNotes('Investigation', [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ]);
    expect(validateNoteCanvas(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    expect(doc.edges).toEqual([]);
  });
  test('rejects malformed cards, duplicates and dangling edges instead of dropping data', () => {
    const doc = canvasFromNotes('Board', [{ id: 'a', title: 'A' }]);
    for (const invalid of [
      { ...doc, v: 2 },
      { ...doc, cards: [{}] },
      { ...doc, cards: [doc.cards[0], doc.cards[0]] },
      { ...doc, cards: [{ ...doc.cards[0], x: Infinity }] },
      { ...doc, cards: [{ ...doc.cards[0], color: 'red; background:url(x)' }] },
      { ...doc, edges: [{ id: 'edge', from: 'note-0', to: 'missing' }] },
    ])
      expect(() => validateNoteCanvas(invalid)).toThrow(/Invalid canvas/);
  });
});
describe('dedicated Notes permissions', () => {
  test('mode defaults never overwrite explicit choices, including Ask equal to the default', () => {
    const defaults = normalizeNotesAgentPermissions({ preset: 'default' });
    expect(effectiveNotePermission(defaults, 'patch_note_canvas', 'ask')).toBe('ask');
    expect(effectiveNotePermission(defaults, 'patch_note_canvas', 'guarded')).toBe('auto');
    const explicit = normalizeNotesAgentPermissions({
      preset: 'default',
      tools: DEFAULT_NOTE_TOOL_PERMISSIONS,
      overrides: { patch_note_canvas: 'ask' },
    });
    expect(effectiveNotePermission(explicit, 'patch_note_canvas', 'yolo')).toBe('auto');
    const roundTrip = normalizeNotesAgentPermissions(JSON.parse(JSON.stringify(explicit)));
    expect(roundTrip.overrides?.patch_note_canvas).toBe('ask');
    expect(effectiveNotePermission(roundTrip, 'patch_note_canvas', 'guarded')).toBe('ask');
  });
  test('restrictive legacy presets and block overrides govern newly added operations', () => {
    expect(
      effectiveNotePermission(
        normalizeNotesAgentPermissions({ preset: 'ask_all' }),
        'patch_note_canvas',
        'yolo',
      ),
    ).toBe('auto');
    const blocked = normalizeNotesAgentPermissions({
      preset: 'default',
      overrides: { patch_note_canvas: 'block' },
    });
    expect(blocked.tools.patch_note_canvas).toBe('block');
    expect(effectiveNotePermission(blocked, 'patch_note_canvas', 'guarded')).toBe('block');
    expect(applyNotesPermissionPreset('default').overrides).toEqual({});
  });
});
