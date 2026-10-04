import { randomUUID } from 'node:crypto';
import { cp, mkdir, realpath, writeFile, rename } from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { GitExecutor } from './git-executor';
import { ConflictError } from '../errors/types';

export const SESSION_WORKSPACE_ROOT = join(homedir(), '.koryphaios', 'chat-repositories');
export interface SessionWorkspace {
  path: string;
  repositoryPath: string;
  branch: string;
  baseCommit: string;
  isolation: 'independent-repository';
}
interface WorkspaceOwnership {
  version: 1;
  sourceRoot: string;
  checkout: string;
}
const owners = new Map<string, WorkspaceOwnership>();

/** Metadata is outside the agent-writable checkout. Do not trust a marker
 * inside a repository supplied by a user/agent as authority over settings. */
export function sessionWorkspaceOwnership(directory: string): WorkspaceOwnership | undefined {
  // Resolve ownership lexically FIRST. A redirected/deleted checkout must
  // retain its mandatory grant and fail validation, not become "unowned" and
  // fall back to optional sandbox preferences.
  const candidates = [resolve(directory)];
  try {
    candidates.push(realpathSync(directory));
  } catch {
    /* Keep lexical authority. */
  }
  let storageRoot = SESSION_WORKSPACE_ROOT;
  try {
    storageRoot = realpathSync(storageRoot);
  } catch {
    /* No persisted workspaces yet. */
  }
  for (const path of candidates) {
    for (const [root, owner] of owners) {
      const rel = relative(root, path);
      if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return owner;
    }
    let cursor = path;
    while (dirname(cursor) !== cursor) {
      if (basename(cursor) === 'checkout' && dirname(dirname(cursor)) === storageRoot) {
        try {
          const owner = JSON.parse(
            readFileSync(join(dirname(cursor), 'owner.json'), 'utf8'),
          ) as WorkspaceOwnership;
          if (
            owner.version !== 1 ||
            owner.checkout !== cursor ||
            typeof owner.sourceRoot !== 'string' ||
            !isAbsolute(owner.sourceRoot)
          )
            return undefined;
          owners.set(cursor, owner);
          return owner;
        } catch {
          return undefined;
        }
      }
      cursor = dirname(cursor);
    }
  }
  return undefined;
}

export function sessionSettingsRoot(directory: string): string {
  return sessionWorkspaceOwnership(directory)?.sourceRoot ?? directory;
}

/** Existing chats cannot silently abandon unfinished source work. Dirty Git
 * checkouts must be committed/recovered explicitly before automatic migration. */
export async function migrateSessionWorkspace(
  source: string,
  settingsRoot: string,
): Promise<SessionWorkspace> {
  const git = new GitExecutor(source);
  const head = await git.exec(['rev-parse', '--verify', 'HEAD']);
  if (head.success) {
    const status = await git.exec([
      '-c',
      'core.fsmonitor=false',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=normal',
    ]);
    if (!status.success || status.stdout.length > 0) {
      throw new ConflictError(
        `This legacy chat has unfinished or unreadable Git work at ${source}. Commit or recover it before continuing, or start a new isolated chat. The original checkout and session binding were not changed.`,
      );
    }
  }
  return createSessionWorkspace(source, { settingsRoot });
}

/** No alternates, hardlinks, shared refs, source remotes, or worktree commondir.
 * A chat is durable and deliberately not removed on shutdown or chat deletion.
 * Publishing is explicit; agents never automatically merge into the source. */
export async function createSessionWorkspace(
  sourceDirectory: string,
  options: {
    branch?: string;
    commit?: string;
    storageRoot?: string;
    empty?: boolean;
    settingsRoot?: string;
  } = {},
): Promise<SessionWorkspace> {
  const source = await realpath(sourceDirectory);
  const sourceGit = new GitExecutor(source);
  const rootResult = await sourceGit.exec(['rev-parse', '--show-toplevel']);
  const repoRoot =
    rootResult.success && !options.empty ? await realpath(rootResult.stdout.trim()) : source;
  const subdirectory = relative(repoRoot, source);
  const head = await sourceGit.exec(['rev-parse', '--verify', 'HEAD']);
  const storageRoot = resolve(options.storageRoot ?? SESSION_WORKSPACE_ROOT);
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const storage = await realpath(storageRoot);
  // Each attempt gets its own directory; failed attempts are preserved for
  // inspection, never mistaken for a completed workspace on the next retry.
  const container = join(storage, randomUUID());
  const checkout = join(container, 'checkout');
  await mkdir(container, { mode: 0o700 });
  const branch = options.branch ?? `kory/chat-${basename(container)}`;
  const hooks = join(container, 'disabled-hooks');
  await mkdir(hooks, { mode: 0o700 });
  const run = async (git: GitExecutor, args: string[]) => {
    const result = await git.exec(
      [
        '-c',
        `core.hooksPath=${hooks}`,
        '-c',
        'uploadpack.packObjectsHook=',
        '-c',
        'core.fsmonitor=false',
        ...args,
      ],
      {
        timeoutMs: 120_000,
      },
    );
    if (!result.success)
      throw new Error(`Cannot prepare isolated chat repository (${args[0]}): ${result.stderr}`);
    return result.stdout.trim();
  };
  if (!options.empty && rootResult.success && head.success) {
    // --no-local forces object transport rather than hardlinks/alternates.
    // Creation is a host-owned transfer into a fresh container, not a command
    // in the source chat. Disable source-side Git executable hooks above.
    await run(new GitExecutor(container), [
      'clone',
      '--no-local',
      '--no-hardlinks',
      '--no-checkout',
      '--',
      repoRoot,
      checkout,
    ]);
    const git = new GitExecutor(checkout);
    const revision = options.commit ?? head.stdout.trim();
    // clone's default refspec excludes refs/remotes/* and dangling commits.
    // The revision picker can legitimately select either. Import the pinned
    // object from the local source only, without creating a tracking remote.
    const hasRevision = await git.exec(['cat-file', '-e', `${revision}^{commit}`]);
    if (!hasRevision.success) {
      await run(git, ['fetch', '--no-tags', '--no-write-fetch-head', '--', repoRoot, revision]);
    }
    // Local source repositories must never be push destinations. Remote
    // publication can be configured explicitly by a human in this checkout.
    await run(git, ['remote', 'remove', 'origin']);
    await run(git, ['checkout', '-b', branch, revision]);
  } else {
    if (options.commit) throw new Error('The selected source has no committed Git baseline');
    await mkdir(checkout);
    if (!options.empty)
      await cp(source, checkout, {
        recursive: true,
        dereference: false,
        filter: (path) => {
          const name = basename(path);
          return (
            ![
              '.git',
              '.koryphaios',
              'node_modules',
              '.trees',
              '.ssh',
              '.aws',
              '.gnupg',
              '.kube',
              '.docker',
              '.npmrc',
              '.netrc',
              '.git-credentials',
            ].includes(name) &&
            name !== '.env' &&
            !name.startsWith('.env.')
          );
        },
      });
    const git = new GitExecutor(checkout);
    await run(git, ['init', '-b', branch]);
    await run(git, ['add', '--all']);
    await run(git, [
      '-c',
      'user.name=Koryphaios',
      '-c',
      'user.email=koryphaios@localhost',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'Initial isolated chat snapshot',
    ]);
  }
  const git = new GitExecutor(checkout);
  // Keep identity local to this copy. Never modify the source/global config.
  for (const key of ['user.name', 'user.email']) {
    const identity = await sourceGit.exec(['config', '--get', key]);
    const value =
      identity.success && identity.stdout.trim()
        ? identity.stdout.trim()
        : key === 'user.name'
          ? 'Koryphaios'
          : 'koryphaios@localhost';
    await run(git, ['config', '--local', key, value]);
  }
  const baseCommit = await run(git, ['rev-parse', 'HEAD']);
  const path = join(checkout, subdirectory);
  if (!existsSync(path))
    throw new Error('The selected project subdirectory is not present in the chosen commit');
  const owner: WorkspaceOwnership = {
    version: 1,
    sourceRoot: options.settingsRoot
      ? await realpath(options.settingsRoot)
      : sessionSettingsRoot(source),
    checkout,
  };
  await writeFile(join(container, 'owner.json.tmp'), JSON.stringify(owner), { mode: 0o600 });
  await rename(join(container, 'owner.json.tmp'), join(container, 'owner.json'));
  owners.set(checkout, owner);
  return { path, repositoryPath: source, branch, baseCommit, isolation: 'independent-repository' };
}
