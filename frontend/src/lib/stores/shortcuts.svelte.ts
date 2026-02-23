// Keyboard shortcuts — editable, persisted to localStorage, Svelte 5 runes

import { browser } from '$app/environment';

export interface Shortcut {
  id: string;
  keys: string[];
  action: string;
}

const STORAGE_KEY = 'koryphaios-shortcuts';

const defaultShortcuts: Shortcut[] = [
  { id: 'send', keys: ['Ctrl', 'Enter'], action: 'Send message' },
  { id: 'settings', keys: ['Ctrl', ','], action: 'Open settings' },
  { id: 'new_session', keys: ['Ctrl', 'N'], action: 'New session' },
  { id: 'focus_input', keys: ['Ctrl', 'K'], action: 'Focus input' },
  { id: 'close', keys: ['Esc'], action: 'Close dialogs' },
];

function loadShortcuts(): Shortcut[] {
  if (!browser) return structuredClone(defaultShortcuts);
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch {}
  return structuredClone(defaultShortcuts);
}

function createShortcutStore() {
  let shortcuts = $state<Shortcut[]>(loadShortcuts());

  return {
    get list() { return shortcuts; },
    set list(v: Shortcut[]) { shortcuts = v; },

    save() {
      if (browser) localStorage.setItem(STORAGE_KEY, JSON.stringify(shortcuts));
    },

    reset() {
      shortcuts = structuredClone(defaultShortcuts);
      if (browser) localStorage.removeItem(STORAGE_KEY);
    },

    /** Check if a KeyboardEvent matches a given shortcut id */
    matches(id: string, e: KeyboardEvent): boolean {
      const shortcut = shortcuts.find(s => s.id === id);
      if (!shortcut) return false;
      return keysMatch(shortcut.keys, e);
    },
  };
}

/** Check if a KeyboardEvent matches a set of shortcut key strings */
function keysMatch(keys: string[], e: KeyboardEvent): boolean {
  const wantCtrl = keys.includes('Ctrl');
  const wantShift = keys.includes('Shift');
  const wantAlt = keys.includes('Alt');
  const wantMeta = keys.includes('Meta');

  // Accept Ctrl OR Meta for cross-platform compat
  const modOk = wantCtrl ? (e.ctrlKey || e.metaKey) : !(e.ctrlKey || e.metaKey);
  const shiftOk = wantShift === e.shiftKey;
  const altOk = wantAlt === e.altKey;
  const metaOk = wantMeta ? e.metaKey : true; // already handled via modOk for Ctrl

  if (!modOk || !shiftOk || !altOk) return false;
  // If only Meta is wanted (not Ctrl), check it directly
  if (wantMeta && !wantCtrl && !e.metaKey) return false;

  // Find the non-modifier key in the shortcut
  const nonModKeys = keys.filter(k => !['Ctrl', 'Shift', 'Alt', 'Meta'].includes(k));
  if (nonModKeys.length === 0) return false;

  const target = nonModKeys[0];

  // Normalize the event key for comparison
  const eventKey = e.key.length === 1 ? e.key.toUpperCase() : e.key;

  // Handle special mappings
  if (target === 'Esc' || target === 'Escape') {
    return eventKey === 'Escape';
  }
  if (target === 'Enter') {
    return eventKey === 'Enter';
  }

  return eventKey === target.toUpperCase() || eventKey === target;
}

export const shortcutStore = createShortcutStore();
