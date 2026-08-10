import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'bun';
import type { ChangeSummary } from '@koryphaios/shared';
import { BashTool } from './bash';

const IS_WIN = process.platform === 'win32';
const testDirectories: string[] = [];

/** Normalize path separators to forward slashes for cross-platform comparison.
 *  On Windows, Node's resolve/join produce backslash paths while git reports
 *  forward-slash paths. This helper ensures comparisons are separator-agnostic. */
function normalizePath(p: string): string {
  return p.replaceAll('\\', '/');
}

/** Canonicalize a path for comparison, resolving 8.3 short names on Windows.
 *  Use this when comparing absolute paths that may have been produced by
 *  different tools (e.g. Node.js vs git). */
function canonicalPath(p: string): string {
  const realpath = realpathSync.native ?? realpathSync;
  try {
    return normalizePath(realpath(p));
  } catch {
    return normalizePath(p);
  }
}

function makeDirectory(prefix: string): string {
  const root = join(
    tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  testDirectories.push(root);
  // Return the canonical path. On macOS, tmpdir() may be under a symlinked
  // root (e.g. /var → /private/var). The BashTool's git-change-evidence
  // capture resolves the repo root through realpath, so change paths are
  // based on the canonical form. Tests that slice or compare against the
  // root must use the same canonical path.
  return realpathSync(root);
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
  // Windows defaults (core.autocrlf=true, 260-char path limit) break
  // cross-platform tests: CRLF alters file content after git operations.
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'core.longpaths', 'true');
  writeFileSync(join(root, '.gitignore'), '.koryphaios/\n');
  writeFileSync(join(root, 'edit.txt'), 'before\n');
  writeFileSync(join(root, 'delete.txt'), 'delete me\n');
  writeFileSync(join(root, 'mode.sh'), '#!/bin/sh\necho mode\n', { mode: 0o644 });
  writeFileSync(join(root, 'target-a'), 'a\n');
  writeFileSync(join(root, 'target-b'), 'b\n');
  // Use Node's symlinkSync instead of `ln -s` for cross-platform support.
  // On Windows without admin/developer mode, skip symlink creation — the
  // symlink-dependent assertions are guarded by IS_WIN checks below.
  if (!IS_WIN) {
    symlinkSync('target-a', join(root, 'link.txt'));
  }
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
    const changes = [...contentChange.changes, ...deletion.changes];

    for (const execution of [contentChange, deletion]) {
      expect(execution.result).toMatchObject({ isError: false });
    }

    // chmod and symlink changes require Unix file modes and symlink support.
    // On Windows, skip these operations and their assertions.
    if (!IS_WIN) {
      const modeChange = await runBash(root, 'exec chmod +x mode.sh');
      const symlinkChange = await runBash(root, 'exec ln -sfn target-b link.txt');
      changes.push(...modeChange.changes, ...symlinkChange.changes);
      for (const execution of [modeChange, symlinkChange]) {
        expect(execution.result).toMatchObject({ isError: false });
      }
    }

    // Canonicalize root for the slice operation: on Windows, change.path
    // may use the long name (runneradmin) while root uses the 8.3 short
    // name (RUNNER~1), causing the slice to cut at the wrong position.
    const canonicalRoot = canonicalPath(root);
    const byName = new Map(
      changes.map((change) => [
        normalizePath(canonicalPath(change.path).slice(canonicalRoot.length + 1)),
        change,
      ]),
    );
    const expectedKeys = IS_WIN
      ? ['created.txt', 'delete.txt', 'edit.txt']
      : ['created.txt', 'delete.txt', 'edit.txt', 'link.txt', 'mode.sh'];
    expect([...byName.keys()].sort()).toEqual(expectedKeys);
    expect(byName.get('created.txt')?.operation).toBe('create');
    expect(byName.get('delete.txt')?.operation).toBe('delete');
    expect(byName.get('edit.txt')?.operation).toBe('edit');
    if (!IS_WIN) {
      expect(byName.get('mode.sh')?.operation).toBe('edit');
      expect(byName.get('link.txt')?.operation).toBe('edit');
    }
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
    expect(canonicalPath(changes[0]!.path)).toBe(canonicalPath(join(root, 'edit.txt')));
    expect(changes[0]!.operation).toBe('edit');
  });

  test('records edits made before command failure and timeout', async () => {
    const root = makeDirectory('kory-bash-terminal-evidence');
    initializeRepo(root);

    const failed = await runBash(root, "printf 'failed\\n' > failed.txt; false");
    expect(failed.result.isError).toBe(true);
    expect(failed.changes.map((c) => ({ ...c, path: canonicalPath(c.path) }))).toContainEqual(
      expect.objectContaining({
        path: canonicalPath(join(root, 'failed.txt')),
        operation: 'create',
      }),
    );

    const timedOut = await runBash(root, "printf 'timed out\\n' > timeout.txt; sleep 1", {
      timeout: 0.05,
    });
    expect(timedOut.result.isError).toBe(true);
    expect(timedOut.result.output).toContain('timed out');
    expect(timedOut.changes.map((c) => ({ ...c, path: canonicalPath(c.path) }))).toContainEqual(
      expect.objectContaining({
        path: canonicalPath(join(root, 'timeout.txt')),
        operation: 'create',
      }),
    );
  });

  test.skipIf(process.platform === 'win32')(
    'timeout escalation kills TERM-ignoring descendants before returning',
    async () => {
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
    },
  );

  test('fails safely without inventing evidence outside a Git repository', async () => {
    const root = makeDirectory('kory-bash-nongit-evidence');
    const { result, changes } = await runBash(root, "printf 'plain\\n' > plain.txt");
    expect(result.isError).toBe(false);
    expect(changes).toEqual([]);
    expect(existsSync(join(root, 'plain.txt'))).toBe(true);
  });
});
