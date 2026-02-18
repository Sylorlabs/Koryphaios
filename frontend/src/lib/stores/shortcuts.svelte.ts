// Keyboard shortcuts — editable, persisted to localStorage, Svelte 5 runes

import { isMac } from '$lib/utils/platform';

export interface Shortcut {
  id: string;
  keys: string[];
  action: string;
}

const STORAGE_KEY = 'koryphaios-shortcuts';

const defaultShortcuts: Shortcut[] = [
  { id: 'send', keys: ['Mod', 'Enter'], action: 'Send message' },
  { id: 'settings', keys: ['Mod', ','], action: 'Open settings' },
  { id: 'new_session', keys: ['Mod', 'N'], action: 'New session' },
  { id: 'focus_input', keys: ['Mod', 'Shift', 'K'], action: 'Focus input' },
  { id: 'toggle_palette', keys: ['Mod', 'K'], action: 'Command palette' },
  { id: 'toggle_zen_mode', keys: ['Mod', 'Shift', 'Z'], action: 'Toggle Zen mode' },
  { id: 'toggle_yolo', keys: ['Mod', 'Y'], action: 'Toggle YOLO mode' },
  { id: 'close', keys: ['Esc'], action: 'Close dialogs' },
];

function loadShortcuts(): Shortcut[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      let parsed = JSON.parse(stored) as Shortcut[];

      // Migrate old 'Ctrl' shortcuts to 'Mod'
      parsed = parsed.map(s => ({
        ...s,
        keys: s.keys.map(k => k === 'Ctrl' ? 'Mod' : k)
      }));

      // Merge in missing default shortcuts
      for (const def of defaultShortcuts) {
        if (!parsed.some(s => s.id === def.id)) {
          parsed.push(structuredClone(def));
        }
      }

      return parsed;
    }
  } catch {}
  return structuredClone(defaultShortcuts);
}

function createShortcutStore() {
  let shortcuts = $state<Shortcut[]>(loadShortcuts());

  return {
    get list() { return shortcuts; },
    set list(v: Shortcut[]) { shortcuts = v; },

    save() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(shortcuts));
    },

    reset() {
      shortcuts = structuredClone(defaultShortcuts);
      localStorage.removeItem(STORAGE_KEY);
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
  const isMacPlatform = isMac();
  const wantMod = keys.includes('Mod');
  const wantCtrl = keys.includes('Ctrl');
  const wantShift = keys.includes('Shift');
  const wantAlt = keys.includes('Alt');
  const wantMeta = keys.includes('Meta');

  // Map 'Mod' to Meta on Mac, Ctrl elsewhere
  const actualWantCtrl = wantCtrl || (!isMacPlatform && wantMod);
  const actualWantMeta = wantMeta || (isMacPlatform && wantMod);

  const ctrlOk = actualWantCtrl === e.ctrlKey;
  const metaOk = actualWantMeta === e.metaKey;
  const shiftOk = wantShift === e.shiftKey;
  const altOk = wantAlt === e.altKey;

  if (!ctrlOk || !metaOk || !shiftOk || !altOk) return false;

  // Find the non-modifier key in the shortcut
  const nonModKeys = keys.filter(k => !['Ctrl', 'Shift', 'Alt', 'Meta', 'Mod'].includes(k));
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
