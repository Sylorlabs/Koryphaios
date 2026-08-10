import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BashTool } from './bash';
import { defaultAllowedRoots, osSandboxAvailable } from '../security/os-sandbox';

const cleanupPaths: string[] = [];

function temporaryPath(label: string): string {
  const path = join(
    tmpdir(),
    `${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  cleanupPaths.push(path);
  return path;
}

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
    const previous = process.env.KORYPHAIOS_OS_SANDBOX;
    delete process.env.KORYPHAIOS_OS_SANDBOX;
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

  test('an enabled kernel sandbox writes inside the grant, not host /tmp, and strips secrets', async () => {
    if (!osSandboxAvailable()) return;
    const root = temporaryPath('kory-sandbox-enforced-root');
    const outside = temporaryPath('kory-sandbox-enforced-outside');
    mkdirSync(root, { recursive: true });
    const previousEnabled = process.env.KORYPHAIOS_OS_SANDBOX;
    const previousSecret = process.env.KORY_SANDBOX_TEST_SECRET;
    process.env.KORYPHAIOS_OS_SANDBOX = '1';
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
  });

  test('global Koryphaios state is not an implicit Bash filesystem grant', () => {
    const root = temporaryPath('kory-sandbox-grant-root');
    mkdirSync(root, { recursive: true });
    // defaultAllowedRoots canonicalizes through realpathSync. On macOS,
    // tmpdir() may be under a symlinked root (e.g. /var → /private/var),
    // so compare against the canonical form.
    expect(defaultAllowedRoots(root)).toEqual([realpathSync(root)]);
  });
});
