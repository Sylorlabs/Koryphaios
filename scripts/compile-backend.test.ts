import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  hasPosixPermissionBits,
  providerProcessGroupOptions,
  terminateProviderProcessGroup,
} from '../backend/src/runtime/platform';
import { detectHostTarget } from './build-embedded-backend';
import {
  CI_BACKEND_COMPILE_TARGETS,
  compileBackendForCI,
  parseBackendCompileArguments,
} from './compile-backend';

const PROJECT_ROOT = resolve(import.meta.dir, '..');

function nativeTarget() {
  try {
    return detectHostTarget();
  } catch {
    return undefined;
  }
}

const host = nativeTarget();

describe('CI backend compile route', () => {
  test('accepts explicit matrix targets and preserves quoted output paths', () => {
    const outfile = join(tmpdir(), 'backend output with spaces');
    for (const target of CI_BACKEND_COMPILE_TARGETS) {
      expect(parseBackendCompileArguments([`--target=${target}`, `--outfile=${outfile}`])).toEqual({
        bunTarget: target,
        outfile: resolve(outfile),
      });
    }
    expect(parseBackendCompileArguments(['--outfile=relative-backend', '--target=bun-linux-x64'])).toEqual({
      bunTarget: 'bun-linux-x64',
      outfile: resolve('relative-backend'),
    });
  });

  for (const args of [
    [],
    ['--target=bun-linux-x64'],
    ['--outfile=backend'],
    ['--target=bun-linux-x64', '--outfile='],
    ['--target=unsupported', '--outfile=backend'],
    ['--target=bun-linux-x64', '--outfile=backend', '--outfile=other'],
    ['--target=bun-linux-x64', '--target=bun-darwin-arm64', '--outfile=backend'],
    ['--target=bun-linux-x64', '--outfile=backend', '--unknown=value'],
  ]) {
    test(`rejects incomplete, duplicate or unsupported arguments: ${JSON.stringify(args)}`, () => {
      expect(() => parseBackendCompileArguments(args)).toThrow();
    });
  }

  test('release CI uses the shared compile route without changing gzip or artifact layout', () => {
    const workflow = readFileSync(join(PROJECT_ROOT, '.github/workflows/release-desktop.yml'), 'utf8');
    const targets = [...workflow.matchAll(/bun-target:\s*(\S+)/gu)].map((match) => match[1]);
    expect(targets.sort()).toEqual([...CI_BACKEND_COMPILE_TARGETS].sort());
    const start = workflow.indexOf('- name: Compile backend for');
    const end = workflow.indexOf('- uses: actions/upload-artifact', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const step = workflow.slice(start, end);
    expect(step).toContain('bun --no-env-file run scripts/compile-backend.ts --target=${{ matrix.bun-target }}');
    expect(step).toContain('--outfile="$OUTFILE"');
    expect(step).not.toContain('bun build --compile');
    expect(step).not.toContain('DEFINE=');
    expect(step).toContain('gzip -9 -c "$OUTFILE" > "$OUTFILE.gz"');
    expect(step).toContain('test -s "$OUTFILE" || test -s "$OUTFILE.gz"');
    expect(workflow).toContain('path: koryphaios-backend-${{ matrix.target }}${{ matrix.suffix }}*');
  });

  test('invalid input does not overwrite an existing artifact', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'kory-ci-backend-invalid-'));
    try {
      const outfile = join(scratch, 'existing-backend');
      writeFileSync(outfile, 'previous artifact');
      await expect(compileBackendForCI(['--target=unsupported', `--outfile=${outfile}`])).rejects.toThrow();
      expect(readFileSync(outfile, 'utf8')).toBe('previous artifact');
      expect(readdirSync(scratch)).toEqual(['existing-backend']);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test.skipIf(!host || !CI_BACKEND_COMPILE_TARGETS.includes(host.bunTarget))(
    'genuine host CI compile produces the requested artifact without server startup or ledger changes',
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), 'kory-ci-backend-native-'));
      const ledger = join(PROJECT_ROOT, '.koryphaios/skills/evaluations.json');
      const digest = () => createHash('sha256').update(readFileSync(ledger)).digest('hex');
      try {
        const before = digest();
        const outfile = join(scratch, `koryphaios-backend-${host!.rustTarget}${host!.suffix}`);
        writeFileSync(outfile, 'previous artifact');
        expect(readFileSync(outfile, 'utf8')).toBe('previous artifact');
        const home = join(scratch, 'home');
        mkdirSync(home, { mode: 0o700 });
        const env: NodeJS.ProcessEnv = {
          PATH: process.env.PATH,
          HOME: home,
          USERPROFILE: home,
          CI: '1',
          KORY_RUN_LIVE_PROVIDER_TESTS: '0',
        };
        for (const key of ['BUN_INSTALL_CACHE_DIR', 'PLAYWRIGHT_BROWSERS_PATH']) {
          if (process.env[key]) env[key] = process.env[key];
        }
        // Exercise the actual pipeline CLI in a fresh compiler process, not
        // Bun test's in-process loader. No original HOME, inherited credential
        // variables or automatically loaded dotenv files enter it.
        const result = spawnSync(process.execPath, [
          '--no-env-file',
          'run',
          join(PROJECT_ROOT, 'scripts/compile-backend.ts'),
          `--target=${host!.bunTarget}`,
          `--outfile=${outfile}`,
        ], {
          cwd: PROJECT_ROOT,
          env,
          encoding: 'utf8',
          timeout: 90_000,
          maxBuffer: 262_144,
          killSignal: 'SIGKILL',
          ...providerProcessGroupOptions(),
        });
        terminateProviderProcessGroup(result.pid);
        if (result.error || result.status !== 0) {
          throw new Error(`CI backend CLI compile failed: ${result.error?.message ?? result.status}; ${result.stderr?.slice(0, 8192) ?? ''}`);
        }
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(`Compiled backend: ${outfile}`);
        const artifact = statSync(outfile);
        expect(artifact.isFile()).toBe(true);
        expect(artifact.size).toBeGreaterThan(0);
        if (hasPosixPermissionBits()) expect(artifact.mode & 0o111).toBeGreaterThan(0);
        expect(readdirSync(scratch).sort()).toEqual([
          'home',
          `koryphaios-backend-${host!.rustTarget}${host!.suffix}`,
        ].sort());
        expect(digest()).toBe(before);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
