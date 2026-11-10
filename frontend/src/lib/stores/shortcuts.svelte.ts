// Keyboard shortcuts — editable, persisted to localStorage, Svelte 5 runes

import { isMac, formatKey } from '$lib/utils/platform';
import { browser } from '$app/environment';
import { apiFetch } from '$lib/api.svelte';
import { apiUrl } from '$lib/utils/api-url';
import type { DesktopShortcut } from '@koryphaios/shared';

export interface Shortcut extends DesktopShortcut {}

/** Modifiers a chord is built from. Everything else is a target key, including
 *  fn, which is a target even though the platform may also report it as a
 *  hardware modifier. */
const MODIFIER_KEYS = ['Ctrl', 'Shift', 'Alt', 'Meta', 'Mod'];

/** True when a chord has no modifier, so it would collide with plain typing. */
export function isBareKeyChord(keys: string[]): boolean {
  return !keys.some((key) => key === 'Mod' || key === 'Ctrl' || key === 'Meta' || key === 'Alt');
}

const STORAGE_KEY = 'koryphaios-shortcuts';

const VOICE_DESCRIPTION = 'Press to record, press again to transcribe';

/** Voice mode keeps a literal Control on every platform: `Mod` would mean
 *  Command on macOS, and Command+Space is Spotlight, so the chord would never
 *  reach the composer. The stored 'Ctrl' → 'Mod' migration must skip it. */
const VOICE_DEFAULT_KEYS = ['Ctrl', ' '];

function isVoiceDefaultCandidate(keys: string[], description?: string): boolean {
  const tokens = Array.isArray(keys) ? keys : [];
  const lowered = tokens.map((key) => key.toLowerCase());
  const onLegacyChord =
    tokens.length === 3 &&
    lowered.includes('mod') &&
    lowered.includes('shift') &&
    lowered.includes('m');
  // A stored bare fn is the old default when it is not already described as a
  // toggle: that wording is what a release shipped, so an fn the user picked
  // themselves stays theirs.
  const onLegacyFn =
    tokens.length === 1 && lowered[0] === 'fn' && !/press to record/i.test(description ?? '');
  // Mod+Space is what an older build produced when it rewrote every stored
  // 'Ctrl' to 'Mod'. Nothing records that chord on its own, so it is damage
  // from that rewrite rather than a binding anyone picked.
  const onRetargetedMod = tokens.length === 2 && lowered[0] === 'mod' && lowered[1] === ' ';
  return onLegacyChord || onLegacyFn || onRetargetedMod;
}

function voiceDefaultKeys(): string[] {
  return [...VOICE_DEFAULT_KEYS];
}

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
    keys: VOICE_DEFAULT_KEYS,
    action: 'Voice mode',
    description: VOICE_DESCRIPTION,
  },
  { id: 'close', keys: ['Esc'], action: 'Close dialogs', description: 'Back' },
];

export { defaultShortcuts };

function loadShortcuts(): Shortcut[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      // A stored binding may still carry the retired altKeys field, so the
      // persisted shape is wider than the live Shortcut type.
      let parsed = JSON.parse(stored) as (Shortcut & { altKeys?: string[][] })[];

      // Preserve chosen bindings, retire the old altKeys shape, and update
      // the description now that voice mode is press-to-toggle.
      parsed = parsed.map((s) => {
        if (s.id !== 'voice_mode') return s;
        const { altKeys: _retired, ...rest } = s;
        return {
          ...rest,
          keys: isVoiceDefaultCandidate(s.keys, s.description) ? voiceDefaultKeys() : s.keys,
          description: VOICE_DESCRIPTION,
        };
      });

      // Migrate old 'Ctrl' shortcuts to 'Mod'
      parsed = parsed
        .filter((s) => s.id !== 'toggle_yolo')
        .map((s) => {
          // Voice mode is exempt: its Control is deliberate on every platform,
          // because 'Mod' means Command on macOS and Command+Space belongs to
          // Spotlight, so the binding would never reach the composer.
          if (s.id === 'voice_mode') return s;
          return {
            ...s,
            keys:
              s.id === 'toggle_zen_mode' &&
              s.keys.length === 3 &&
              s.keys.includes('Mod') &&
              s.keys.includes('Shift') &&
              s.keys.includes('Y')
                ? ['Mod', 'Shift', 'Z']
                : s.keys.map((k) => (k === 'Ctrl' ? 'Mod' : k)),
          };
        });

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

  function persistLocal() {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shortcuts));
  }

  async function persistToBackend() {
    if (!browser) return;
    try {
      await apiFetch(apiUrl('/api/desktop-ui/shortcuts'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(shortcuts),
      });
    } catch {}
  }

  function applyRemote(next: DesktopShortcut[]) {
    shortcuts = next.map((shortcut) => {
      const keys = [...shortcut.keys];
      if (shortcut.id !== 'voice_mode') return { ...shortcut, keys };
      return {
        ...shortcut,
        keys: isVoiceDefaultCandidate(keys, shortcut.description) ? voiceDefaultKeys() : keys,
        description: VOICE_DESCRIPTION,
      };
    });
    persistLocal();
  }

  return {
    get list() {
      return shortcuts;
    },
    set list(v: Shortcut[]) {
      shortcuts = v;
    },

    save() {
      persistLocal();
      if (browser) void persistToBackend();
    },

    reset() {
      shortcuts = $state.snapshot(defaultShortcuts);
      localStorage.removeItem(STORAGE_KEY);
    },
    applyRemote,

    /** The keys bound to an action, or [] when it has no binding. */
    keys(id: string): string[] {
      return shortcuts.find((s) => s.id === id)?.keys ?? [];
    },

    voiceFallbackKeys(): string[] {
      return [];
    },

    matchesVoiceFallback(e: KeyboardEvent): boolean {
      return keysMatch(this.voiceFallbackKeys(), e);
    },

    /** Check if a KeyboardEvent matches a given shortcut id. */
    matches(id: string, e: KeyboardEvent): boolean {
      const shortcut = shortcuts.find((s) => s.id === id);
      if (!shortcut) return false;
      return keysMatch(shortcut.keys, e);
    },

    /** True when the action is bound to a chord with no modifier, which means it
     *  would fight with ordinary typing in a text field. */
    isBare(id: string): boolean {
      const shortcut = shortcuts.find((s) => s.id === id);
      if (!shortcut) return false;
      return isBareKeyChord(shortcut.keys);
    },

    /** Human-readable binding for a shortcut, e.g. "⌘+Shift+K" */
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
