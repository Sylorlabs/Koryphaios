import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitExecutor } from '../git-executor';
import { checkpointLogPreview } from '../checkpoint-store';
import { koryLog } from '../../logger';

const TEST_DIR = mkdtempSync(join(tmpdir(), 'kory-git-timeout-'));
const BIN_DIR = join(TEST_DIR, 'bin');
const STARTED_MARKER = join(TEST_DIR, 'started');
const TERM_MARKER = join(TEST_DIR, 'term');
const PGID_MARKER = join(TEST_DIR, 'pgid');

describe('GitExecutor timeout cleanup', () => {
  beforeAll(() => {
    mkdirSync(BIN_DIR, { recursive: true });
    const fakeGit = `#!/bin/sh
case "$1" in
  hang)
    printf '%s\n' "$$" > "$FAKE_GIT_PGID_MARKER"
    printf 'started\n' > "$FAKE_GIT_STARTED_MARKER"
    printf 'partial-stdout\n'
    printf 'partial-stderr\n' >&2
    trap 'printf "term-direct\\n" >> "$FAKE_GIT_TERM_MARKER"' TERM
    (
      trap 'printf "term-child\\n" >> "$FAKE_GIT_TERM_MARKER"' TERM
      while :; do sleep 60; done
    ) &
    child_pid=$!
    while :; do wait "$child_pid"; done
    ;;
  quick)
    printf 'queue-released\n'
    ;;
  flood)
    i=0
    while [ "$i" -lt "$FAKE_GIT_FLOOD_BYTES" ]; do
      printf 'o'
      i=$((i + 1))
    done
    i=0
    while [ "$i" -lt "$FAKE_GIT_FLOOD_BYTES" ]; do
      printf 'e' >&2
      i=$((i + 1))
    done
    ;;
  *)
    printf 'unexpected fake git command\n' >&2
    exit 2
    ;;
esac
`;
    const executable = join(BIN_DIR, 'git');
    writeFileSync(executable, fakeGit);
    chmodSync(executable, 0o755);
  });

  afterAll(() => {
    if (existsSync(PGID_MARKER) && process.platform !== 'win32') {
      const pgid = Number(readFileSync(PGID_MARKER, 'utf8').trim());
      if (pgid > 1) {
        try {
          process.kill(-pgid, 'SIGKILL');
        } catch {
          // The executor should already have reaped the process group.
        }
      }
    }
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test.skipIf(process.platform === 'win32')(
    'escalates a TERM-ignoring process group and releases the global queue',
    async () => {
      const git = new GitExecutor(TEST_DIR);
      const env = {
        PATH: `${BIN_DIR}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        FAKE_GIT_STARTED_MARKER: STARTED_MARKER,
        FAKE_GIT_TERM_MARKER: TERM_MARKER,
        FAKE_GIT_PGID_MARKER: PGID_MARKER,
      };

      const startedAt = Date.now();
      const timedOutCall = git.exec(['hang'], { env, timeoutMs: 200 });
      await waitForFile(STARTED_MARKER, 1_000);

      // This call must wait behind the first one on gitMutex. If timeout
      // cleanup or a descendant-held pipe remains unbounded, it never runs.
      const queuedCall = git.exec(['quick'], { env, timeoutMs: 1_000 });
      const [timedOut, queued] = await Promise.all([timedOutCall, queuedCall]);

      expect(Date.now() - startedAt).toBeLessThan(1_500);
      expect(timedOut.success).toBe(false);
      expect(timedOut.exitCode).toBeNull();
      expect(timedOut.stdout).toBe('partial-stdout\n');
      expect(timedOut.stderr).toContain('partial-stderr');
      expect(timedOut.stderr).toContain('Command timed out after 200ms');
      expect(timedOut.stderr).toContain('sent SIGTERM and escalated to SIGKILL');
      expect(timedOut.output).toContain('partial-stdout');
      expect(timedOut.output).toContain('partial-stderr');
      expect(timedOut.output).toContain('Command timed out after 200ms');
      expect(readFileSync(TERM_MARKER, 'utf8')).toContain('term-');

      expect(queued.success).toBe(true);
      expect(queued.stdout).toBe('queue-released\n');
      const pgid = Number(readFileSync(PGID_MARKER, 'utf8').trim());
      expect(() => process.kill(-pgid, 0)).toThrow();
    },
  );

  test.skipIf(process.platform === 'win32')(
    'drains over-limit helper output, fails visibly, and releases the global queue',
    async () => {
      const git = new GitExecutor(TEST_DIR);
      const env = {
        PATH: `${BIN_DIR}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        FAKE_GIT_FLOOD_BYTES: '8192',
      };
      const syntheticArgument = `private-commit-message-${'z'.repeat(80)}`;
      const logger = koryLog as unknown as { error: (...args: unknown[]) => void };
      const originalError = logger.error;
      const logged: string[] = [];

      let flooded: Awaited<ReturnType<GitExecutor['exec']>>;
      let queued: Awaited<ReturnType<GitExecutor['exec']>>;
      try {
        logger.error = (...args: unknown[]) => logged.push(JSON.stringify(args));
        const floodCall = git.exec(['flood', '--message', syntheticArgument], {
          env,
          timeoutMs: 2_000,
          maxStdoutBytes: 1_024,
          maxStderrBytes: 512,
        });
        const queuedCall = git.exec(['quick'], { env, timeoutMs: 2_000 });
        [flooded, queued] = await Promise.all([floodCall, queuedCall]);
      } finally {
        logger.error = originalError;
      }

      expect(flooded.success).toBe(false);
      expect(flooded.exitCode).toBe(0);
      expect(flooded.outputLimitExceeded).toBe(true);
      expect(flooded.stdout).toBe('');
      expect(flooded.stderr).toContain('stdout exceeded the 1024-byte safety limit');
      expect(flooded.stderr).toContain('stderr exceeded the 512-byte safety limit');
      expect(flooded.stderr).toContain('captured output was discarded');
      expect(flooded.stderr).not.toContain('oooo');
      expect(flooded.stderr).not.toContain('eeee');
      expect(flooded.stdoutBytes).toBe(8_192);
      expect(flooded.stderrBytes).toBe(8_192);
      expect(logged.join('\n')).toContain('"command":"flood"');
      expect(logged.join('\n')).not.toContain(syntheticArgument);

      expect(queued.success).toBe(true);
      expect(queued.stdout).toBe('queue-released\n');
    },
  );

  test('bounds and redacts checkpoint Git/error log previews', () => {
    const syntheticToken = `ghp_${'A'.repeat(24)}`;
    const preview = checkpointLogPreview(
      `authorization=Bearer abcdefghijklmnopqrstuvwxyz token=${syntheticToken} ${'x'.repeat(4_000)}`,
      240,
    );

    expect(preview.length).toBeLessThanOrEqual(240);
    expect(preview).toContain('[REDACTED]');
    expect(preview).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(preview).not.toContain(syntheticToken);
    expect(preview.endsWith('…')).toBe(true);
  });

  test.skipIf(process.platform === 'win32')(
    'fails visibly when a repository-configured diff helper exceeds stdout limits',
    async () => {
      const repo = mkdtempSync(join(tmpdir(), 'kory-git-output-helper-'));
      try {
        expect(Bun.spawnSync(['git', 'init'], { cwd: repo }).exitCode).toBe(0);
        writeFileSync(join(repo, '.gitattributes'), 'tracked.txt diff=synthetic-flood\n');
        writeFileSync(join(repo, 'tracked.txt'), 'before\n');
        expect(Bun.spawnSync(['git', 'add', '.'], { cwd: repo }).exitCode).toBe(0);
        expect(
          Bun.spawnSync(
            [
              'git',
              '-c',
              'user.name=Kory Test',
              '-c',
              'user.email=kory-test@example.invalid',
              'commit',
              '-m',
              'baseline',
            ],
            { cwd: repo },
          ).exitCode,
        ).toBe(0);

        const helper = join(repo, 'diff-helper.sh');
        writeFileSync(
          helper,
          `#!/bin/sh
i=0
while [ "$i" -lt 8192 ]; do
  printf 'repository-helper-output'
  i=$((i + 24))
done
`,
        );
        chmodSync(helper, 0o700);
        expect(
          Bun.spawnSync(['git', 'config', 'diff.synthetic-flood.command', helper], {
            cwd: repo,
          }).exitCode,
        ).toBe(0);
        writeFileSync(join(repo, 'tracked.txt'), 'after\n');

        const git = new GitExecutor(repo);
        const oversized = git.exec(['diff', '--', 'tracked.txt'], {
          maxStdoutBytes: 1_024,
          maxStderrBytes: 1_024,
        });
        const queued = git.exec(['status', '--porcelain'], { timeoutMs: 2_000 });
        const [result, after] = await Promise.all([oversized, queued]);

        expect(result.success).toBe(false);
        expect(result.outputLimitExceeded).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('stdout exceeded the 1024-byte safety limit');
        expect(result.stdoutBytes).toBeGreaterThan(1_024);
        expect(after.success).toBe(true);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === 'win32')(
    'does not expose backend secrets to repository-configured Git helpers',
    async () => {
      const repo = mkdtempSync(join(tmpdir(), 'kory-git-safe-env-'));
      const helper = join(repo, 'fsmonitor.sh');
      const leak = join(repo, 'helper-env');
      const previous = process.env.KORY_GIT_ENV_SECRET;
      process.env.KORY_GIT_ENV_SECRET = 'synthetic-git-secret';
      try {
        expect(Bun.spawnSync(['git', 'init'], { cwd: repo }).exitCode).toBe(0);
        writeFileSync(
          helper,
          `#!/bin/sh
printf '%s' "$KORY_GIT_ENV_SECRET" > "${leak}"
printf 'token\\n'
`,
        );
        chmodSync(helper, 0o700);
        expect(
          Bun.spawnSync(['git', 'config', 'core.fsmonitor', helper], { cwd: repo }).exitCode,
        ).toBe(0);

        const result = await new GitExecutor(repo).exec(['status', '--porcelain']);

        expect(result.success).toBe(true);
        expect(readFileSync(leak, 'utf8')).toBe('');
      } finally {
        if (previous === undefined) delete process.env.KORY_GIT_ENV_SECRET;
        else process.env.KORY_GIT_ENV_SECRET = previous;
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );
});

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for fake Git marker: ${path}`);
    }
    await Bun.sleep(10);
  }
}
