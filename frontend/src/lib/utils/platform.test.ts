import { afterEach, describe, expect, it } from 'vitest';
import {
  formatChord,
  formatKey,
  formatShortcut,
  getModKeyName,
  isLinux,
  isMac,
  isWindows,
  setPlatformForTesting,
  type Platform,
} from './platform';

function on(platform: Platform | null): void {
  setPlatformForTesting(platform);
}

afterEach(() => on(null));

describe('platform detection', () => {
  it('resolves each host to exactly one branch', () => {
    on('mac');
    expect([isMac(), isWindows(), isLinux()]).toEqual([true, false, false]);
    on('windows');
    expect([isMac(), isWindows(), isLinux()]).toEqual([false, true, false]);
    on('linux');
    expect([isMac(), isWindows(), isLinux()]).toEqual([false, false, true]);
  });

  it('caches the detected platform until a test overrides it', () => {
    setPlatformForTesting(null);
    const first = isMac();
    // Sniffing is stable within a session; the cache is what makes template
    // calls cheap and keeps every label on one platform.
    expect(isMac()).toBe(first);
  });
});

describe('mod key labelling', () => {
  it('spells the primary modifier for the host', () => {
    on('mac');
    expect(getModKeyName()).toBe('⌘');
    on('windows');
    expect(getModKeyName()).toBe('Ctrl');
    on('linux');
    expect(getModKeyName()).toBe('Ctrl');
  });

  it('never labels the macOS-only command key on Windows or Linux', () => {
    for (const platform of ['windows', 'linux'] as const) {
      on(platform);
      expect(formatKey('Mod')).toBe('Ctrl');
      expect(formatShortcut('Mod+Shift+V')).toBe('Ctrl+Shift+V');
    }
  });

  it('never labels Ctrl on macOS', () => {
    on('mac');
    expect(formatKey('Mod')).toBe('⌘');
    expect(formatShortcut('Mod+Shift+V')).toBe('⌘+⇧+V');
  });

  it('distinguishes the bare Ctrl key from the primary modifier on macOS', () => {
    on('mac');
    expect(formatKey('Ctrl')).toBe('⌃');
    on('windows');
    expect(formatKey('Ctrl')).toBe('Ctrl');
  });

  it('names the Super key per desktop convention', () => {
    on('mac');
    expect(formatKey('Meta')).toBe('⌘');
    on('windows');
    expect(formatKey('Meta')).toBe('Win');
    on('linux');
    expect(formatKey('Meta')).toBe('Super');
  });
});

describe('navigation and editing key labels', () => {
  it('uses macOS glyphs on macOS and words elsewhere', () => {
    on('mac');
    expect(formatShortcut('Mod+Enter')).toBe('⌘+↵');
    expect(formatShortcut('Esc')).toBe('esc');
    expect(formatChord('ArrowUp', 'ArrowDown')).toBe('↑+↓');
    on('linux');
    expect(formatShortcut('Mod+Enter')).toBe('Ctrl+Enter');
    expect(formatShortcut('Esc')).toBe('Esc');
    expect(formatChord('ArrowUp', 'ArrowDown')).toBe('Up+Down');
  });

  it('spells the forward delete key the way the key cap does', () => {
    on('mac');
    expect(formatKey('Delete')).toBe('⌦');
    expect(formatKey('Backspace')).toBe('⌫');
    on('windows');
    expect(formatKey('Delete')).toBe('Del');
    expect(formatKey('Backspace')).toBe('Backspace');
  });

  it('keeps fn lower case on every platform', () => {
    for (const platform of ['mac', 'windows', 'linux'] as const) {
      on(platform);
      expect(formatKey('Fn')).toBe('fn');
      expect(formatKey('fn')).toBe('fn');
    }
  });

  it('passes through key tokens it has no spelling for', () => {
    on('mac');
    expect(formatKey('Escape')).toBe('esc');
    expect(formatKey('F5')).toBe('F5');
    expect(formatKey(',')).toBe(',');
  });
});
