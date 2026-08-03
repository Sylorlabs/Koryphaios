// Keyboard shortcuts — editable, persisted to localStorage, Svelte 5 runes

import { isLinux, isMac } from '$lib/utils/platform';

export interface Shortcut {
  id: string;
  keys: string[];
  action: string;
  description?: string;
}

const STORAGE_KEY = 'koryphaios-shortcuts';

/** Shortcut IDs that have been removed from defaults and should be pruned from stored configs */
const RETIRED_SHORTCUT_IDS = new Set<string>(['toggle_yolo']);

const clipboardShortcuts: Shortcut[] = isLinux()
  ? [
      { id: 'copy_text', keys: ['Mod', 'Shift', 'C'], action: 'Copy text', description: 'Selected text' },
      { id: 'copy_image', keys: ['Mod', 'C'], action: 'Copy image', description: 'Opened image' },
      { id: 'paste_text', keys: ['Mod', 'Shift', 'V'], action: 'Paste text', description: 'Into composer' },
      { id: 'paste_image', keys: ['Mod', 'V'], action: 'Paste image', description: 'Into composer' },
    ]
  : [
      { id: 'copy_text', keys: ['Mod', 'C'], action: 'Copy text', description: 'Selected text' },
      { id: 'copy_image', keys: ['Mod', 'C'], action: 'Copy image', description: 'Opened image' },
      { id: 'paste_text', keys: ['Mod', 'V'], action: 'Paste text', description: 'Into composer' },
      { id: 'paste_image', keys: ['Mod', 'V'], action: 'Paste image', description: 'Into composer' },
    ];

const defaultShortcuts: Shortcut[] = [
  { id: 'send', keys: ['Mod', 'Enter'], action: 'Send message', description: 'Submit task' },
  { id: 'settings', keys: ['Mod', ','], action: 'Open settings', description: 'Preferences' },
  { id: 'new_session', keys: ['Mod', 'N'], action: 'New session', description: 'Clear' },
  { id: 'focus_input', keys: ['Mod', 'Shift', 'K'], action: 'Focus input', description: 'Jump' },
  ...clipboardShortcuts,
  {
    id: 'toggle_palette',
    keys: ['Mod', 'K'],
    action: 'Command palette',
    description: 'Open palette',
  },
  {
    id: 'toggle_zen_mode',
    keys: ['Mod', 'Shift', 'Z'],
    action: 'Toggle Zen mode',
    description: 'Focus',
  },
  {
    id: 'undo',
    keys: ['Mod', 'Z'],
    action: 'Undo',
    description: 'Revert to previous state',
  },
  {
    id: 'redo',
    keys: ['Mod', 'Y'],
    action: 'Redo',
    description: 'Restore next state',
  },
  { id: 'close', keys: ['Esc'], action: 'Close dialogs', description: 'Back' },
];

export { defaultShortcuts };

function loadShortcuts(): Shortcut[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      let parsed = JSON.parse(stored) as Shortcut[];

      // Migrate old 'Ctrl' shortcuts to 'Mod'
      parsed = parsed.map((s) => ({
        ...s,
        keys: s.keys.map((k) => (k === 'Ctrl' ? 'Mod' : k)),
      }));

      // Remove retired shortcuts (e.g. toggle_yolo, replaced by undo/redo)
      parsed = parsed.filter((s) => !RETIRED_SHORTCUT_IDS.has(s.id));

      // The first clipboard shortcuts used Kory-specific bindings. Upgrade only
      // those original values; intentionally customized bindings are preserved.
      const oldClipboardKeys: Record<string, string[]> = {
        copy_text: ['Mod', 'Shift', 'C'],
        copy_image: ['Mod', 'Shift', 'I'],
        paste_text: ['Mod', 'Shift', 'V'],
        paste_image: ['Mod', 'Alt', 'V'],
      };
      for (const shortcut of parsed) {
        const previous = oldClipboardKeys[shortcut.id];
        const replacement = clipboardShortcuts.find((candidate) => candidate.id === shortcut.id);
        if (previous && replacement && JSON.stringify(shortcut.keys) === JSON.stringify(previous)) {
          shortcut.keys = [...replacement.keys];
        }
      }

      // Merge in missing default shortcuts
      for (const def of defaultShortcuts) {
        if (!parsed.some((s) => s.id === def.id)) {
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
    get list() {
      return shortcuts;
    },
    set list(v: Shortcut[]) {
      shortcuts = v;
    },

    save() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(shortcuts));
    },

    reset() {
      shortcuts = structuredClone(defaultShortcuts);
      localStorage.removeItem(STORAGE_KEY);
    },

    /** Check if a KeyboardEvent matches a given shortcut id */
    matches(id: string, e: KeyboardEvent): boolean {
      const shortcut = shortcuts.find((s) => s.id === id);
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
  const nonModKeys = keys.filter((k) => !['Ctrl', 'Shift', 'Alt', 'Meta', 'Mod'].includes(k));
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
