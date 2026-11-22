// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { isTextEntryTarget, isUndoChord } from './toast-undo';

function chord(overrides: Partial<Parameters<typeof isUndoChord>[0]>) {
  return { key: 'z', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...overrides };
}

describe('isUndoChord', () => {
  it('uses Command on macOS and Control elsewhere', () => {
    expect(isUndoChord(chord({ metaKey: true }), true)).toBe(true);
    expect(isUndoChord(chord({ ctrlKey: true }), true)).toBe(false);
    expect(isUndoChord(chord({ ctrlKey: true }), false)).toBe(true);
    expect(isUndoChord(chord({ metaKey: true }), false)).toBe(false);
  });

  it('ignores redo and other shifted or alt chords', () => {
    expect(isUndoChord(chord({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isUndoChord(chord({ ctrlKey: true, altKey: true }), false)).toBe(false);
  });

  it('ignores other keys', () => {
    expect(isUndoChord(chord({ key: 'y', ctrlKey: true }), false)).toBe(false);
  });
});

describe('isTextEntryTarget', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('treats inputs and textareas as text entry', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    document.body.append(input, textarea);
    expect(isTextEntryTarget(input)).toBe(true);
    expect(isTextEntryTarget(textarea)).toBe(true);
  });

  it('treats contenteditable regions, including descendants, as text entry', () => {
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const child = document.createElement('span');
    editor.append(child);
    document.body.append(editor);
    expect(isTextEntryTarget(editor)).toBe(true);
    expect(isTextEntryTarget(child)).toBe(true);
  });

  it('does not treat a locked contenteditable or a plain button as text entry', () => {
    const locked = document.createElement('div');
    locked.setAttribute('contenteditable', 'false');
    const button = document.createElement('button');
    document.body.append(locked, button);
    expect(isTextEntryTarget(locked)).toBe(false);
    expect(isTextEntryTarget(button)).toBe(false);
    expect(isTextEntryTarget(document.body)).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});
