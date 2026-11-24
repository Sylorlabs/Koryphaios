/**
 * Hunk-level stage, unstage and revert for a chat's isolated checkout.
 *
 * A hunk is addressed by its position in the file's diff for one side plus its
 * header line. Every action re-renders that diff under the git mutex, requires
 * the caller's revision token to match, verifies the rebuilt single-hunk patch
 * with `git apply --check`, and only then applies it. All git runs through
 * GitExecutor with argv arrays and `--` before paths; nothing is shell-expanded.
 */

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { GitDiffHunk, GitFileHunks, GitHunkAction } from '@koryphaios/shared';
import { ConflictError, ValidationError } from '../errors/types';
import { isContainedBy } from '../runtime/platform';
import { GitExecutor } from './git-executor';

/** Diff arguments shared by every reader and every action so revisions agree. */
const DIFF_ARGS = [
  'diff',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--unified=3',
] as const;

export const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const MAX_FILE_PATH_LENGTH = 1024;
const MAX_ERROR_DETAIL = 400;

export interface ParsedFileDiff {
  /** File header lines (`diff --git`, `index`, `---`, `+++`, mode lines) before the first hunk. */
  prelude: string[];
  hunks: GitDiffHunk[];
}

/** Parse the output of `git diff` for one file into its header and hunks. */
export function parseFileDiff(diff: string): ParsedFileDiff {
  const lines = diff.length === 0 ? [] : diff.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const prelude: string[] = [];
  const hunks: GitDiffHunk[] = [];
  let current: GitDiffHunk | null = null;

  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      const match = HUNK_HEADER.exec(line);
      if (!match) throw new ValidationError('Git returned a hunk header this client cannot parse.');
      current = {
        index: hunks.length,
        header: line,
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        additions: 0,
        deletions: 0,
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) {
      prelude.push(line);
      continue;
    }
    // Body lines always begin with ' ', '+', '-' or '\\'; a column-0 "@@ " is never body text.
    if (line.startsWith('+')) current.additions += 1;
    else if (line.startsWith('-')) current.deletions += 1;
    current.lines.push(line);
  }
  return { prelude, hunks };
}

/** A single-hunk patch: the file header followed by exactly one hunk. */
export function buildHunkPatch(prelude: readonly string[], hunk: GitDiffHunk): string {
  return [...prelude, hunk.header, ...hunk.lines].join('\n') + '\n';
}

/** Token identifying the exact diff text rendered for one side of one file. */
export function diffRevision(diff: string, staged: boolean): string {
  return `sha256:${createHash('sha256')
    .update(staged ? 'staged\0' : 'unstaged\0')
    .update(diff)
    .digest('hex')}`;
}

/**
 * Repository-relative path: forward slashes, no traversal, no absolute or
 * drive-qualified forms. Pure syntax check; use it for user input before storing.
 */
export function assertRepoRelativePath(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_FILE_PATH_LENGTH) {
    throw new ValidationError('Enter a repository file path.');
  }
  if (
    raw.includes('\0') ||
    raw.includes('\\') ||
    raw.startsWith('/') ||
    /^[A-Za-z]:/.test(raw) ||
    raw.split('/').some((segment) => segment === '' || segment === '..')
  ) {
    throw new ValidationError('File paths must be relative to the repository root.');
  }
  return raw;
}

/** Syntax check plus containment of the resolved path under the checkout root. */
export function normalizeRepoFilePath(checkout: string, raw: string): string {
  const path = assertRepoRelativePath(raw);
  if (!isContainedBy(checkout, resolve(checkout, path))) {
    throw new ValidationError('File path is outside this chat’s checkout.');
  }
  return path;
}

function boundedDetail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_ERROR_DETAIL ? `${trimmed.slice(0, MAX_ERROR_DETAIL)}…` : trimmed;
}

/** Render the hunks of one file on one side and the revision token for that text. */
export async function readFileHunks(
  checkout: string,
  file: string,
  staged: boolean,
  git = new GitExecutor(checkout),
): Promise<GitFileHunks & ParsedFileDiff> {
  const path = normalizeRepoFilePath(checkout, file);
  const args = [...DIFF_ARGS, ...(staged ? ['--cached'] : []), '--', path];
  const result = await git.exec(args);
  if (result.outputLimitExceeded) {
    throw new ValidationError(
      'This diff is too large to act on by hunk. Stage or revert the file instead.',
    );
  }
  if (!result.success) {
    throw new ValidationError(`Could not read this file’s diff. ${boundedDetail(result.stderr)}`);
  }
  const parsed = parseFileDiff(result.stdout);
  return {
    file: path,
    staged,
    revision: diffRevision(result.stdout, staged),
    prelude: parsed.prelude,
    hunks: parsed.hunks,
  };
}

export interface HunkActionInput {
  action: GitHunkAction;
  file: string;
  hunkIndex: number;
  hunkHeader: string;
  revision: string;
}

/** Git flags that apply a patch to the index or worktree in the requested direction. */
function applyFlags(action: GitHunkAction): string[] {
  switch (action) {
    case 'stage':
      return ['--cached'];
    case 'unstage':
      return ['--cached', '--reverse'];
    case 'revert':
      return ['--reverse'];
  }
}

/**
 * Stage, unstage or revert exactly one hunk. Refuses (ConflictError) when the
 * diff changed since the caller rendered it, when the hunk header no longer
 * matches, or when the rebuilt patch does not apply cleanly; nothing is changed
 * in any refusal case.
 */
export async function applyHunkAction(
  checkout: string,
  input: HunkActionInput,
): Promise<GitFileHunks> {
  const git = new GitExecutor(checkout);
  const staged = input.action === 'unstage';
  return git.withLock(async () => {
    const current = await readFileHunks(checkout, input.file, staged, git);
    if (current.revision !== input.revision) {
      throw new ConflictError(
        'This file changed since the diff was shown. Refresh the diff and choose the hunk again.',
      );
    }
    const hunk = current.hunks[input.hunkIndex];
    if (!hunk || hunk.header !== input.hunkHeader) {
      throw new ConflictError(
        'That hunk is no longer in the diff. Refresh the diff and try again.',
      );
    }
    const patch = buildHunkPatch(current.prelude, hunk);
    const flags = applyFlags(input.action);
    const check = await git.exec(['apply', '--check', ...flags], { stdin: patch });
    if (!check.success) {
      throw new ConflictError(
        `This hunk does not apply cleanly, so nothing changed. ${boundedDetail(check.stderr)}`,
      );
    }
    const applied = await git.exec(['apply', ...flags], { stdin: patch });
    if (!applied.success) {
      throw new ConflictError(`Git could not apply this hunk. ${boundedDetail(applied.stderr)}`);
    }
    const after = await readFileHunks(checkout, input.file, staged, git);
    return { file: after.file, staged: after.staged, revision: after.revision, hunks: after.hunks };
  });
}
