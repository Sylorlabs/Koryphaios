import { describe, expect, it } from 'bun:test';
import {
  BANNED_NAME_REASON,
  bannedNameIn,
  bannedNameRefusal,
  screenToolCall,
} from './banned-names';

describe('banned-name bouncer', () => {
  it('matches the name however it is spelled or separated', () => {
    for (const label of [
      'Native Settings',
      'native-settings',
      'Native_Settings.app',
      'native settings helper',
      '/tmp/Native.Settings/bin',
      'com.kory.native-settings',
    ]) {
      expect(bannedNameIn(label)).toBe('Native Settings');
    }
  });

  it('leaves unrelated names alone', () => {
    for (const label of ['Settings', 'Preferences', 'native-controls', 'Koryphaios.app']) {
      expect(bannedNameRefusal(label)).toBeNull();
    }
  });

  it('refuses a write, a shell command, a move and a window title before they run', () => {
    const calls = [
      { name: 'write_file', input: { path: '/Users/me/Desktop/Native Settings/index.html' } },
      {
        name: 'write_file',
        input: { path: 'notes.md', content: '<title>Native Settings</title>' },
      },
      { name: 'bash', input: { command: 'open "/tmp/Native Settings.app"' } },
      { name: 'move_file', input: { from: 'a', to: 'Native-Settings' } },
      { name: 'computer_place_window', input: { window: 'Native Settings' } },
      {
        name: 'edit_file',
        input: { path: 'main.ts', old: 'x', new: 'y', title: 'native settings' },
      },
    ];
    for (const call of calls) {
      expect(screenToolCall(call)).toEqual({ reason: BANNED_NAME_REASON });
    }
  });

  it('lets a read through, because the repository legitimately holds the token', () => {
    expect(
      screenToolCall({
        name: 'read_file',
        input: { path: 'frontend/src/lib/components/native-settings-controls.test.ts' },
      }),
    ).toBeNull();
    expect(screenToolCall({ name: 'grep', input: { pattern: 'native-settings' } })).toBeNull();
  });

  it('allows an ordinary tool call', () => {
    expect(
      screenToolCall({ name: 'write_file', input: { path: 'src/app.ts', content: 'export {}' } }),
    ).toBeNull();
  });
});
