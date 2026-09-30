import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BashTool } from './bash';
import { defaultAllowedRoots, osSandboxAvailable, spawnSandboxed } from '../security/os-sandbox';

const cleanupPaths: string[] = [];

function temporaryPath(label: string): string {
  const path = join(
    tmpdir(),
    `${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  cleanupPaths.push(path);
  return path;
}

async function kernelSandboxOperational(): Promise<boolean> {
  if (!osSandboxAvailable()) return false;
  const root = temporaryPath('kory-sandbox-probe');
  mkdirSync(root, { recursive: true });
  // /bin/echo, not /bin/true: macOS has no /bin/true, and a missing binary
  // would make the probe report a broken sandbox when confinement is fine.
  const probeBinary = existsSync('/bin/echo') ? '/bin/echo' : '/usr/bin/echo';
  try {
    const { proc, cleanup } = spawnSandboxed([probeBinary, 'probe'], {
      allowedRoots: [root],
      cwd: root,
      blockNetwork: true,
      blockSubprocesses: false,
    });
    const exitCode = await new Promise<number>((resolve) => {
      proc.once('exit', (code) => resolve(code ?? 1));
      proc.once('error', () => resolve(1));
    });
    cleanup();
    return exitCode === 0;
  } catch {
    return false;
  }
}

const KERNEL_SANDBOX_OPERATIONAL = await kernelSandboxOperational();

async function runSandboxed(root: string, command: string, isBackground = false) {
  const callId = `sandbox-boundary-${Date.now()}-${Math.random()}`;
  return new BashTool().run(
    {
      sessionId: callId,
      workingDirectory: root,
      isSandboxed: true,
    },
    {
      id: callId,
      name: 'bash',
      input: { command, isBackground },
    },
  );
}

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
});

describe('Bash kernel sandbox boundary', () => {
  test('explicitly unsandboxed foreground work still strips backend secrets', async () => {
    const root = temporaryPath('kory-unsandboxed-env-root');
    mkdirSync(root, { recursive: true });
    const previous = process.env.KORY_AGENT_ENV_SECRET;
    process.env.KORY_AGENT_ENV_SECRET = 'foreground-secret-must-not-leak';
    const callId = `unsandboxed-env-${Date.now()}`;
    try {
      const result = await new BashTool().run(
        {
          sessionId: callId,
          workingDirectory: root,
          isSandboxed: false,
          approvedToolCallIds: new Set([callId]),
        },
        { id: callId, name: 'bash', input: { command: 'env' } },
      );
      expect(result.isError).toBe(false);
      expect(result.output).not.toContain('foreground-secret-must-not-leak');
      expect(result.output).not.toContain('DATABASE_URL=');
      expect(result.output).toContain('PATH=');
    } finally {
      if (previous === undefined) delete process.env.KORY_AGENT_ENV_SECRET;
      else process.env.KORY_AGENT_ENV_SECRET = previous;
    }
  });

  test('fails closed instead of executing an absolute /tmp operand when enforcement is off', async () => {
    const root = temporaryPath('kory-sandbox-root');
    const outside = temporaryPath('kory-sandbox-outside');
    mkdirSync(root, { recursive: true });
    // Confinement is requested by policy, not an env opt-in, so "enforcement
    // is off" is now expressed by the KORYPHAIOS_OS_SANDBOX=0 kill switch.
    const previous = process.env.KORYPHAIOS_OS_SANDBOX;
    process.env.KORYPHAIOS_OS_SANDBOX = '0';
    try {
      const result = await runSandboxed(root, `touch ${outside}`);
      expect(result.isError).toBe(true);
      expect(result.output).toContain('kernel path confinement is unavailable');
      expect(existsSync(outside)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.KORYPHAIOS_OS_SANDBOX;
      else process.env.KORYPHAIOS_OS_SANDBOX = previous;
    }
  });

  test('rejects sandboxed background work instead of bypassing the sandbox and limits', async () => {
    const root = temporaryPath('kory-sandbox-background-root');
    const outside = temporaryPath('kory-sandbox-background-outside');
    mkdirSync(root, { recursive: true });
    const result = await runSandboxed(root, `touch ${outside}`, true);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Sandboxed background processes are unavailable');
    expect(existsSync(outside)).toBe(false);
  });

  test.skipIf(!KERNEL_SANDBOX_OPERATIONAL)(
    'an enabled kernel sandbox writes inside the grant, not host /tmp, and strips secrets',
    async () => {
      const root = temporaryPath('kory-sandbox-enforced-root');
      const outside = temporaryPath('kory-sandbox-enforced-outside');
      mkdirSync(root, { recursive: true });
      const previousEnabled = process.env.KORYPHAIOS_OS_SANDBOX;
      const previousSecret = process.env.KORY_SANDBOX_TEST_SECRET;
      delete process.env.KORYPHAIOS_OS_SANDBOX;
      process.env.KORY_SANDBOX_TEST_SECRET = 'must-not-cross-the-boundary';
      try {
        const inside = await runSandboxed(root, 'touch inside.txt');
        expect(inside.isError).toBe(false);
        expect(existsSync(join(root, 'inside.txt'))).toBe(true);

        const escape = await runSandboxed(root, `touch ${outside}`);
        // On Linux (bwrap), the touch command succeeds (exit 0) because the
        // file is created in a private mount namespace that is invisible on the
        // host. On macOS (sandbox-exec), the sandbox profile denies the write
        // and touch exits non-zero. In both cases the file must not exist on
        // the host filesystem.
        expect(existsSync(outside)).toBe(false);

        const environment = await runSandboxed(root, 'env');
        expect(environment.isError).toBe(false);
        expect(environment.output).not.toContain('must-not-cross-the-boundary');
        expect(environment.output).not.toContain('DATABASE_URL=');
      } finally {
        if (previousEnabled === undefined) delete process.env.KORYPHAIOS_OS_SANDBOX;
        else process.env.KORYPHAIOS_OS_SANDBOX = previousEnabled;
        if (previousSecret === undefined) delete process.env.KORY_SANDBOX_TEST_SECRET;
        else process.env.KORY_SANDBOX_TEST_SECRET = previousSecret;
      }
    },
  );

  test('global Koryphaios state is not an implicit Bash filesystem grant', () => {
    const root = temporaryPath('kory-sandbox-grant-root');
    mkdirSync(root, { recursive: true });
    // defaultAllowedRoots canonicalizes through realpathSync. On macOS,
    // tmpdir() may be under a symlinked root (e.g. /var → /private/var),
    // so compare against the canonical form.
    expect(defaultAllowedRoots(root)).toEqual([realpathSync(root)]);
  });

  test.skipIf(!KERNEL_SANDBOX_OPERATIONAL)(
    'a confined agent cannot read host credential stores',
    async () => {
      // macOS needs a system-wide read allow to complete dynamic linking, so the
      // boundary is enforced with explicit deny rules instead. These are the
      // paths a prompt-injected agent would target for exfiltration.
      const home = homedir();
      const sshDir = join(home, '.ssh');
      const created: string[] = [];
      try {
        if (!existsSync(sshDir)) mkdirSync(sshDir, { recursive: true });
        const probe = join(sshDir, 'koryphaios-sandbox-probe');
        writeFileSync(probe, 'PRIVATE-KEY-MATERIAL');
        created.push(probe);

        const root = temporaryPath('kory-sandbox-cred-root');
        mkdirSync(root, { recursive: true });
        const result = await runSandboxed(root, `cat ${probe}`);
        expect(result.isError).toBe(true);
        expect(result.output).not.toContain('PRIVATE-KEY-MATERIAL');
      } finally {
        for (const path of created) rmSync(path, { force: true });
      }
    },
  );

  test.skipIf(!KERNEL_SANDBOX_OPERATIONAL)(
    'toolchain configuration stays readable inside a confined agent',
    async () => {
      // The credential denies must not break the config agents legitimately
      // need to build and test a project.
      const root = temporaryPath('kory-sandbox-config-root');
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'toolchain.conf'), 'readable-by-agents\n');
      const result = await runSandboxed(root, 'cat toolchain.conf');
      expect(result.isError).toBe(false);
      expect(result.output).toContain('readable-by-agents');
    },
  );
});
