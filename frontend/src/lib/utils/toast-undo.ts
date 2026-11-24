// Routing for the undo shortcut. Kept free of Svelte so the rules are testable
// on their own: which key chord counts as undo, and when it must be left alone
// because the reader is typing.

import { isMac } from '$lib/utils/platform';

export interface UndoChordEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * True for the platform undo chord (Mod+Z): Command on macOS, Control elsewhere.
 * Shift and Alt variants (redo, and other chords) are not undo.
 */
export function isUndoChord(event: UndoChordEvent, mac: boolean = isMac()): boolean {
  if (event.shiftKey || event.altKey) return false;
  const modPressed = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return modPressed && event.key.toLowerCase() === 'z';
}

/**
 * True when the target takes its own text undo: an input, a textarea, or any
 * contenteditable region. The toast undo must never steal those keystrokes.
 */
export function isTextEntryTarget(target: EventTarget | null | undefined): boolean {
  if (!target || typeof (target as Element).tagName !== 'string') return false;
  const element = target as Element;
  const tag = element.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  const editable = element.closest?.('[contenteditable]');
  return !!editable && editable.getAttribute('contenteditable') !== 'false';
}
