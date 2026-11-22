import { constants } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { canonicalizePath } from '../runtime/platform';
import { GitExecutor } from './git-executor';
import { redactSecretsInText } from '../security';

/** The critic copy deliberately ships no .git, so the host captures the
 * producer's uncommitted change set before copying: the diff against HEAD
 * plus the untracked file list, bounded and secret-redacted. */
const REVIEW_DIFF_CAPTURE_LIMIT = 400 * 1024;

export type ReviewChangeSet =
  | { ok: true; patch: string }
  | { ok: false; reason: string };

export async function captureReviewChangeSet(directory: string): Promise<ReviewChangeSet> {
  try {
    const git = new GitExecutor(directory);
    const base = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
    const env = { GIT_TERMINAL_PROMPT: '0' };
    const diff = await git.exec([...base, 'diff', 'HEAD', '--no-color'], {
      env,
      maxStdoutBytes: REVIEW_DIFF_CAPTURE_LIMIT,
      maxStderrBytes: 16 * 1024,
    });
    if (!diff.success) {
      const detail = (diff.stderr || diff.stdout || 'git diff failed').trim().split('\n')[0];
      return { ok: false, reason: detail.slice(0, 200) || 'git diff failed' };
    }
    const untracked = await git.exec([...base, 'ls-files', '--others', '--exclude-standard'], {
      env,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 16 * 1024,
    });
    const parts = [diff.stdout.trimEnd()];
    const names = untracked.success ? untracked.stdout.trim() : '';
    if (names) parts.push(`Untracked files:\n${names}`);
    return { ok: true, patch: redactSecretsInText(parts.join('\n\n'), REVIEW_DIFF_CAPTURE_LIMIT) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: reason.slice(0, 200) };
  }
}

/** Independent writable verification copy, including installed dependencies.
 * Dereference links so a test cannot write through a link into the producer's
 * checkout. Never bring linked Git metadata or Kory control state into a copy. */
export async function createCriticWorkspace(source: string): Promise<string> {
  const directory = canonicalizePath(await mkdtemp(join(tmpdir(), 'kory-critic-')));
  try {
    await cp(source, directory, {
      recursive: true,
      dereference: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (path) => !relative(source, path).split(/[\\/]/).some(
        (part) => ['.git', '.trees', '.koryphaios', '.svelte-kit'].includes(part),
      ),
    });
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
