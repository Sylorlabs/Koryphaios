import { test, expect, describe } from 'bun:test';
import {
  wrapCommand,
  sandboxCapabilities,
  buildSeatbeltProfile,
  buildSoftJail,
} from '../sandbox-runner';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('sandbox runner (native OS wrap)', () => {
  const caps = sandboxCapabilities();

  test('capability report matches platform', () => {
    expect(caps.platform).toBe(process.platform);
    // OS isolation is available on Linux (bwrap) and macOS (sandbox-exec).
    // Windows and any platform without a sandbox tool report none.
    if (process.platform === 'linux') {
      // bwrap may or may not be installed; either is valid.
      expect(['bubblewrap', 'none']).toContain(caps.mechanism);
    } else if (process.platform === 'darwin') {
      // sandbox-exec ships with macOS at /usr/bin/sandbox-exec.
      expect(['seatbelt', 'none']).toContain(caps.mechanism);
    } else {
      expect(caps.osIsolation).toBe(false);
      expect(caps.mechanism).toBe('none');
    }
    expect(caps.osIsolation).toBe(caps.mechanism !== 'none');
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

  test('isolating policy wraps in the native sandbox or passes through', () => {
    const r = wrapCommand('claude', ['-p', '--model', 'x'], {
      cwd: '/tmp/proj',
      configDirs: ['/tmp/cfg'],
      policy: { ...SANDBOX_PRESETS.balanced },
    });
    if (caps.mechanism === 'bubblewrap') {
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
    } else if (caps.mechanism === 'seatbelt') {
      // sandbox-exec: -p '<profile>' -- bin ...args  (no literal -- separator;
      // the profile string is arg[1] and the bin follows it directly).
      expect(r.command).toContain('sandbox-exec');
      expect(r.isolated).toBe(true);
      expect(r.mechanism).toBe('seatbelt');
      expect(r.args[0]).toBe('-p');
      // The profile confines writes to the project and allows network (balanced).
      const profile = r.args[1] as string;
      expect(profile).toContain('(version 1)');
      expect(profile).toContain('/tmp/proj'); // project writable
      expect(profile).not.toContain('(deny network*)'); // balanced allows net
      // The wrapped program is claude with its args after the profile.
      const binIdx = r.args.indexOf('claude');
      expect(binIdx).toBe(2);
      expect(r.args.slice(binIdx)).toEqual(['claude', '-p', '--model', 'x']);
    } else {
      // No OS sandbox: graceful passthrough (tool-level gating still applies).
      expect(r.command).toBe('claude');
      expect(r.isolated).toBe(false);
    }
  });

  test('mounts account configuration read-only while runtime state remains writable', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-sandbox-mounts-'));
    const writable = join(root, 'runtime');
    const readonly = join(root, 'account');
    const project = join(root, 'project');
    for (const path of [writable, readonly, project]) {
      mkdirSync(path, { recursive: true });
    }

    try {
      const r = wrapCommand('cline', ['--json'], {
        cwd: project,
        configDirs: [writable],
        readonlyConfigDirs: [readonly],
        policy: { ...SANDBOX_PRESETS.balanced },
      });
      if (r.isolated && r.mechanism === 'bubblewrap') {
        const joined = r.args.join(' ');
        expect(joined).toContain(`--bind ${writable} ${writable}`);
        expect(joined).toContain(`--ro-bind ${readonly} ${readonly}`);
        expect(joined).not.toContain(`--bind ${readonly} ${readonly}`);
      } else if (r.isolated && r.mechanism === 'seatbelt') {
        const profile = r.args[1] as string;
        expect(profile).toContain(writable);
        expect(profile).not.toContain(readonly);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('network block cuts network when isolated', () => {
    const r = wrapCommand('claude', [], {
      cwd: '/tmp/p',
      policy: { ...SANDBOX_PRESETS.hardened },
    });
    if (caps.mechanism === 'bubblewrap') {
      expect(r.args).toContain('--unshare-net');
    } else if (caps.mechanism === 'seatbelt') {
      const profile = r.args[1] as string;
      expect(profile).toContain('(deny network*)'); // hardened cuts net
    }
  });

  test('readonly policy mounts the project read-only when OS isolation is available', () => {
    const r = wrapCommand('claude', ['-p'], {
      cwd: '/tmp/p',
      policy: { ...SANDBOX_PRESETS.readonly },
    });
    if (r.isolated && r.mechanism === 'bubblewrap') {
      expect(r.args.join(' ')).toContain('--ro-bind /tmp/p /tmp/p');
      expect(r.args.join(' ')).not.toContain('--bind /tmp/p /tmp/p');
    } else if (r.isolated && r.mechanism === 'seatbelt') {
      // readonly → allowEdits is false → project is NOT in the writable list.
      const profile = r.args[1] as string;
      expect(profile).not.toContain('/tmp/p');
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
      readonlyConfigDirs: ['/Users/me/.cline-account'],
      policy: { ...SANDBOX_PRESETS.balanced },
    });
    expect(balanced).toContain('(version 1)');
    expect(balanced).toContain('(deny file-write*)');
    expect(balanced).toContain('/Users/me/proj'); // project is writable
    expect(balanced).toContain('/Users/me/.claude'); // CLI runtime config writable
    expect(balanced).not.toContain('/Users/me/.cline-account'); // account config not writable
    expect(balanced).not.toContain('(deny network*)'); // balanced allows net

    const hardened = buildSeatbeltProfile({
      cwd: '/Users/me/proj',
      policy: { ...SANDBOX_PRESETS.hardened },
    });
    expect(hardened).toContain('(deny network*)'); // hardened cuts net
    // Secret stores are read-denied.
    expect(hardened).toContain('.ssh');
    expect(hardened).toContain('Keychains');

    const readonly = buildSeatbeltProfile({
      cwd: '/Users/me/proj',
      configDirs: ['/Users/me/.claude'],
      readonlyConfigDirs: ['/Users/me/.cline-account'],
      policy: { ...SANDBOX_PRESETS.readonly },
    });
    expect(readonly).not.toContain('/Users/me/proj');
    expect(readonly).toContain('/Users/me/.claude');
    expect(readonly).not.toContain('/Users/me/.cline-account');
  });
});
