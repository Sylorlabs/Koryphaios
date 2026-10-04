import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFreebuffTurnRuntime,
  freebuffDockerRunArgs,
  FREEBUFF_RUNTIME_IMAGE,
  getFreebuffRuntimeStatus,
  refreshFreebuffRuntimeStatus,
  validateFreebuffRuntimePaths,
} from '../freebuff-runtime';
import seccompProfile from '../../../../docker/freebuff-runtime/seccomp.json';

const roots: string[] = [];
function fixture(shared = false) {
  const parent = shared ? join(homedir(), '.koryphaios/freebuff-runs') : realpathSync(tmpdir());
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const runRoot = mkdtempSync(join(realpathSync(parent), 'runtime-test-'));
  roots.push(runRoot);
  const options = {
    runRoot,
    runHome: join(runRoot, 'home'),
    workspace: join(runRoot, 'workspace'),
    privateTmp: join(runRoot, 'tmp'),
    allowNetwork: false,
  };
  for (const path of [options.runHome, options.workspace, options.privateTmp])
    mkdirSync(path, { mode: 0o700 });
  return options;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Freebuff runtime security contract', () => {
  test('only one writable host mount, no privileged daemon or environment forwarding', () => {
    const args = freebuffDockerRunArgs('/private/run', 'test');
    expect(args.filter((value) => value === '--mount')).toHaveLength(1);
    expect(args).toContain('type=bind,src=/private/run,dst=/private/run');
    expect(args).toContain('--read-only');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('no-new-privileges');
    expect(args.at(-1)).toBe(FREEBUFF_RUNTIME_IMAGE);
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('seccomp=unconfined');
    expect(args.join(' ')).not.toContain('docker.sock');
    expect(args).not.toContain('--env');
    expect(args).not.toContain('-e');
    expect(args.filter((value) => value.startsWith('--cap-add='))).toEqual([
      '--cap-add=SYS_ADMIN',
      '--cap-add=SETUID',
      '--cap-add=SETGID',
      '--cap-add=DAC_OVERRIDE',
    ]);
    expect(freebuffDockerRunArgs('/private/run', 'test', false)).toContain('none');
  });
  test('keeps default-deny seccomp and permits pivot_root, not arbitrary syscalls', () => {
    expect(seccompProfile.defaultAction).toBe('SCMP_ACT_ERRNO');
    expect(seccompProfile.syscalls.at(-1)?.names).toEqual(['pivot_root']);
    expect(seccompProfile.syscalls.some((rule) => rule.names.includes('keyctl'))).toBe(false);
  });
  test('accepts only existing private canonical subdirectories', () => {
    const options = fixture();
    expect(() => validateFreebuffRuntimePaths(options)).not.toThrow();
    expect(() => validateFreebuffRuntimePaths({ ...options, runRoot: homedir() })).toThrow();
    expect(() =>
      validateFreebuffRuntimePaths({ ...options, workspace: dirnameOutside(options.runRoot) }),
    ).toThrow();
    expect(() =>
      validateFreebuffRuntimePaths({ ...options, workspace: options.runHome }),
    ).toThrow();
    rmSync(options.workspace, { recursive: true });
    symlinkSync(options.runHome, options.workspace);
    expect(() => validateFreebuffRuntimePaths(options)).toThrow(/symlinks/);
  });
  test('cached status is a defensive snapshot, not an optimistic Docker presence check', () => {
    const snapshot = getFreebuffRuntimeStatus();
    snapshot.available = !snapshot.available;
    expect(getFreebuffRuntimeStatus().available).not.toBe(snapshot.available);
  });
});
function dirnameOutside(root: string) {
  return join(root, '..', 'outside');
}

// Explicit opt-in: credential-free kernel, real native binary and real private PTY tests.
// Never reads account credentials and never sends a prompt or logs into Freebuff.
test.skipIf(process.env.KORY_FREEBUFF_RUNTIME_SMOKE !== '1')(
  'real bwrap, private tmux, sanitized environment and credential-free TUI',
  async () => {
    const status = await refreshFreebuffRuntimeStatus(true);
    expect(status).toMatchObject({ available: true, version: '0.2.12' });
    const options = fixture(process.platform === 'darwin');
    const runtime = await createFreebuffTurnRuntime({
      ...options,
      env: { OPENAI_API_KEY: 'must-not-pass', KORY_RUNTIME_HOST_SENTINEL: 'must-not-pass' },
    });
    try {
      expect((await runtime.exec('/bin/sh', ['-ec', 'env'])).includes('must-not-pass')).toBe(false);
      const caps = await runtime.exec('/bin/sh', [
        '-ec',
        'grep -E "^(CapEff|CapPrm|CapInh|CapAmb|NoNewPrivs|Seccomp):" /proc/self/status',
      ]);
      expect(caps).toMatch(/CapEff:\s+0+\n/);
      expect(caps).toMatch(/CapPrm:\s+0+\n/);
      expect(caps).toMatch(/CapInh:\s+0+\n/);
      expect(caps).toMatch(/CapAmb:\s+0+\n/);
      expect(caps).toMatch(/NoNewPrivs:\s+1\n/);
      await runtime.exec('/bin/sh', [
        '-ec',
        'printf allowed > "$1"; ! (printf denied > /usr/denied) 2>/dev/null',
        'probe',
        join(options.workspace, 'allowed'),
      ]);
      expect(readFileSync(join(options.workspace, 'allowed'), 'utf8')).toBe('allowed');
      // Reproduce Colima's stale readdir cache: a new host script appears after
      // a Linux listing. exec must invalidate only the private staging directory.
      await runtime.exec('/bin/ls', ['-a', options.runRoot]);
      const lateScript = join(options.runRoot, 'late-staged.js');
      writeFileSync(lateScript, 'console.log("late-stage-visible")', { mode: 0o600 });
      expect((await runtime.exec(runtime.bunBinary, [lateScript])).trim()).toBe(
        'late-stage-visible',
      );
      // TUI stops at credential-free login; network disabled and no prompt submitted.
      await runtime.start(['--cwd', options.workspace, '--trust-agents']);
      let pane = '';
      for (let attempt = 0; attempt < 40; attempt++) {
        await Bun.sleep(250);
        pane = await runtime.tmux(['capture-pane', '-p', '-J', '-t', runtime.session]);
        if (/log.?in|sign.?in|welcome|freebuff/i.test(pane)) break;
      }
      expect(pane).toMatch(/log.?in|sign.?in|welcome|freebuff/i);
      const socket = (await runtime.tmux(['display-message', '-p', '#{socket_path}'])).trim();
      expect(socket).toContain('kory-');
      expect(
        await runtime.exec('/bin/sh', [
          '-ec',
          'test ! -e "$1"; ! cat "$1" 2>/dev/null; ! (echo denied > "$1") 2>/dev/null; printf socket-hidden',
          'probe',
          socket,
        ]),
      ).toBe('socket-hidden');
      await runtime.cleanup();
      await runtime.cleanup();
      await expect(runtime.tmux(['has-session', '-t', runtime.session])).rejects.toThrow();
    } finally {
      await runtime.cleanup();
    }
  },
  120_000,
);
