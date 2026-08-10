import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'bun';
import type { ChangeSummary } from '@koryphaios/shared';
import { BashTool } from './bash';

const testDirectories: string[] = [];

function makeDirectory(prefix: string): string {
  const root = join(
    tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  testDirectories.push(root);
  return root;
}

function git(root: string, ...args: string[]): void {
  const result = spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

function initializeRepo(root: string): void {
  git(root, 'init');
  git(root, 'config', 'user.email', 'bash-evidence@test.invalid');
  git(root, 'config', 'user.name', 'Bash Evidence Test');
  writeFileSync(join(root, '.gitignore'), '.koryphaios/\n');
  writeFileSync(join(root, 'edit.txt'), 'before\n');
  writeFileSync(join(root, 'delete.txt'), 'delete me\n');
  writeFileSync(join(root, 'mode.sh'), '#!/bin/sh\necho mode\n', { mode: 0o644 });
  writeFileSync(join(root, 'target-a'), 'a\n');
  writeFileSync(join(root, 'target-b'), 'b\n');
  Bun.spawnSync(['ln', '-s', 'target-a', 'link.txt'], { cwd: root });
  writeFileSync(join(root, 'untouched-dirty.txt'), 'clean\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'baseline');
}

async function runBash(
  root: string,
  command: string,
  options: { timeout?: number } = {},
): Promise<{ result: Awaited<ReturnType<BashTool['run']>>; changes: ChangeSummary[] }> {
  const changes: ChangeSummary[] = [];
  const callId = `bash-evidence-${Date.now()}-${Math.random()}`;
  const result = await new BashTool().run(
    {
      sessionId: callId,
      workingDirectory: root,
      isSandboxed: false,
      approvedToolCallIds: new Set([callId]),
      recordChange: (change) => changes.push(change),
    },
    {
      id: callId,
      name: 'bash',
      input: { command, timeout: options.timeout },
    },
  );
  return { result, changes };
}

afterEach(() => {
  for (const directory of testDirectories.splice(0)) {
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  }
});

describe('Bash foreground changed-file evidence', () => {
  test('records only net create/edit/delete/mode/symlink changes', async () => {
    const root = makeDirectory('kory-bash-evidence');
    initializeRepo(root);
    writeFileSync(join(root, 'untouched-dirty.txt'), 'dirty before command\n');
    mkdirSync(join(root, '.koryphaios'), { recursive: true });

    const contentChange = await runBash(
      root,
      [
        "printf 'after\\n' > edit.txt",
        "printf 'created\\n' > created.txt",
        "printf 'private\\n' > .koryphaios/runtime.txt",
      ].join('; '),
    );
    // The production resource wrapper intentionally sets a low process limit.
    // `exec` lets each external utility replace the shell without a fork, so
    // this regression remains deterministic on busy CI hosts.
    const deletion = await runBash(root, 'exec rm -- delete.txt');
    const modeChange = await runBash(root, 'exec chmod +x mode.sh');
    const symlinkChange = await runBash(root, 'exec ln -sfn target-b link.txt');
    const changes = [
      ...contentChange.changes,
      ...deletion.changes,
      ...modeChange.changes,
      ...symlinkChange.changes,
    ];

    for (const execution of [contentChange, deletion, modeChange, symlinkChange]) {
      expect(execution.result).toMatchObject({ isError: false });
    }
    const byName = new Map(changes.map((change) => [change.path.slice(root.length + 1), change]));
    expect([...byName.keys()].sort()).toEqual([
      'created.txt',
      'delete.txt',
      'edit.txt',
      'link.txt',
      'mode.sh',
    ]);
    expect(byName.get('created.txt')?.operation).toBe('create');
    expect(byName.get('delete.txt')?.operation).toBe('delete');
    expect(byName.get('edit.txt')?.operation).toBe('edit');
    expect(byName.get('mode.sh')?.operation).toBe('edit');
    expect(byName.get('link.txt')?.operation).toBe('edit');
    expect(byName.has('untouched-dirty.txt')).toBe(false);
    expect([...byName.keys()].some((path) => path.startsWith('.koryphaios/'))).toBe(false);
  });

  test('detects index-only transitions for a pre-existing dirty file', async () => {
    const root = makeDirectory('kory-bash-index-evidence');
    initializeRepo(root);
    writeFileSync(join(root, 'edit.txt'), 'already modified\n');

    const { result, changes } = await runBash(root, 'git add -- edit.txt');

    expect(result.isError).toBe(false);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      path: join(root, 'edit.txt'),
      operation: 'edit',
    });
  });

  test('records edits made before command failure and timeout', async () => {
    const root = makeDirectory('kory-bash-terminal-evidence');
    initializeRepo(root);

    const failed = await runBash(root, "printf 'failed\\n' > failed.txt; false");
    expect(failed.result.isError).toBe(true);
    expect(failed.changes).toContainEqual(
      expect.objectContaining({ path: join(root, 'failed.txt'), operation: 'create' }),
    );

    const timedOut = await runBash(root, "printf 'timed out\\n' > timeout.txt; sleep 1", {
      timeout: 0.05,
    });
    expect(timedOut.result.isError).toBe(true);
    expect(timedOut.result.output).toContain('timed out');
    expect(timedOut.changes).toContainEqual(
      expect.objectContaining({ path: join(root, 'timeout.txt'), operation: 'create' }),
    );
  });

  test('timeout escalation kills TERM-ignoring descendants before returning', async () => {
    const root = makeDirectory('kory-bash-timeout-reap');
    initializeRepo(root);
    const latePath = join(root, 'late-after-timeout.txt');

    const timedOut = await runBash(
      root,
      "trap '' TERM; (trap '' TERM; sleep 0.4; printf 'late\\n' > late-after-timeout.txt) & wait",
      { timeout: 0.05 },
    );

    expect(timedOut.result.isError).toBe(true);
    expect(timedOut.result.output).toContain('timed out');
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(existsSync(latePath)).toBe(false);
  });

  test('fails safely without inventing evidence outside a Git repository', async () => {
    const root = makeDirectory('kory-bash-nongit-evidence');
    const { result, changes } = await runBash(root, "printf 'plain\\n' > plain.txt");
    expect(result.isError).toBe(false);
    expect(changes).toEqual([]);
    expect(existsSync(join(root, 'plain.txt'))).toBe(true);
  });
});
