import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { sessionWorkspaceOwnership } from './session-workspace';

/** Preserve the lexical chat grant when a project/worker cwd is a symlink to
 * an outside directory. Looking up only realpath(cwd) would silently classify
 * that command as unowned. The outermost owned ancestor is authoritative even
 * when an intermediate symlink points into another chat. The sandbox checks
 * the actual cwd against this grant and rejects the escape. */
export function gitWorkspaceOwnership(
  directory: string,
): ReturnType<typeof sessionWorkspaceOwnership> {
  let owner = sessionWorkspaceOwnership(directory);
  let cursor = dirname(resolve(directory));
  while (dirname(cursor) !== cursor) {
    owner = sessionWorkspaceOwnership(cursor) ?? owner;
    cursor = dirname(cursor);
  }
  return owner;
}

/** An owned chat is an independent repository, never a source worktree. This
 * check does not invoke Git or interpret repository-controlled configuration.
 * It is defense in depth, not the write boundary: Git and all of its helpers
 * must still execute inside the mandatory OS sandbox after this check. */
export function assertIndependentChatGitDirectory(checkout: string): void {
  const gitDir = join(checkout, '.git');
  if (
    realpathSync(checkout) !== checkout ||
    !lstatSync(gitDir).isDirectory() ||
    realpathSync(gitDir) !== gitDir
  ) {
    throw new Error('Owned chat Git directory must be an independent local directory');
  }
  try {
    lstatSync(join(gitDir, 'commondir'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Owned chat Git directory must not redirect its common directory');
}

/** Startup-only hint. Runtime Git queries remain sandboxed and authoritative. */
export function isIndependentChatGitRepository(checkout: string): boolean {
  try {
    assertIndependentChatGitDirectory(checkout);
    return (
      lstatSync(join(checkout, '.git', 'HEAD')).isFile() &&
      lstatSync(join(checkout, '.git', 'objects')).isDirectory()
    );
  } catch {
    return false;
  }
}
