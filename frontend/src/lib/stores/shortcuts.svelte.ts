// Keyboard shortcuts — editable, persisted to localStorage, Svelte 5 runes

import { isMac, formatKey } from '$lib/utils/platform';

export interface Shortcut {
  id: string;
  keys: string[];
  /** Extra chords that trigger the same action. Voice mode uses one so the
   *  push-to-talk key stays reachable when a platform never reports it. */
  altKeys?: string[][];
  action: string;
  description?: string;
}

/** Modifiers a chord is built from. Everything else is a target key, including
 *  fn, which is a target even though the platform may also report it as a
 *  hardware modifier. */
const MODIFIER_KEYS = ['Ctrl', 'Shift', 'Alt', 'Meta', 'Mod'];

/** True when a chord has no modifier, so it would collide with plain typing. */
export function isBareKeyChord(keys: string[]): boolean {
  return !keys.some((key) => key === 'Mod' || key === 'Ctrl' || key === 'Meta' || key === 'Alt');
}

const STORAGE_KEY = 'koryphaios-shortcuts';

const defaultShortcuts: Shortcut[] = [
  { id: 'send', keys: ['Mod', 'Enter'], action: 'Send message', description: 'Submit task' },
  { id: 'settings', keys: ['Mod', ','], action: 'Open settings', description: 'Preferences' },
  { id: 'new_session', keys: ['Mod', 'N'], action: 'New session', description: 'Clear' },
  { id: 'focus_input', keys: ['Mod', 'Shift', 'K'], action: 'Focus input', description: 'Jump' },
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
    id: 'voice_mode',
    // Push to talk: hold to record, release to transcribe. fn is the natural
    // key for it, but macOS keeps fn/Globe for dictation and never reports it
    // to a webview, so the chord that always works is kept alongside.
    keys: ['Fn'],
    altKeys: [['Mod', 'Shift', 'M']],
    action: 'Voice mode',
    description: 'Hold to record, release to transcribe',
  },
  { id: 'close', keys: ['Esc'], action: 'Close dialogs', description: 'Back' },
];

export { defaultShortcuts };

function loadShortcuts(): Shortcut[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      let parsed = JSON.parse(stored) as Shortcut[];

      // A stored voice_mode on the old default chord is the untouched default,
      // so move it to the new push-to-talk binding and keep the old chord as the
      // fallback rather than leaving the user on the retired behaviour.
      parsed = parsed.map((s) => {
        if (s.id !== 'voice_mode' || s.altKeys?.length) return s;
        const untouchedDefault =
          s.keys.length === 3 &&
          s.keys.includes('Mod') &&
          s.keys.includes('Shift') &&
          s.keys.includes('M');
        if (!untouchedDefault) return s;
        return { ...s, keys: ['Fn'], altKeys: [['Mod', 'Shift', 'M']] };
      });

      // Migrate old 'Ctrl' shortcuts to 'Mod'
      parsed = parsed
        .filter((s) => s.id !== 'toggle_yolo')
        .map((s) => ({
          ...s,
          keys:
            s.id === 'toggle_zen_mode' &&
            s.keys.length === 3 &&
            s.keys.includes('Mod') &&
            s.keys.includes('Shift') &&
            s.keys.includes('Y')
              ? ['Mod', 'Shift', 'Z']
              : s.keys.map((k) => (k === 'Ctrl' ? 'Mod' : k)),
        }));

      // Merge in missing default shortcuts
      for (const def of defaultShortcuts) {
        if (!parsed.some((s) => s.id === def.id)) {
          parsed.push($state.snapshot(def));
        }
      }

      return parsed;
    }
  } catch (err) {
    // Corrupt or missing shortcuts file — fall back to defaults.
    console.debug('Failed to load saved shortcuts:', err);
  }
  return $state.snapshot(defaultShortcuts);
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
      shortcuts = $state.snapshot(defaultShortcuts);
      localStorage.removeItem(STORAGE_KEY);
    },

    /** Check if a KeyboardEvent matches a given shortcut id or any of its
     *  alternative chords. */
    matches(id: string, e: KeyboardEvent): boolean {
      const shortcut = shortcuts.find((s) => s.id === id);
      if (!shortcut) return false;
      return [shortcut.keys, ...(shortcut.altKeys ?? [])].some((keys) => keysMatch(keys, e));
    },

    /** Every chord bound to an action, primary first. */
    chords(id: string): string[][] {
      const shortcut = shortcuts.find((s) => s.id === id);
      if (!shortcut) return [];
      return [shortcut.keys, ...(shortcut.altKeys ?? [])];
    },

    /** True when the action is bound to a chord with no modifier, which means it
     *  would fight with ordinary typing in a text field. */
    isBare(id: string): boolean {
      const shortcut = shortcuts.find((s) => s.id === id);
      if (!shortcut) return false;
      return [shortcut.keys, ...(shortcut.altKeys ?? [])].some(isBareKeyChord);
    },

    /** Human-readable binding for a shortcut, e.g. "⌘+Shift+M" */
    label(id: string): string {
      const shortcut = shortcuts.find((s) => s.id === id);
      if (!shortcut) return '';
      return shortcut.keys.map(formatKey).join('+');
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
  const nonModKeys = keys.filter((k) => !MODIFIER_KEYS.includes(k));
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
  // fn is reported as 'Fn' by some keyboards and as a key the app never sees at
  // all on macOS, where the system keeps it for dictation. Both are fine: the
  // chord simply does not fire where the platform swallows it.
  if (target.toLowerCase() === 'fn') {
    return eventKey === 'Fn' || eventKey === 'Globe' || eventKey === 'FnLock';
  }

  return eventKey === target.toUpperCase() || eventKey === target;
}

export const shortcutStore = createShortcutStore();
