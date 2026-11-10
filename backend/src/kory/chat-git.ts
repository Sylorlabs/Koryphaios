import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ChatGitDetails,
  ChatGitSelectionRecord,
  ChatGitState,
  ChatGitSwitchRequest,
  ChatGitTarget,
} from '@koryphaios/shared';
import { ConflictError, ValidationError } from '../errors/types';
import { canonicalizePath, isContainedBy } from '../runtime/platform';
import { assertIndependentChatGitDirectory } from './git-owned-workspace';
import { sessionWorkspaceOwnership } from './session-workspace';
import { GitExecutor } from './git-executor';
import { GitWorkspace } from './git-workspace';
import {
  GitHubPullRequests,
  githubRepositoryFromRemote,
  type PullRequestReader,
} from './github-pull-requests';

/** Default to an owned isolated checkout. The session service may explicitly
 * allow the persisted local folder of an ordinary in-place chat. */
export class ChatGit {
  private owner?: NonNullable<ReturnType<typeof sessionWorkspaceOwnership>>;
  private sourceRoot: string;
  private git: GitExecutor;
  constructor(
    private directory: string,
    private pullRequests: PullRequestReader = new GitHubPullRequests(),
    options: { allowInPlace?: boolean } = {},
  ) {
    const owner = sessionWorkspaceOwnership(directory);
    if (!owner && !options.allowInPlace)
      throw new ValidationError('This chat has no owned isolated Git checkout.');
    this.directory = canonicalizePath(directory);
    this.owner = owner;
    if (owner) {
      assertIndependentChatGitDirectory(owner.checkout);
      if (!isContainedBy(owner.checkout, this.directory))
        throw new ValidationError('The chat workspace was redirected.');
      this.sourceRoot = owner.sourceRoot;
      this.git = new GitExecutor(owner.checkout);
    } else {
      this.sourceRoot = this.directory;
      this.git = new GitExecutor(this.directory);
    }
  }

  private async exec(args: string[], readOnlyRoots: string[] = []) {
    // Do not execute project hooks or external diff/filter monitors on a user
    // selecting a revision. GitExecutor still enforces the mandatory sandbox.
    return this.git.exec(
      ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
      {
        env: { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
        readOnlyRoots,
      },
    );
  }

  async repository(): Promise<string | null> {
    // Chats deliberately have no push remote. Use host-owned source identity
    // solely to discover the GitHub repo; never copy its credential-bearing URL.
    if (!existsSync(this.sourceRoot)) return null;
    const source = new GitExecutor(this.sourceRoot);
    const remote = await source.exec(['config', '--get', 'remote.origin.url']);
    return remote.success ? githubRepositoryFromRemote(remote.stdout.trim()) : null;
  }

  async prs() {
    const repository = await this.repository();
    if (!repository)
      throw new ValidationError(
        'The source project needs a GitHub.com origin remote to browse pull requests.',
      );
    return this.pullRequests.list(repository);
  }

  async pr(number: number) {
    const repository = await this.repository();
    if (!repository)
      throw new ValidationError(
        'The source project needs a GitHub.com origin remote to open pull requests.',
      );
    if (!Number.isSafeInteger(number) || number < 1 || number > 1_000_000_000)
      throw new ValidationError('Enter a valid pull request number.');
    const pr = await this.pullRequests.get(repository, number);
    if (
      pr.number !== number ||
      pr.repository !== repository ||
      !/^[a-f0-9]{40,64}$/i.test(pr.headCommit)
    )
      throw new ValidationError('Pull request metadata does not match the selected repository.');
    return pr;
  }

  private operationInProgress() {
    return [
      'MERGE_HEAD',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'rebase-merge',
      'rebase-apply',
      'sequencer',
      'BISECT_LOG',
    ].some((name) => existsSync(join(this.owner?.checkout ?? this.directory, '.git', name)));
  }

  async state(sessionId: string, selection?: ChatGitSelectionRecord): Promise<ChatGitState> {
    return this.git.withLock(async () => {
      const snapshot = await new GitWorkspace(this.owner?.checkout ?? this.directory).selection();
      if (!snapshot.isRepo) {
        return {
          ...snapshot,
          sessionId,
          isolated: Boolean(this.owner),
          changedFiles: 0,
          operationInProgress: false,
          githubRepository: null,
          sourceRefs: [],
          sourceCommits: [],
        };
      }
      const status = await this.exec([
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=normal',
      ]);
      if (!status.success) throw new ValidationError('Could not read this chat’s Git status.');
      const entries = status.stdout.split('\0').filter(Boolean);
      let changedFiles = 0;
      for (let i = 0; i < entries.length; i++) {
        changedFiles++;
        if (/[RC]/.test(entries[i].slice(0, 2))) i++;
      }
      let source: Awaited<ReturnType<GitWorkspace['selection']>> | null = null;
      if (this.owner && existsSync(this.sourceRoot)) {
        // The selected chat checkout is authoritative. Source refs/history are
        // optional picker enrichment and must not make an otherwise healthy
        // chat display as unavailable when the source checkout is temporarily
        // unreadable.
        try {
          source = await new GitWorkspace(this.sourceRoot).selection();
        } catch {
          source = null;
        }
      }
      return {
        ...snapshot,
        sessionId,
        isolated: Boolean(this.owner),
        changedFiles,
        operationInProgress: this.operationInProgress(),
        githubRepository: await this.repository(),
        sourceRefs: source?.refs ?? [],
        sourceCommits: source?.commits ?? [],
        ...(selection?.branch === snapshot.branch && { selection }),
      };
    });
  }

  private async resolve(ref: string, expectedHash?: string, source = false): Promise<string> {
    const execute = source
      ? (args: string[]) =>
          new GitExecutor(this.sourceRoot).exec(['-c', 'core.fsmonitor=false', ...args])
      : (args: string[]) => this.exec(args);
    if (!/^[a-f0-9]{7,64}$/i.test(ref)) {
      if (
        !/^refs\/(heads|remotes|tags)\//.test(ref) ||
        !(await execute(['check-ref-format', ref])).success
      )
        throw new ValidationError(
          'Select a local branch, remote-tracking branch, tag, or hexadecimal commit ID.',
        );
    }
    const raw = await execute(['rev-parse', '--verify', '--end-of-options', ref]);
    if (!raw.success) throw new ValidationError('That revision is not available in this chat.');
    const object = raw.stdout.trim();
    if (expectedHash && object !== expectedHash)
      throw new ConflictError('The selected revision moved. Refresh its details and try again.');
    const commit = await execute([
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${object}^{commit}`,
    ]);
    if (!commit.success) throw new ValidationError('That revision is not a commit.');
    return commit.stdout.trim();
  }

  async details(ref: string, source = false): Promise<ChatGitDetails> {
    return this.git.withLock(async () => {
      const hash = await this.resolve(ref, undefined, source);
      const execute = source
        ? (args: string[]) =>
            new GitExecutor(this.sourceRoot).exec([
              '--no-optional-locks',
              '-c',
              'core.fsmonitor=false',
              ...args,
            ])
        : (args: string[]) => this.exec(args);
      const result = await execute([
        'show',
        '--no-show-signature',
        '--no-patch',
        '--format=%s%x00%B%x00%an%x00%aI',
        hash,
        '--',
      ]);
      const stat = await execute([
        'show',
        '--no-show-signature',
        '--format=',
        '--stat=100,70,100',
        '--no-ext-diff',
        '--no-textconv',
        hash,
        '--',
      ]);
      if (!result.success || !stat.success)
        throw new ValidationError('Could not read commit details.');
      const [subject, message, author, date] = result.stdout.split('\0');
      return {
        hash,
        subject,
        message: message.slice(0, 16_000),
        author,
        date: date.trim(),
        stat: stat.stdout.slice(0, 16_000),
      };
    });
  }

  private async assertCanSwitch(input: ChatGitSwitchRequest) {
    if (this.owner) assertIndependentChatGitDirectory(this.owner.checkout);
    const head = await this.exec(['rev-parse', '--verify', 'HEAD']);
    const branch = await this.exec(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (
      !head.success ||
      head.stdout.trim() !== input.expectedHead ||
      (branch.success ? branch.stdout.trim() : null) !== input.expectedBranch
    ) {
      throw new ConflictError('This chat’s branch or commit changed. Refresh before switching.');
    }
    if (this.operationInProgress())
      throw new ConflictError(
        'Finish or abort the current merge, rebase, cherry-pick, revert, or bisect before switching.',
      );
    const dirty = await this.exec(['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
    if (!dirty.success)
      throw new ConflictError('Could not verify that this chat has a clean checkout.');
    if (dirty.stdout.length)
      throw new ConflictError(
        'This chat has uncommitted changes. Commit or stash them explicitly before switching; nothing was discarded.',
      );
  }

  private async validateNewBranch(branch: string) {
    if (
      !branch ||
      branch.length > 255 ||
      branch.startsWith('-') ||
      branch.startsWith('refs/') ||
      !(await this.exec(['check-ref-format', `refs/heads/${branch}`])).success
    )
      throw new ValidationError('Enter a valid new working branch name.');
    if ((await this.exec(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).success)
      throw new ConflictError(
        'That branch already exists in this chat. Select it directly or choose a new name.',
      );
  }

  async switch(input: ChatGitSwitchRequest, signal?: AbortSignal): Promise<ChatGitSelectionRecord> {
    if (
      !input?.target ||
      !['branch', 'commit', 'pull-request'].includes(input.target.kind) ||
      !/^[a-f0-9]{40,64}$/i.test(input.expectedHead)
    )
      throw new ValidationError(
        'Inspect this chat first and provide a valid target and expected HEAD.',
      );
    return this.git.withLock(async () => {
      signal?.throwIfAborted();
      await this.assertCanSwitch(input);
      const target = input.target;
      let commit: string;
      let ref: string;
      let pullRequest;
      let branch = target.branch;
      if (target.kind === 'pull-request') {
        await this.validateNewBranch(branch!);
        pullRequest = await this.pr(target.number);
        if (target.expectedHash && target.expectedHash !== pullRequest.headCommit)
          throw new ConflictError('The PR head changed. Refresh PR details before switching.');
        const imported = `refs/kory/pr-import/${randomUUID()}`;
        try {
           const fetched = await this.exec([
            '-c',
            'credential.helper=',
            '-c',
            'credential.helper=!gh auth git-credential',
            '-c',
            'protocol.file.allow=never',
            '-c',
            'protocol.ext.allow=never',
            'fetch',
            '--no-tags',
            '--no-write-fetch-head',
            '--no-recurse-submodules',
            '--',
            `https://github.com/${pullRequest.repository}.git`,
            `refs/pull/${target.number}/head:${imported}`,
           ], [this.sourceRoot]);
          if (!fetched.success)
            throw new ValidationError(
              'Could not fetch this PR into the chat. Check gh auth login and repository access.',
            );
          const importedHead = await this.exec(['rev-parse', '--verify', imported]);
          if (!importedHead.success || importedHead.stdout.trim() !== pullRequest.headCommit)
            throw new ConflictError(
              'The PR changed while fetching. Refresh and try again; the current branch is unchanged.',
            );
          commit = importedHead.stdout.trim();
        } finally {
          await this.exec(['update-ref', '-d', imported]);
        }
        ref = `refs/pull/${target.number}/head`;
      } else {
        if (target.kind === 'commit' && !/^[a-f0-9]{7,64}$/i.test(target.ref))
          throw new ValidationError('Enter a hexadecimal commit ID.');
        commit = await this.resolve(target.ref, target.expectedHash, target.source);
        ref = target.ref;
        if (branch) await this.validateNewBranch(branch);
        else if (!target.source && target.kind === 'branch' && target.ref.startsWith('refs/heads/'))
          branch = target.ref.slice('refs/heads/'.length);
        else
          throw new ValidationError(
            'Create a new working branch for a commit, tag, remote branch, or source-project revision; detached work is not used.',
          );
        if (target.source && !(await this.exec(['cat-file', '-e', `${commit}^{commit}`])).success) {
          const sourceRoot = await new GitExecutor(this.sourceRoot).exec([
            'rev-parse',
            '--show-toplevel',
          ]);
          if (!sourceRoot.success)
            throw new ValidationError('The source repository is unavailable.');
           const imported = await this.exec([
            '-c',
            'uploadpack.packObjectsHook=',
            'fetch',
            '--no-tags',
            '--no-write-fetch-head',
            '--no-recurse-submodules',
            '--',
            sourceRoot.stdout.trim(),
            commit,
           ], [this.sourceRoot]);
          if (!imported.success)
            throw new ValidationError(
              'Could not import the selected commit from the source project into this chat.',
            );
        }
      }
      const subdirectory = relative(
        this.owner?.checkout ?? this.directory,
        this.directory,
      ).replaceAll('\\', '/');
      if (
        subdirectory &&
        !(await this.exec(['cat-file', '-e', `${commit}:${subdirectory}`])).success
      )
        throw new ConflictError(
          'This chat’s project subdirectory is absent from the selected commit.',
        );
      await this.assertCanSwitch(input); // network operations must not widen the stale/dirty window
      signal?.throwIfAborted();
      const result = target.branch
        ? await this.exec(['switch', '--no-overwrite-ignore', '-c', branch!, commit])
        : await this.exec(['switch', '--no-overwrite-ignore', '--no-guess', '--', branch!]);
      if (!result.success)
        throw new ConflictError(
          'Git refused to switch. No force, reset, or automatic stash was used. Check ignored files or branches used by a worktree.',
        );
      const actualHead = await this.exec(['rev-parse', '--verify', 'HEAD']);
      const actualBranch = await this.exec(['symbolic-ref', '--quiet', '--short', 'HEAD']);
      if (
        !actualHead.success ||
        !actualBranch.success ||
        actualHead.stdout.trim() !== commit ||
        actualBranch.stdout.trim() !== branch
      )
        throw new ConflictError(
          'Git state changed during the switch. Refresh before continuing; the checkout was not reset.',
        );
      return {
        kind: target.kind,
        ref,
        branch: branch!,
        commit,
        selectedAt: Date.now(),
        ...(pullRequest && { pullRequest }),
      };
    });
  }
}
