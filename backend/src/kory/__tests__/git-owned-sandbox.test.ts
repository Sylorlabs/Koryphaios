import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitExecutor } from '../git-executor';
import { GitManager } from '../git-manager';
import { createSessionWorkspace } from '../session-workspace';
import { osSandboxAvailable } from '../../security/os-sandbox';

const roots: string[] = [];
const originalSandbox = process.env.KORYPHAIOS_OS_SANDBOX;
afterEach(() => {
  if (originalSandbox === undefined) delete process.env.KORYPHAIOS_OS_SANDBOX;
  else process.env.KORYPHAIOS_OS_SANDBOX = originalSandbox;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kory-owned-git-')));
  roots.push(root);
  const source = join(root, 'source');
  mkdirSync(source);
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.name', 'Sandbox Test');
  git(source, 'config', 'user.email', 'sandbox@example.invalid');
  git(source, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(source, 'tracked'), 'baseline\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'baseline');
  const workspace = await createSessionWorkspace(source, { storageRoot: join(root, 'chats') });
  const checkout = workspace.path;
  git(checkout, 'config', 'commit.gpgsign', 'false');
  return { root, source, checkout, executor: new GitExecutor(checkout) };
}
function script(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
}

// Unsupported CI still verifies fail-closed behavior and no-helper startup.
// On a supported machine these tests MUST actually execute helpers; a failed
// sandbox launch is a failure, not a skipped malicious-helper assertion.
describe('owned chat Git mandatory write boundary', () => {
  test('startup probe never launches Git or reads agent-controlled configuration', async () => {
    const { root, checkout } = await fixture();
    const bin = join(root, 'bin');
    const marker = join(root, 'unrestricted-git');
    const redirected = join(checkout, 'redirected-cwd');
    symlinkSync(root, redirected);
    mkdirSync(bin);
    script(join(bin, 'git'), `printf ran > '${marker}'; exit 0`);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    try {
      expect(new GitManager(checkout).isGitRepo()).toBe(true);
      // A filesystem hint may still report the owning repository, but may
      // never invoke unconfined Git after a project cwd has been redirected.
      new GitManager(redirected).isGitRepo();
      expect(existsSync(marker)).toBe(false);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test('disabled kernel enforcement fails closed and releases the Git mutex', async () => {
    const { root, checkout, executor } = await fixture();
    const marker = join(root, 'escaped');
    const helper = join(checkout, 'fsmonitor');
    script(helper, `printf escaped > '${marker}'; printf 'token\\n'`);
    git(checkout, 'config', 'core.fsmonitor', helper);
    process.env.KORYPHAIOS_OS_SANDBOX = '0';
    await expect(executor.exec(['status', '--porcelain'])).rejects.toThrow(
      'OS sandbox enforcement is unavailable',
    );
    expect(existsSync(marker)).toBe(false);
    const unowned = await new GitExecutor(root).exec(['--version'], { timeoutMs: 2_000 });
    expect(unowned.success).toBe(true);
  });

  for (const redirection of ['gitfile', 'symlink', 'commondir'] as const) {
    test(`rejects main .git ${redirection} redirection without executing Git`, async () => {
      const { checkout, source, executor } = await fixture();
      if (redirection === 'commondir') {
        writeFileSync(join(checkout, '.git', 'commondir'), `${join(source, '.git')}\n`);
      } else {
        renameSync(join(checkout, '.git'), join(checkout, 'saved-git'));
        if (redirection === 'gitfile')
          writeFileSync(join(checkout, '.git'), `gitdir: ${join(source, '.git')}\n`);
        else symlinkSync(join(source, '.git'), join(checkout, '.git'));
      }
      expect(new GitManager(checkout).isGitRepo()).toBe(false);
      await expect(executor.exec(['status', '--porcelain'])).rejects.toThrow(
        'Owned chat Git directory',
      );
    });
  }

  test.skipIf(!osSandboxAvailable())(
    'real fsmonitor and commit hook run inside the boundary, never modifying source or siblings',
    async () => {
      process.env.KORYPHAIOS_OS_SANDBOX = '1';
      const { root, source, checkout, executor } = await fixture();
      const sibling = join(root, 'sibling');
      mkdirSync(sibling);
      const original = readFileSync(join(source, 'tracked'), 'utf8');
      const sourceConfig = readFileSync(join(source, '.git', 'config'), 'utf8');
      const outside = join(root, 'outside');
      const siblingMarker = join(sibling, 'escaped');
      const helper = join(checkout, 'fsmonitor');
      const ran = join(checkout, 'helpers-ran');
      const attempts = `printf changed > '${join(source, 'tracked')}'\nprintf changed >> '${join(source, '.git', 'config')}'\nprintf escaped > '${outside}'\nprintf escaped > '${siblingMarker}'`;
      script(helper, `${attempts}\nprintf fsmonitor >> '${ran}'\nprintf 'token\\n'\nexit 0`);
      git(checkout, 'config', 'core.fsmonitor', helper);
      script(
        join(checkout, '.git', 'hooks', 'pre-commit'),
        `${attempts}\nprintf hook >> '${ran}'\nexit 0`,
      );

      const status = await executor.exec(['status', '--porcelain']);
      expect(status.success).toBe(true);
      const commit = await executor.exec([
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '-m',
        'confined hook',
      ]);
      expect(commit.success).toBe(true);
      expect(readFileSync(ran, 'utf8')).toContain('fsmonitor');
      expect(readFileSync(ran, 'utf8')).toContain('hook');
      expect(readFileSync(join(source, 'tracked'), 'utf8')).toBe(original);
      expect(readFileSync(join(source, '.git', 'config'), 'utf8')).toBe(sourceConfig);
      expect(existsSync(outside)).toBe(false);
      expect(existsSync(siblingMarker)).toBe(false);
    },
  );

  test.skipIf(!osSandboxAvailable())(
    'sandbox adapter retains stdin, bounded streams, and nested transactions',
    async () => {
      process.env.KORYPHAIOS_OS_SANDBOX = '1';
      const { checkout, executor } = await fixture();
      const hash = await executor.withLock(() =>
        executor.exec(['hash-object', '--stdin'], { stdin: 'abc\n' }),
      );
      expect(hash.success).toBe(true);
      expect(hash.stdout.trim()).toBe('8baef1b4abc478178b004d62031cf7fe6db6f903');
      script(
        join(checkout, '.git', 'hooks', 'pre-commit'),
        'i=0; while [ "$i" -lt 2048 ]; do printf o; printf e >&2; i=$((i + 1)); done',
      );
      const flood = await executor.exec(
        ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'bounded'],
        { maxStdoutBytes: 128, maxStderrBytes: 128 },
      );
      expect(flood.success).toBe(false);
      expect(flood.outputLimitExceeded).toBe(true);
      expect(flood.stdout).toBe('');
      expect(flood.stderr).toContain('safety limit');
      expect((await executor.exec(['status', '--porcelain'])).success).toBe(true);
    },
  );

  test.skipIf(!osSandboxAvailable())(
    'timeout kills sandboxed hook descendants and releases queued operations',
    async () => {
      process.env.KORYPHAIOS_OS_SANDBOX = '1';
      const { checkout, executor } = await fixture();
      const started = join(checkout, 'hook-started');
      script(
        join(checkout, '.git', 'hooks', 'pre-commit'),
        `trap '' TERM\nprintf started > '${started}'\nprintf partial-hook >&2\n(sleep 2; printf escaped > '${join(checkout, 'late-write')}') &\nsleep 5`,
      );
      const call = executor.exec(
        ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'timeout'],
        { timeoutMs: 500 },
      );
      const next = executor.exec(['rev-parse', 'HEAD'], { timeoutMs: 2_000 });
      const before = Date.now();
      const [timedOut, queued] = await Promise.all([call, next]);
      expect(existsSync(started)).toBe(true);
      expect(timedOut.success).toBe(false);
      expect(timedOut.stderr).toContain('timed out');
      expect(timedOut.stderr).toContain('partial-hook');
      expect(queued.success).toBe(true);
      expect(Date.now() - before).toBeLessThan(2_000);
      await Bun.sleep(2_000);
      expect(existsSync(join(checkout, 'late-write'))).toBe(false);
    },
  );

  test.skipIf(!osSandboxAvailable())(
    'worker Git can update metadata across its own chat, but explicit routing cannot write the source',
    async () => {
      process.env.KORYPHAIOS_OS_SANDBOX = '1';
      const { checkout, executor, source } = await fixture();
      const worker = join(checkout, '.trees', 'worker');
      expect(
        (await executor.exec(['worktree', 'add', '-b', 'worker', worker, 'HEAD'])).success,
      ).toBe(true);
      const workerGit = new GitExecutor(worker);
      expect(
        (
          await workerGit.exec([
            '-c',
            'commit.gpgsign=false',
            'commit',
            '--allow-empty',
            '-m',
            'worker',
          ])
        ).success,
      ).toBe(true);
      const common = await workerGit.exec(['rev-parse', '--git-common-dir']);
      expect(common.success).toBe(true);
      expect(realpathSync(common.stdout.trim())).toBe(join(checkout, '.git'));
      const before = readFileSync(join(source, '.git', 'config'), 'utf8');
      const redirected = await executor.exec(['config', '--local', 'test.escape', 'blocked'], {
        env: { GIT_DIR: join(source, '.git'), GIT_WORK_TREE: source },
      });
      expect(redirected.success).toBe(false);
      expect(readFileSync(join(source, '.git', 'config'), 'utf8')).toBe(before);
    },
  );

  test.skipIf(!osSandboxAvailable())(
    'new executors cannot lose ownership when an owned cwd becomes a source symlink',
    async () => {
      process.env.KORYPHAIOS_OS_SANDBOX = '1';
      const { checkout, source } = await fixture();
      const project = join(checkout, 'project');
      symlinkSync(source, project);
      const escaped = new GitExecutor(project);
      await expect(escaped.exec(['status', '--porcelain'])).rejects.toThrow(
        'not inside any allowed root',
      );
    },
  );

  test.skipIf(!osSandboxAvailable())(
    'owned executor cwd override cannot broaden its checkout grant',
    async () => {
      process.env.KORYPHAIOS_OS_SANDBOX = '1';
      const { executor, source } = await fixture();
      await expect(executor.exec(['status'], { cwd: source })).rejects.toThrow(
        'not inside any allowed root',
      );
    },
  );
});
