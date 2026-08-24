import { describe, expect, test } from 'bun:test';
import { sandboxHome } from '../../collaboration/sandbox-runner';
import { buildDevinProcessEnv, sanitizeDevinOutput } from '../devin';

describe('Devin CLI provider', () => {
  test('keeps the managed Devin home inside a sandbox', () => {
    expect(sandboxHome({ cwd: '/workspace', homeDir: '/managed/devin' })).toBe('/managed/devin');
    expect(sandboxHome({ cwd: '/workspace' })).toBe('/workspace');

    expect(
      buildDevinProcessEnv(
        { PATH: '/usr/bin', HOME: '/real/home' },
        { PATH: '/usr/bin', HOME: '/temporary/jail' },
        '/managed/devin',
      ),
    ).toMatchObject({
      HOME: '/managed/devin',
      USERPROFILE: '/managed/devin',
      XDG_CONFIG_HOME: '/managed/devin',
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
});
