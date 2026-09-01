import { describe, expect, test } from 'bun:test';
import { sandboxHome } from '../../collaboration/sandbox-runner';
import { buildDevinProcessEnv, sanitizeDevinOutput, selectDevinResponseEvents } from '../devin';

describe('Devin CLI provider', () => {
  test('keeps the managed Devin home inside a sandbox', () => {
    expect(sandboxHome({ cwd: '/workspace', homeDir: '/managed/devin' })).toBe('/managed/devin');
    expect(sandboxHome({ cwd: '/workspace' })).toBe('/workspace');

    expect(
      buildDevinProcessEnv(
        { PATH: '/usr/bin', HOME: '/real/home' },
        {
          PATH: '/usr/bin',
          HOME: '/temporary/jail',
          XDG_CONFIG_HOME: '/temporary/jail/.config',
          XDG_DATA_HOME: '/temporary/jail/.local/share',
          XDG_CACHE_HOME: '/temporary/jail/.cache',
          XDG_STATE_HOME: '/temporary/jail/.local/state',
        },
        '/managed/devin',
      ),
    ).toMatchObject({
      HOME: '/managed/devin',
      USERPROFILE: '/managed/devin',
      XDG_CONFIG_HOME: '/managed/devin',
      XDG_DATA_HOME: '/managed/devin/.local/share',
      XDG_CACHE_HOME: '/managed/devin/.cache',
      XDG_STATE_HOME: '/managed/devin/.local/state',
      DEVIN_CONFIG_DIR: '/managed/devin',
      NO_COLOR: '1',
      TERM: 'dumb',
    });
  });

  test('removes terminal control sequences and onboarding from print-mode output', () => {
    const output =
      '\u001b[1mWelcome to Devin CLI!\u001b[0m\n' +
      'Logged in as user@example.com.\n\n' +
      '✓ Organization: example\n' +
      "You're all set. Run \u001b[1mdevin\u001b[0m to get started.\n" +
      '\u001b[1mModel response\u001b[0m\u001b[?2004l';

    expect(sanitizeDevinOutput(output).trim()).toBe('Model response');
  });

  test('prefers exported agent messages over CLI stdout messages', () => {
    expect(
      selectDevinResponseEvents('Loading configuration...\nRequest cancelled\n', [
        { type: 'thinking_delta', thinking: 'Reasoning' },
        { type: 'content_delta', content: 'Agent response' },
      ]),
    ).toEqual([
      { type: 'thinking_delta', thinking: 'Reasoning' },
      { type: 'content_delta', content: 'Agent response' },
    ]);
  });

  test('keeps stdout as a fallback when an older export has no agent message', () => {
    expect(selectDevinResponseEvents('Legacy response\n', [])).toEqual([
      { type: 'content_delta', content: 'Legacy response\n' },
    ]);
  });
});
