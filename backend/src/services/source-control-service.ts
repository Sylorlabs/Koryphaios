import type {
  CreateGitWorkspaceRequest,
  CreatedGitWorkspace,
  GitWorkspaceSelection,
  Session,
} from '@koryphaios/shared';
import type {
  ProjectRootRef,
  SourceControlAdapter,
  SourceControlInspection,
  SourceControlKind,
} from '@koryphaios/shared';
import { ValidationError } from '../errors/types';
import type { ChatGit } from '../kory/chat-git';
import { GitManager } from '../kory/git-manager';
import { gitWorkspaceOwnership } from '../kory/git-owned-workspace';
import { GitWorkspace } from '../kory/git-workspace';
import { WorkspaceManager } from '../kory/workspace-manager';
import { canonicalizePath } from '../runtime/platform';
import { GitSourceControlAdapter, nonGitAdapter } from './source-control-adapters';
import {
  assertProjectRoot,
  assertTaskScope,
  type ProjectRoot,
  type TaskScope,
} from '../runtime/source-control-scope';

export interface SourceControlServiceAdapters {
  /**
   * WorkerPipelineService owns these managers and their shutdown lifecycle.
   * The composition root can wire `scope =>
   * workerPipeline.workspaceForSession(scope.sessionId)` here instead of this
   * facade constructing a second, unmanaged WorkspaceManager.
   */
  workerWorkspace?: (scope: TaskScope) => Promise<WorkspaceManager | null>;
}

export interface SourceControlRootAdapter {
  sourceControl: SourceControlKind;
  adapter: SourceControlAdapter;
}

/**
 * Backend-internal source-control seam. Existing Git, chat, and worker
 * implementations remain authoritative; this class only accepts admitted
 * scope objects and delegates to them.
 */
export class SourceControlService {
  constructor(
    private readonly adapters: SourceControlServiceAdapters = {},
    private readonly sourceAdapters: ReadonlyMap<string, SourceControlAdapter> = new Map(),
  ) {}

  adapterFor(root: ProjectRootRef): SourceControlAdapter {
    return (
      this.sourceAdapters.get(root.sourceControl) ??
      (root.sourceControl === 'git'
        ? new GitSourceControlAdapter()
        : nonGitAdapter(root.sourceControl))
    );
  }

  async inspectRoot(root: ProjectRootRef): Promise<SourceControlInspection> {
    return this.adapterFor(root).inspect(root);
  }

  inspectProject(projectRoot: ProjectRoot): Promise<GitWorkspaceSelection> {
    assertProjectRoot(projectRoot);
    return new GitWorkspace(projectRoot.path).selection();
  }

  createChatWorkspace(
    projectRoot: ProjectRoot,
    input: CreateGitWorkspaceRequest,
  ): Promise<CreatedGitWorkspace> {
    assertProjectRoot(projectRoot);
    return new GitWorkspace(projectRoot.path).create(input);
  }

  async chat(scope: TaskScope): Promise<{ session: Session; git: ChatGit; directory: string }> {
    assertTaskScope(scope);
    // Keep the scope seam usable by isolated runtime tests and lightweight
    // consumers without importing the full application context at module load.
    const { chatGitForSession } = await import('./chat-git-service');
    const chat = await chatGitForSession(scope.sessionId);
    if (canonicalizePath(chat.directory) !== scope.workspaceRoot) {
      throw new ValidationError(
        'The session workspace changed while source control was resolving.',
      );
    }
    return chat;
  }

  /** Return the existing panel Git adapter for this session workspace. */
  panel(scope: TaskScope): GitManager {
    assertTaskScope(scope);
    const directory = gitWorkspaceOwnership(scope.workspaceRoot)?.checkout ?? scope.workspaceRoot;
    return new GitManager(directory);
  }

  async workerWorkspace(scope: TaskScope): Promise<WorkspaceManager | null> {
    assertTaskScope(scope);
    if (!this.adapters.workerWorkspace) {
      throw new Error(
        'Worker workspace integration is not configured; delegate to WorkerPipelineService.workspaceForSession.',
      );
    }
    return this.adapters.workerWorkspace(scope);
  }
}

export const sourceControlService = new SourceControlService();
