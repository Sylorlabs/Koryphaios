import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatKey, isMac } from '$lib/utils/platform';
import { apiFetch } from '$lib/api.svelte';

// Reload the real shortcut store without importing the API's application-store
// graph or making auth/network requests when a binding is saved.
vi.mock('$lib/api.svelte', () => ({ apiFetch: vi.fn(async () => new Response('{}')) }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));

const STORAGE_KEY = 'koryphaios-shortcuts';

async function loadStore() {
  vi.resetModules();
  return (await import('./shortcuts.svelte')).shortcutStore;
}

function chordKeyEvent(key: string, shiftKey = false, altKey = false) {
  return new KeyboardEvent('keydown', {
    key,
    shiftKey,
    altKey,
    ctrlKey: !isMac(),
    metaKey: isMac(),
  });
}

function bareKeyEvent(key: string) {
  return new KeyboardEvent('keydown', { key });
}

function controlSpaceEvent() {
  return new KeyboardEvent('keydown', { key: ' ', ctrlKey: true });
}

describe('shortcut store voice binding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('binds voice mode to Control+Space push-to-talk by default', async () => {
    const store = await loadStore();
    const voice = store.list.find((s) => s.id === 'voice_mode');
    expect(voice?.keys).toEqual(['Ctrl', ' ']);
    expect(voice?.action).toBe('Voice mode');
    expect(voice?.description).toMatch(/hold to talk, release to transcribe/i);
    expect(store.label('voice_mode')).toBe(`${formatKey('Ctrl')}+${formatKey(' ')}`);
  });

  it('keeps the voice Control across a reload instead of retargeting it to Mod', async () => {
    const store = await loadStore();
    // What save() writes: the in-memory bindings, Control included.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store.list));
    const reloaded = await loadStore();
    expect(reloaded.keys('voice_mode')).toEqual(['Ctrl', ' ']);
    expect(reloaded.matches('voice_mode', controlSpaceEvent())).toBe(true);
  });

  it('repairs a voice binding an older build retargeted to Mod+Space', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: 'voice_mode',
          keys: ['Mod', ' '],
          action: 'Voice mode',
          description: 'Press to record, press again to transcribe',
        },
      ]),
    );
    const store = await loadStore();
    expect(store.keys('voice_mode')).toEqual(['Ctrl', ' ']);
    expect(store.matches('voice_mode', controlSpaceEvent())).toBe(true);
  });

  it('keeps a voice binding the user selected themselves', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: 'voice_mode',
          keys: ['Mod', 'Alt', 'V'],
          action: 'Voice mode',
          description: 'Press to record, press again to transcribe',
        },
      ]),
    );
    const store = await loadStore();
    expect(store.keys('voice_mode')).toEqual(['Mod', 'Alt', 'V']);
  });

  it('keeps an fn binding the user selected themselves', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: 'voice_mode',
          keys: ['Fn'],
          action: 'Voice mode',
          description: 'Press to record, press again to transcribe',
        },
      ]),
    );
    const store = await loadStore();
    expect(store.keys('voice_mode')).toEqual(['Fn']);
  });

  it('matches Control+Space and has no legacy fallback', async () => {
    const store = await loadStore();
    expect(store.matches('voice_mode', controlSpaceEvent())).toBe(true);
    expect(store.matches('voice_mode', chordKeyEvent('M', true))).toBe(false);
    expect(store.matches('voice_mode', bareKeyEvent('K'))).toBe(false);
    expect(store.matchesVoiceFallback(chordKeyEvent('M', true))).toBe(false);
    expect(store.voiceFallbackKeys()).toEqual([]);
  });

  it('reports the Control+Space binding as non-bare', async () => {
    const store = await loadStore();
    expect(store.isBare('voice_mode')).toBe(false);
    expect(store.list.find((s) => s.id === 'send')?.keys).not.toEqual(['Ctrl', ' ']);
    expect(store.isBare('send')).toBe(false);
  });

  it('moves an untouched legacy voice binding onto Control+Space', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { id: 'send', keys: ['Mod', 'Enter'], action: 'Send message' },
        { id: 'voice_mode', keys: ['Mod', 'Shift', 'M'], action: 'Voice mode' },
      ]),
    );
    const store = await loadStore();
    const voice = store.list.find((s) => s.id === 'voice_mode');
    expect(voice?.keys).toEqual(['Ctrl', ' ']);
    expect(store.matches('voice_mode', chordKeyEvent('M', true))).toBe(false);
  });

  it('drops the retired fallback chord from a stored fn binding', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: 'voice_mode',
          keys: ['Fn'],
          altKeys: [['Mod', 'Shift', 'M']],
          action: 'Voice mode',
        },
      ]),
    );
    const store = await loadStore();
    const voice = store.list.find((s) => s.id === 'voice_mode');
    expect(voice?.keys).toEqual(['Ctrl', ' ']);
    expect(voice).not.toHaveProperty('altKeys');
    expect(store.matches('voice_mode', chordKeyEvent('M', true))).toBe(false);
  });

  it('leaves a binding the user chose alone', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ id: 'voice_mode', keys: ['Mod', 'Alt', 'V'], action: 'Voice mode' }]),
    );
    const store = await loadStore();
    const voice = store.list.find((s) => s.id === 'voice_mode');
    expect(voice?.keys).toEqual(['Mod', 'Alt', 'V']);
  });

  it('adds the voice binding to saved shortcut sets that predate it', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ id: 'send', keys: ['Mod', 'Enter'], action: 'Send message' }]),
    );
    const store = await loadStore();
    expect(store.list.map((s) => s.id)).toContain('voice_mode');
    expect(store.matches('voice_mode', controlSpaceEvent())).toBe(true);
  });

  it('keeps a reassigned voice binding and updates its label', async () => {
    const store = await loadStore();
    store.list = store.list.map((s) =>
      s.id === 'voice_mode' ? { ...s, keys: ['Mod', 'Alt', 'V'] } : s,
    );
    store.save();
    expect(apiFetch).toHaveBeenCalledExactlyOnceWith('/api/desktop-ui/shortcuts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(store.list),
    });
    const reloaded = await loadStore();
    expect(reloaded.matches('voice_mode', controlSpaceEvent())).toBe(false);
    expect(reloaded.list.find((s) => s.id === 'voice_mode')?.keys).toEqual(['Mod', 'Alt', 'V']);
    expect(reloaded.label('voice_mode')).not.toContain('M');
    expect(reloaded.matches('voice_mode', chordKeyEvent('V', false, true))).toBe(true);
  });

  it('exposes the keys bound to an action', async () => {
    const store = await loadStore();
    expect(store.keys('voice_mode')).toEqual(['Ctrl', ' ']);
    expect(store.keys('not_a_shortcut')).toEqual([]);
  });

  it.each(['mac', 'windows', 'linux'] as const)('matches Control+Space on %s', async (platform) => {
    const store = await loadStore();
    const { setPlatformForTesting } = await import('$lib/utils/platform');
    setPlatformForTesting(platform);
    try {
      expect(store.matches('voice_mode', new KeyboardEvent('keydown', {
        key: ' ', ctrlKey: true,
      }))).toBe(true);
      expect(store.matches('voice_mode', new KeyboardEvent('keydown', {
        key: ' ', ctrlKey: false, metaKey: true,
      }))).toBe(false);
    } finally {
      setPlatformForTesting(null);
    }
  });

  it('re-describes a stored voice binding as push-to-talk', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: 'voice_mode',
          keys: ['Fn'],
          action: 'Voice mode',
          description: 'Press to record, press again to transcribe',
        },
      ]),
    );
    const store = await loadStore();
    const voice = store.list.find((s) => s.id === 'voice_mode');
    expect(voice?.keys).toEqual(['Fn']);
    expect(voice?.description).toMatch(/hold to talk, release to transcribe/i);
  });
});

describe('voice conductor binding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('defaults to Mod+Shift+Space, distinct from dictation', async () => {
    const store = await loadStore();
    expect(store.keys('voice_conductor')).toEqual(['Mod', 'Shift', ' ']);
    expect(store.matches('voice_conductor', chordKeyEvent(' ', true))).toBe(true);
    expect(store.matches('voice_conductor', controlSpaceEvent())).toBe(false);
    expect(store.matches('voice_mode', chordKeyEvent(' ', true))).toBe(false);
  });

  it('is merged into an older stored list', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ id: 'send', keys: ['Mod', 'Enter'], action: 'Send', description: 'x' }]),
    );
    const store = await loadStore();
    expect(store.keys('voice_conductor')).toEqual(['Mod', 'Shift', ' ']);
  });

  it('keeps a rebound conductor chord when the server copy, which does not know it, is applied', async () => {
    const store = await loadStore();
    store.list = store.list.map((s) => (s.id === 'voice_conductor' ? { ...s, keys: ['Mod', 'Alt', 'J'] } : s));
    store.applyRemote([
      { id: 'send', keys: ['Mod', 'Enter'], action: 'Send message', description: 'Submit task' },
    ]);
    expect(store.keys('voice_conductor')).toEqual(['Mod', 'Alt', 'J']);
    expect(store.keys('send')).toEqual(['Mod', 'Enter']);
    // Defaults the server omitted are restored rather than dropped.
    expect(store.keys('toggle_thinking')).toEqual(['Mod', 'T']);
  });
});
