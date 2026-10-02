import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isMac } from '$lib/utils/platform';

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

describe('shortcut store voice binding', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('binds voice mode to push-to-talk on fn by default', async () => {
    const store = await loadStore();
    const voice = store.list.find((s) => s.id === 'voice_mode');
    expect(voice?.keys).toEqual(['Fn']);
    expect(voice?.action).toBe('Voice mode');
    expect(voice?.description).toMatch(/hold/i);
    expect(store.label('voice_mode')).toBe('fn');
  });

  it('matches the fn hold and the chord fallback, not an unrelated key', async () => {
    const store = await loadStore();
    expect(store.matches('voice_mode', bareKeyEvent('Fn'))).toBe(true);
    // macOS swallows fn for dictation, so the chord that always works is kept.
    expect(store.matches('voice_mode', chordKeyEvent('M', true))).toBe(true);
    expect(store.matches('voice_mode', chordKeyEvent('M', false))).toBe(false);
    expect(store.matches('voice_mode', bareKeyEvent('K'))).toBe(false);
  });

  it('reports the fn binding as bare so it does not swallow typing', async () => {
    const store = await loadStore();
    expect(store.isBare('voice_mode')).toBe(true);
    expect(store.list.find((s) => s.id === 'send')?.keys).not.toEqual(['Fn']);
    expect(store.isBare('send')).toBe(false);
  });

  it('moves an untouched legacy voice binding onto fn and keeps its chord', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { id: 'send', keys: ['Mod', 'Enter'], action: 'Send message' },
        { id: 'voice_mode', keys: ['Mod', 'Shift', 'M'], action: 'Voice mode' },
      ]),
    );
    const store = await loadStore();
    const voice = store.list.find((s) => s.id === 'voice_mode');
    expect(voice?.keys).toEqual(['Fn']);
    expect(voice?.altKeys).toEqual([['Mod', 'Shift', 'M']]);
    expect(store.matches('voice_mode', chordKeyEvent('M', true))).toBe(true);
  });

  it('leaves a binding the user chose alone', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ id: 'voice_mode', keys: ['Mod', 'Alt', 'V'], action: 'Voice mode' }]),
    );
    const store = await loadStore();
    const voice = store.list.find((s) => s.id === 'voice_mode');
    expect(voice?.keys).toEqual(['Mod', 'Alt', 'V']);
    expect(voice?.altKeys).toBeUndefined();
  });

  it('adds the voice binding to saved shortcut sets that predate it', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ id: 'send', keys: ['Mod', 'Enter'], action: 'Send message' }]),
    );
    const store = await loadStore();
    expect(store.list.map((s) => s.id)).toContain('voice_mode');
    expect(store.matches('voice_mode', bareKeyEvent('Fn'))).toBe(true);
  });

  it('keeps a reassigned voice binding and updates its label', async () => {
    const store = await loadStore();
    store.list = store.list.map((s) =>
      s.id === 'voice_mode' ? { ...s, keys: ['Mod', 'Alt', 'V'], altKeys: undefined } : s,
    );
    store.save();
    const reloaded = await loadStore();
    expect(reloaded.matches('voice_mode', bareKeyEvent('Fn'))).toBe(false);
    expect(reloaded.list.find((s) => s.id === 'voice_mode')?.keys).toEqual(['Mod', 'Alt', 'V']);
    expect(reloaded.label('voice_mode')).not.toContain('M');
    expect(reloaded.matches('voice_mode', chordKeyEvent('V', false, true))).toBe(true);
  });

  it('exposes every chord bound to an action', async () => {
    const store = await loadStore();
    expect(store.chords('voice_mode')).toEqual([['Fn'], ['Mod', 'Shift', 'M']]);
  });
});
