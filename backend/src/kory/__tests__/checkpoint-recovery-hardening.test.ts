import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { CheckpointStore } from '../checkpoint-store';
import { ShadowRepo } from '../shadow-repo';

const IS_WIN = process.platform === 'win32';

const temporaryRepos: string[] = [];

function git(
  repo: string,
  ...args: string[]
): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(['git', ...args], {
    cwd: repo,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr).trim(),
  };
}

function gitWithInput(
  repo: string,
  input: string,
  ...args: string[]
): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(['git', ...args], {
    cwd: repo,
    stdin: Buffer.from(input),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr).trim(),
  };
}

function createRepo(label: string): string {
  const repo = join(
    tmpdir(),
    `kory-recover-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  temporaryRepos.push(repo);
  mkdirSync(repo, { recursive: true });
  expect(git(repo, 'init', '-b', 'main').exitCode).toBe(0);
  expect(git(repo, 'config', 'user.name', 'Recovery Test').exitCode).toBe(0);
  expect(git(repo, 'config', 'user.email', 'recovery@example.com').exitCode).toBe(0);
  // Windows defaults (core.autocrlf=true, 260-char path limit) break
  // cross-platform tests: CRLF alters file content after git restore, and
  // long shadow ref paths exceed MAX_PATH. Disable both explicitly.
  expect(git(repo, 'config', 'core.autocrlf', 'false').exitCode).toBe(0);
  expect(git(repo, 'config', 'core.longpaths', 'true').exitCode).toBe(0);
  writeFileSync(join(repo, 'README.md'), '# Recovery\n');
  expect(git(repo, 'add', '.').exitCode).toBe(0);
  expect(git(repo, 'commit', '-m', 'base').exitCode).toBe(0);
  return repo;
}

async function createTwoStates(
  repo: string,
  agentId: string,
): Promise<{
  store: CheckpointStore;
  first: string;
  second: string;
}> {
  const store = new CheckpointStore(repo);
  writeFileSync(join(repo, 'owned.txt'), 'one');
  const first = await store.createGhostCommit('First', {
    agentId,
    changedFiles: [{ path: 'owned.txt', operation: 'create' }],
  });
  writeFileSync(join(repo, 'owned.txt'), 'two');
  const second = await store.createGhostCommit('Second', {
    agentId,
    changedFiles: [{ path: 'owned.txt', operation: 'edit' }],
  });
  expect(first).toBeTruthy();
  expect(second).toBeTruthy();
  return { store, first: first!, second: second! };
}

afterEach(() => {
  for (const repo of temporaryRepos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe('CheckpointStore recovery hardening', () => {
  test('rewinds the worktree while preserving same-path staged user content', async () => {
    const repo = createRepo('index');
    const agentId = 'index-preservation';
    const { store, first, second } = await createTwoStates(repo, agentId);

    writeFileSync(join(repo, 'owned.txt'), 'user staged value');
    expect(git(repo, 'add', 'owned.txt').exitCode).toBe(0);
    const indexBefore = git(repo, 'show', ':owned.txt').stdout;
    writeFileSync(join(repo, 'owned.txt'), 'two');

    const result = await store.recover(first, {
      agentId,
      expectedCurrentHash: second,
      changedFiles: [{ path: 'owned.txt', operation: 'edit' }],
    });
    expect(result.success, result.message).toBe(true);
    expect(readFileSync(join(repo, 'owned.txt'), 'utf-8')).toBe('one');
    expect(git(repo, 'show', ':owned.txt').stdout).toBe(indexBefore);
    expect(indexBefore).toBe('user staged value');
  });

  test('rejects symlink ancestors and preserves an external sentinel', async () => {
    // Symlink creation requires admin/developer mode on Windows. The
    // recovery path validation itself is platform-independent, so skip the
    // end-to-end symlink fixture on Windows rather than fail spuriously.
    if (IS_WIN) return;

    const repo = createRepo('symlink');
    const outside = `${repo}-outside`;
    temporaryRepos.push(outside);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'victim.txt'), 'external sentinel');
    symlinkSync(outside, join(repo, 'escape'));
    const { store, first, second } = await createTwoStates(repo, 'symlink-session');

    const result = await store.recover(first, {
      agentId: 'symlink-session',
      expectedCurrentHash: second,
      changedFiles: [{ path: 'escape/victim.txt', operation: 'delete' }],
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('validation');
    expect(readFileSync(join(outside, 'victim.txt'), 'utf-8')).toBe('external sentinel');
  });

  test('detects a mutation injected after the recovery backup and overwrites nothing', async () => {
    const repo = createRepo('stale-prepare');
    const agentId = 'stale-prepare';
    const { store, first, second } = await createTwoStates(repo, agentId);
    const mutable = store as unknown as {
      createGhostCommitLocked: (...args: unknown[]) => Promise<string | null>;
    };
    const original = mutable.createGhostCommitLocked.bind(store);
    mutable.createGhostCommitLocked = async (...args: unknown[]) => {
      const hash = await original(...args);
      if (args[4] === 'recovery-backup')
        writeFileSync(join(repo, 'owned.txt'), 'concurrent user edit');
      return hash;
    };

    const result = await store.recover(first, {
      agentId,
      expectedCurrentHash: second,
      changedFiles: [{ path: 'owned.txt', operation: 'edit' }],
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('changed while preparing');
    expect(readFileSync(join(repo, 'owned.txt'), 'utf-8')).toBe('concurrent user edit');
    expect(await store.getCursor(agentId)).toBe(second);
  });

  test('rolls the worktree back if cursor compare-and-swap cannot publish', async () => {
    const repo = createRepo('cursor-failure');
    const agentId = 'cursor-failure';
    const { store, first, second } = await createTwoStates(repo, agentId);
    const cursorRef = git(
      repo,
      '--git-dir',
      ShadowRepo.shadowPath(repo),
      'for-each-ref',
      '--format=%(refname)',
      'refs/kory/cursors',
    ).stdout;
    expect(cursorRef).toStartWith('refs/kory/cursors/');
    const lock = join(ShadowRepo.shadowPath(repo), `${cursorRef}.lock`);
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, 'held');

    const result = await store.recover(first, {
      agentId,
      expectedCurrentHash: second,
      changedFiles: [{ path: 'owned.txt', operation: 'edit' }],
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('rolled back');
    expect(readFileSync(join(repo, 'owned.txt'), 'utf-8')).toBe('two');
    expect(await store.getCursor(agentId)).toBe(second);
    expect(existsSync(lock)).toBe(true);
    rmSync(lock, { force: true });
  });

  test('compensates a completed recovery from its guarded receipt', async () => {
    const repo = createRepo('compensation');
    const agentId = 'compensation';
    const { store, first, second } = await createTwoStates(repo, agentId);

    const recovered = await store.recover(first, {
      agentId,
      expectedCurrentHash: second,
      changedFiles: [{ path: 'owned.txt', operation: 'edit' }],
    });
    expect(recovered.success, recovered.message).toBe(true);
    expect(recovered.receipt).toBeDefined();
    expect(readFileSync(join(repo, 'owned.txt'), 'utf-8')).toBe('one');

    const rolledBack = await store.rollbackRecovery(recovered.receipt!);
    expect(rolledBack.success, rolledBack.message).toBe(true);
    expect(readFileSync(join(repo, 'owned.txt'), 'utf-8')).toBe('two');
    expect(await store.getCursor(agentId)).toBe(second);
  });

  test('refuses compensation after a newer workspace edit', async () => {
    const repo = createRepo('compensation-stale');
    const agentId = 'compensation-stale';
    const { store, first, second } = await createTwoStates(repo, agentId);
    const recovered = await store.recover(first, {
      agentId,
      expectedCurrentHash: second,
      changedFiles: [{ path: 'owned.txt', operation: 'edit' }],
    });
    expect(recovered.success).toBe(true);
    writeFileSync(join(repo, 'owned.txt'), 'newer user edit');

    const rolledBack = await store.rollbackRecovery(recovered.receipt!);
    expect(rolledBack.success).toBe(false);
    expect(rolledBack.message).toContain('preserved');
    expect(readFileSync(join(repo, 'owned.txt'), 'utf-8')).toBe('newer user edit');
    expect(await store.getCursor(agentId)).toBe(first);
  });

  test('fails closed when a recovery journal blob does not match its ref identity', async () => {
    const repo = createRepo('journal-identity');
    const agentId = 'journal-identity';
    const { store, first, second } = await createTwoStates(repo, agentId);
    const prepared = await store.prepareRecoveryOperation({
      agentId,
      targetHash: first,
      expectedCurrentHash: second,
      previousMessageId: null,
      targetMessageId: null,
      changedFiles: [{ path: 'owned.txt', operation: 'edit' }],
    });
    expect(prepared.success).toBe(true);

    const shadow = ShadowRepo.shadowPath(repo);
    const ref = git(
      repo,
      '--git-dir',
      shadow,
      'for-each-ref',
      '--format=%(refname)',
      'refs/kory/recovery-operations',
    ).stdout;
    const original = JSON.parse(git(repo, '--git-dir', shadow, 'show', ref).stdout) as Record<
      string,
      unknown
    >;
    original.id = '0'.repeat(32);
    const blob = gitWithInput(
      repo,
      JSON.stringify(original),
      '--git-dir',
      shadow,
      'hash-object',
      '-w',
      '--stdin',
    );
    expect(blob.exitCode).toBe(0);
    expect(git(repo, '--git-dir', shadow, 'update-ref', ref, blob.stdout).exitCode).toBe(0);

    await expect(store.getPendingRecoveryOperations(agentId)).rejects.toThrow(
      'Recovery journal ownership is invalid',
    );
  });
});
