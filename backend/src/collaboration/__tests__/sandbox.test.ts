import { test, expect, describe } from 'bun:test';
import {
  wrapCommand,
  sandboxCapabilities,
  buildSeatbeltProfile,
  buildSoftJail,
} from '../sandbox-runner';
import { existsSync } from 'node:fs';
import { SANDBOX_PRESETS, DEFAULT_SANDBOX_POLICY, tightenSandbox } from '@koryphaios/shared';

describe('sandbox policy', () => {
  test('Balanced default is the least-limiting safe config', () => {
    expect(DEFAULT_SANDBOX_POLICY.preset).toBe('balanced');
    expect(DEFAULT_SANDBOX_POLICY.filesystemIsolation).toBe(true); // jailed
    expect(DEFAULT_SANDBOX_POLICY.allowNetwork).toBe(true); // but network on
    expect(DEFAULT_SANDBOX_POLICY.allowWebSearch).toBe(true);
    expect(DEFAULT_SANDBOX_POLICY.allowShell).toBe(true);
    expect(DEFAULT_SANDBOX_POLICY.allowEdits).toBe(true);
    expect(DEFAULT_SANDBOX_POLICY.commandBlocklist.length).toBeGreaterThan(0);
  });

  test('tightenSandbox can only remove capabilities', () => {
    const t = tightenSandbox(SANDBOX_PRESETS.balanced, { allowShell: false });
    expect(t.allowShell).toBe(false); // tightened
    expect(t.allowNetwork).toBe(true); // untouched
    expect(t.preset).toBe('custom');
    // A tier claiming MORE than the base cannot loosen it.
    const t2 = tightenSandbox(SANDBOX_PRESETS.readonly, { allowShell: true, allowNetwork: true });
    expect(t2.allowShell).toBe(false);
    expect(t2.allowNetwork).toBe(false);
  });

  test('presets ladder from most to least locked', () => {
    expect(SANDBOX_PRESETS.readonly.allowEdits).toBe(false);
    expect(SANDBOX_PRESETS.hardened.allowEdits).toBe(true);
    expect(SANDBOX_PRESETS.hardened.allowNetwork).toBe(false);
    expect(SANDBOX_PRESETS.trusted.filesystemIsolation).toBe(false);
    expect(SANDBOX_PRESETS.trusted.allowShell).toBe(true);
  });
});

describe('sandbox runner (bwrap wrap)', () => {
  const caps = sandboxCapabilities();

  test('capability report matches platform', () => {
    expect(caps.platform).toBe(process.platform);
    if (process.platform !== 'linux') expect(caps.osIsolation).toBe(false);
  });

  test('non-isolating policy passes the command through unchanged', () => {
    const r = wrapCommand('claude', ['-p'], {
      cwd: '/tmp/proj',
      policy: { ...SANDBOX_PRESETS.trusted },
    });
    expect(r.command).toBe('claude');
    expect(r.args).toEqual(['-p']);
    expect(r.isolated).toBe(false);
  });

  test('isolating policy either wraps in bwrap or (no bwrap) passes through', () => {
    const r = wrapCommand('claude', ['-p', '--model', 'x'], {
      cwd: '/tmp/proj',
      configDirs: ['/tmp/cfg'],
      policy: { ...SANDBOX_PRESETS.balanced },
    });
    if (caps.osIsolation) {
      // bwrap available: the real command is jailed.
      expect(r.command).toContain('bwrap');
      expect(r.isolated).toBe(true);
      expect(r.args).toContain('--');
      // The project is bound and set as cwd; network is allowed (no --unshare-net).
      expect(r.args).toContain('--bind');
      expect(r.args).toContain('/tmp/proj');
      expect(r.args).not.toContain('--unshare-net');
      // The wrapped program is still claude with its args after `--`.
      const dash = r.args.indexOf('--');
      expect(r.args.slice(dash + 1)).toEqual(['claude', '-p', '--model', 'x']);
    } else {
      // No OS sandbox: graceful passthrough (tool-level gating still applies).
      expect(r.command).toBe('claude');
      expect(r.isolated).toBe(false);
    }
  });

  test('network block adds --unshare-net when isolated (bwrap)', () => {
    const r = wrapCommand('claude', [], { cwd: '/tmp/p', policy: { ...SANDBOX_PRESETS.hardened } });
    if (caps.mechanism === 'bubblewrap') {
      expect(r.args).toContain('--unshare-net');
    }
  });
});

// Our own cross-platform "soft jail" — works on every platform, incl. Windows.
describe('soft jail (cross-platform)', () => {
  test('scrubs host secrets, keeps CLI config, redirects HOME', () => {
    const base = {
      PATH: '/usr/bin',
      AWS_SECRET_ACCESS_KEY: 'leak-me',
      GITHUB_TOKEN: 'leak-me',
      OPENAI_API_KEY: 'leak-me',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      CLAUDE_CONFIG_DIR: '/home/host/.kory-claude', // must be KEPT
      HOME: '/home/host',
    };
    const jail = buildSoftJail(base, []);
    try {
      // Host secrets are gone from the CLI's environment.
      expect(jail.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(jail.env.GITHUB_TOKEN).toBeUndefined();
      expect(jail.env.OPENAI_API_KEY).toBeUndefined();
      expect(jail.env.SSH_AUTH_SOCK).toBeUndefined();
      // The CLI's own config var survives (allowlisted).
      expect(jail.env.CLAUDE_CONFIG_DIR).toBe('/home/host/.kory-claude');
      // HOME/USERPROFILE point away from the host's real home.
      expect(jail.env.HOME).not.toBe('/home/host');
      expect(jail.env.USERPROFILE).toBe(jail.env.HOME);
      expect(existsSync(jail.env.HOME!)).toBe(true); // the fake home exists
      expect(jail.env.TMPDIR).toContain(jail.env.HOME!);
    } finally {
      jail.cleanup();
    }
    // Cleanup removes the fake home.
    expect(existsSync(jail.env.HOME!)).toBe(false);
  });
});

// The macOS Seatbelt profile is platform-independent to generate, so verify its
// structure here even when running the suite on Linux.
describe('macOS Seatbelt profile', () => {
  test('confines writes to the project + denies network when blocked', () => {
    const balanced = buildSeatbeltProfile({
      cwd: '/Users/me/proj',
      configDirs: ['/Users/me/.claude'],
      policy: { ...SANDBOX_PRESETS.balanced },
    });
    expect(balanced).toContain('(version 1)');
    expect(balanced).toContain('(deny file-write*)');
    expect(balanced).toContain('/Users/me/proj'); // project is writable
    expect(balanced).toContain('/Users/me/.claude'); // CLI config writable
    expect(balanced).not.toContain('(deny network*)'); // balanced allows net

    const hardened = buildSeatbeltProfile({
      cwd: '/Users/me/proj',
      policy: { ...SANDBOX_PRESETS.hardened },
    });
    expect(hardened).toContain('(deny network*)'); // hardened cuts net
    // Secret stores are read-denied.
    expect(hardened).toContain('.ssh');
    expect(hardened).toContain('Keychains');
  });
});
