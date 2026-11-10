import type {
  ChangeRequest,
  ForgeAdapter,
  ProjectRootRef,
  RepositoryRef,
  Review,
  SourceControlAdapter,
  SourceControlInspection,
  SourceControlKind,
} from '@koryphaios/shared';
import { GitManager } from '../kory/git-manager';
import type { GitFileStatus } from '../kory/git-manager';

/** Explicit adapter absence is preferable to pretending every root is Git. */
export class UnavailableSourceControlAdapter implements SourceControlAdapter {
  constructor(
    public readonly kind: SourceControlKind,
    private readonly reason: string,
  ) {}

  async detect(): Promise<boolean> {
    return false;
  }

  async inspect(): Promise<SourceControlInspection> {
    return { kind: this.kind, available: false, dirty: false, reason: this.reason };
  }

  async status(): Promise<never> {
    throw new Error(this.reason);
  }
  async diff(): Promise<never> {
    throw new Error(this.reason);
  }
  async createWorkspace(): Promise<never> {
    throw new Error(this.reason);
  }
  async snapshot(): Promise<never> {
    throw new Error(this.reason);
  }
  async restore(): Promise<void> {
    throw new Error(this.reason);
  }
  async reconcile(): Promise<void> {
    throw new Error(this.reason);
  }
  async fetch(): Promise<void> {
    throw new Error(this.reason);
  }
  async update(): Promise<void> {
    throw new Error(this.reason);
  }
  async publish(): Promise<void> {
    throw new Error(this.reason);
  }
}

export function nonGitAdapter(kind: SourceControlKind): SourceControlAdapter {
  return new UnavailableSourceControlAdapter(
    kind,
    `${kind} source-control adapter is not configured for this installation`,
  );
}

export class UnavailableForgeAdapter implements ForgeAdapter {
  constructor(
    public readonly name: string,
    private readonly reason = `${name} forge adapter is not configured for this installation`,
  ) {}

  async listChangeRequests(_repository: RepositoryRef): Promise<ChangeRequest[]> {
    throw new Error(this.reason);
  }

  async review(_changeRequest: ChangeRequest, _review: Review): Promise<Review> {
    throw new Error(this.reason);
  }

  async publish(): Promise<never> {
    throw new Error(this.reason);
  }
}

/** Compatibility adapter: GitManager remains the command and ownership authority. */
export class GitSourceControlAdapter implements SourceControlAdapter {
  readonly kind = 'git' as const;

  private manager(root: ProjectRootRef): GitManager {
    return new GitManager(root.path);
  }

  async detect(root: ProjectRootRef): Promise<boolean> {
    return this.manager(root).isGitRepo();
  }

  async inspect(root: ProjectRootRef): Promise<SourceControlInspection> {
    const git = this.manager(root);
    if (!git.isGitRepo())
      return { kind: 'git', available: false, dirty: false, reason: 'Not a Git repository' };
    const status = await git.getStatus();
    const branch = await git.getBranch();
    const head = (await git.runGit(['rev-parse', 'HEAD'])).output.trim() || null;
    const remote = await git.getOrigin();
    return {
      kind: 'git',
      available: true,
      dirty: status.length > 0,
      branch,
      head,
      repository: {
        id: `repo_${root.id}`,
        kind: 'git',
        canonicalPath: root.path,
        identityKey: `git:${root.path}`,
        ...(remote ? { remote } : {}),
      },
    };
  }

  async status(root: ProjectRootRef) {
    const statuses = await this.manager(root).getStatus();
    return statuses.map((entry: GitFileStatus) => ({
      path: entry.path,
      state: entry.status === 'staged' ? 'modified' : entry.status,
      staged: entry.staged,
    }));
  }

  async diff(root: ProjectRootRef, path?: string): Promise<string> {
    return this.manager(root).getDiff(path ?? '', false);
  }

  async createWorkspace(root: ProjectRootRef): Promise<string> {
    return root.path;
  }

  async snapshot(root: ProjectRootRef) {
    const revision = (await this.manager(root).runGit(['rev-parse', 'HEAD'])).output.trim();
    if (!revision) throw new Error('Git snapshot could not determine HEAD');
    return { id: `snapshot_${revision}`, rootId: root.id, revision, createdAt: Date.now() };
  }

  async restore(root: ProjectRootRef, snapshot: { revision: string }): Promise<void> {
    if (!/^[a-f0-9]{40,64}$/i.test(snapshot.revision))
      throw new Error('Invalid Git snapshot revision');
    const result = await this.manager(root).runGit(['checkout', '--detach', snapshot.revision]);
    if (!result.success) throw new Error(result.output || 'Git snapshot restore failed');
  }

  async reconcile(): Promise<void> {}
  async fetch(root: ProjectRootRef): Promise<void> {
    const result = await this.manager(root).runGit(['fetch', '--all', '--prune']);
    if (!result.success) throw new Error(result.output || 'Git fetch failed');
  }
  async update(root: ProjectRootRef): Promise<void> {
    const result = await this.manager(root).pull();
    if (!result.success) throw new Error(result.output || 'Git update failed');
  }
  async publish(root: ProjectRootRef): Promise<void> {
    const result = await this.manager(root).push();
    if (!result.success) throw new Error(result.output || 'Git publish failed');
  }
}
