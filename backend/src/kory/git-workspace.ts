import { createSessionWorkspace } from './session-workspace';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  CreatedGitWorkspace,
  CreateGitWorkspaceRequest,
  GitWorkspaceSelection,
} from '@koryphaios/shared';
import { ConflictError, ValidationError } from '../errors/types';
import { GitExecutor } from './git-executor';

/** Persistent chat checkouts are deliberately NOT owned by WorkspaceManager:
 * its worker worktrees are disposable and automatically reconciled/removed. */
export class GitWorkspace {
  private git: GitExecutor;

  constructor(
    private directory: string,
    private storageRoot = join(homedir(), '.koryphaios', 'chat-repositories'),
  ) {
    this.git = new GitExecutor(directory);
  }

  async selection(): Promise<GitWorkspaceSelection> {
    return this.git.withLock(async () => {
      const root = await this.git.exec(['rev-parse', '--show-toplevel']);
      if (!root.success) {
        if (!root.stderr.includes('not a git repository')) {
          throw new ValidationError(
            'Unable to read this Git repository. Check its permissions and Git configuration.',
          );
        }
        return {
          isRepo: false,
          repositoryPath: this.directory,
          branch: null,
          head: null,
          dirty: false,
          refs: [],
          commits: [],
        };
      }
      const head = await this.git.exec(['rev-parse', '--verify', 'HEAD']);
      const branch = await this.git.exec(['symbolic-ref', '--quiet', '--short', 'HEAD']);
      const status = await this.git.exec([
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=normal',
      ]);
      const refs = await this.git.exec([
        'for-each-ref',
        '--sort=refname',
        '--format=%(refname)%00%(objectname)%00%(symref)',
        'refs/heads',
        'refs/remotes',
        'refs/tags',
      ]);
      if (!status.success || !refs.success)
        throw new ValidationError('Unable to read Git status or refs.');
      const history = head.success
        ? await this.git.exec([
            'log',
            '--no-show-signature',
            '-50',
            '--format=%H%x00%s%x00%an%x00%aI',
            'HEAD',
            '--',
          ])
        : null;
      if (history && !history.success) throw new ValidationError('Unable to read commit history.');
      return {
        isRepo: true,
        repositoryPath: root.stdout.trim(),
        branch: branch.success ? branch.stdout.trim() : null,
        head: head.success ? head.stdout.trim() : null,
        dirty: status.stdout.length > 0,
        refs: refs.stdout
          .split('\n')
          .filter(Boolean)
          .flatMap((line) => {
            const [ref, hash, symbolic] = line.split('\0');
            if (symbolic) return []; // origin/HEAD is an alias, not a selectable branch.
            const kind = ref.startsWith('refs/heads/')
              ? 'branch'
              : ref.startsWith('refs/remotes/')
                ? 'remote'
                : 'tag';
            return [{ ref, hash, kind, name: ref.replace(/^refs\/(heads|remotes|tags)\//, '') }];
          }),
        commits: (history?.stdout ?? '')
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [hash, subject, author, date] = line.split('\0');
            return { hash, subject, author, date };
          }),
      };
    });
  }

  /** Resolve only explicit refs or hex IDs: never options, reflogs, or revision expressions. */
  private async resolveCommit(ref: string, expectedHash?: string): Promise<string> {
    if (!/^[a-fA-F0-9]{7,64}$/.test(ref)) {
      if (
        !/^refs\/(heads|remotes|tags)\//.test(ref) ||
        !(await this.git.exec(['check-ref-format', ref])).success
      ) {
        throw new ValidationError('Choose a branch, tag, or commit hash from this repository.');
      }
    }
    // Resolve once, then peel the pinned object rather than re-reading a ref
    // which an external Git client could move between these commands.
    const object = await this.git.exec(['rev-parse', '--verify', '--end-of-options', ref]);
    if (!object.success)
      throw new ValidationError('The selected revision is not available. Refresh and try again.');
    const hash = object.stdout.trim();
    if (expectedHash && expectedHash !== hash) {
      throw new ConflictError(
        'The selected revision moved. Refresh the picker before creating a chat.',
      );
    }
    const result = await this.git.exec([
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${hash}^{commit}`,
    ]);
    if (!result.success)
      throw new ValidationError(
        'The selected revision is not an available commit. Refresh and try again.',
      );
    return result.stdout.trim();
  }

  async create(input: CreateGitWorkspaceRequest): Promise<CreatedGitWorkspace> {
    return this.git.withLock(async () => {
      const branch = input.branch;
      if (
        !branch ||
        branch.length > 255 ||
        branch.startsWith('-') ||
        branch.startsWith('refs/') ||
        !(await this.git.exec(['check-ref-format', `refs/heads/${branch}`])).success
      ) {
        throw new ValidationError(
          'Enter a valid new Git branch name (for example, feature/my-change).',
        );
      }
      const root = await this.git.exec(['rev-parse', '--show-toplevel']);
      if (!root.success)
        throw new ValidationError('Open a Git repository with at least one commit first.');
      const baseCommit = await this.resolveCommit(input.ref, input.expectedHash);
      const existing = await this.git.exec([
        'show-ref',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`,
      ]);
      if (existing.success)
        throw new ConflictError(
          'That branch already exists. Choose a new branch name for this chat.',
        );
      return createSessionWorkspace(this.directory, {
        branch,
        commit: baseCommit,
        storageRoot: this.storageRoot,
      });
    });
  }
}
