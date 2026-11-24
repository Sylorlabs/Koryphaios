// Voice conductor preferences. They are per-device conveniences (which word
// wakes the conductor on this machine), so they live in localStorage the same
// way the custom transcription vocabulary does. The conductor shortcut itself
// is a normal binding in shortcutStore (`voice_conductor`).

import { DEFAULT_WAKE_PHRASE } from './grammar';

export interface ConductorSettings {
  /** Master switch: off means the shortcut and the wake phrase both do nothing. */
  enabled: boolean;
  /** Route dictation that starts with the wake phrase to the conductor. */
  wakePhraseEnabled: boolean;
  wakePhrase: string;
}

export const CONDUCTOR_SETTINGS_KEY = 'koryphaios.voice-conductor';

export const DEFAULT_CONDUCTOR_SETTINGS: ConductorSettings = {
  enabled: true,
  wakePhraseEnabled: true,
  wakePhrase: DEFAULT_WAKE_PHRASE,
};

export function sanitizeConductorSettings(raw: unknown): ConductorSettings {
  const source = raw && typeof raw === 'object' ? (raw as Partial<ConductorSettings>) : {};
  const phrase =
    typeof source.wakePhrase === 'string' ? source.wakePhrase.replace(/\s+/g, ' ').trim() : '';
  return {
    enabled:
      typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_CONDUCTOR_SETTINGS.enabled,
    wakePhraseEnabled:
      typeof source.wakePhraseEnabled === 'boolean'
        ? source.wakePhraseEnabled
        : DEFAULT_CONDUCTOR_SETTINGS.wakePhraseEnabled,
    wakePhrase: phrase.slice(0, 40) || DEFAULT_CONDUCTOR_SETTINGS.wakePhrase,
  };
}

function load(): ConductorSettings {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_CONDUCTOR_SETTINGS };
    const stored = localStorage.getItem(CONDUCTOR_SETTINGS_KEY);
    return sanitizeConductorSettings(stored ? JSON.parse(stored) : null);
  } catch {
    return { ...DEFAULT_CONDUCTOR_SETTINGS };
  }
}

let settings = $state<ConductorSettings>(load());

export const conductorSettings = {
  get current(): ConductorSettings {
    return settings;
  },
  update(patch: Partial<ConductorSettings>) {
    settings = sanitizeConductorSettings({ ...settings, ...patch });
    try {
      localStorage.setItem(CONDUCTOR_SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Private mode blocks storage; the change still applies to this session.
    }
  },
  /** Re-read storage (tests, or another window changed it). */
  reload() {
    settings = load();
  },
};
