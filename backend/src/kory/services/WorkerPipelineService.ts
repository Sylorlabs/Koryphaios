/**
 * WorkerPipelineService
 * Handles the worker task execution pipeline with worktree isolation.
 * Extracted from manager.ts runWorkerPipeline() and routeToWorker() methods.
 */

import type {
  ChangeSummary,
  KoryphaiosConfig,
  ProviderName,
  WorkerDomain,
} from '@koryphaios/shared';
import { DOMAIN } from '../../constants';
import type { ProviderRegistry, Provider } from '../../providers';
import type { ProviderMessage } from '../../providers/types';
import { nanoid } from 'nanoid';
import { stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { koryLog, serverLog } from '../../logger';
import type { SessionStateService } from './SessionStateService';
import { GitManager } from '../git-manager';
import { WorkspaceManager } from '../workspace-manager';
import { SnapshotManager } from '../snapshot-manager';
import type { ITaskStore } from '../../stores/task-store';
import { formatMessagesForCritic } from '../critic-util';
import { classifyTask, createTaskContract, type TaskContract, type TaskKind } from '../prompts';
import { getProviderHarnessCapabilities } from '../../providers/provider-harness';
import { computeCostUsd } from '../../pricing';
import type { CheckpointStore } from '../checkpoint-store';
import { canonicalizePath } from '../../runtime/platform';
import {
  normalizeSkillAssignment,
  type SkillAssignment,
  type SkillReviewContext,
} from '../skill-assignment';

// Keep the provider-native block form intact. Image/tool blocks are valid
// worker context and must not be narrowed to text merely to cross the service
// boundary back into KoryManager.
type InternalMessage = ProviderMessage;

/** Task kinds that use blocking review whenever the Critic is enabled. Read-only
 *  answer/research kinds (question, research-docs) are advisory-tolerant:
 *  one worker attempt, then advisory reporting instead of forced retries. */
const ALWAYS_STRICT: ReadonlySet<TaskKind> = new Set([
  'bug',
  'mechanical-edit',
  'refactor',
  'feature',
  'ui',
  'security-infra',
]);

/** Read-only answer/research kinds never justify forced multi-attempt
 *  critic retries — they get a single worker attempt. */
export function isReadOnlyTaskKind(kind: TaskKind): boolean {
  return !ALWAYS_STRICT.has(kind);
}

/**
 * Resolve the effective gate strictness for a task kind given the user's
 * configured policy and how many critic reviews have already failed.
 * Repository-mutating tasks are always strict; answer and research tasks
 * honor the user's setting, except that a configured strict policy degrades
 * to advisory after the first failed review instead of forcing retries.
 */
export function resolveGateStrictness(
  kind: TaskKind,
  configured: 'strict' | 'advisory' | 'off',
  failedReviews = 0,
): 'strict' | 'advisory' | 'off' {
  if (configured === 'off') return 'off';
  if (ALWAYS_STRICT.has(kind)) return 'strict';
  if (configured === 'strict' && failedReviews >= 1) return 'advisory';
  return configured;
}

interface WorkerPipelineResult {
  success: boolean;
  verification?: 'verified' | 'unverified';
  workerTranscript?: string;
  criticFeedback?: string;
  provider?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
}

interface ProjectExecutionResources {
  root: string;
  git: GitManager;
  workspaceManager: WorkspaceManager | null;
  snapshotManager: SnapshotManager | null;
}

/**
 * The host contract the worker pipeline depends on.
 *
 * Previously this was a bag of 11 closures constructed inside KoryManager's
 * constructor, each wrapping a private manager method. That duplicated every
 * signature (once on the manager, once in the closure) and let the two files
 * drift silently. As a real interface, KoryManager implements it directly and
 * TypeScript verifies conformance at compile time. The service depends on the
 * interface, not on KoryManager, so it can be tested with a stub host and
 * reasoned about without reading the manager.
 */
export interface WorkerPipelineHost {
  /** Whether *this session* is running YOLO. Approval posture is per chat, so
   *  this must be resolved against the session rather than a process-wide flag
   *  that one chat's composer toggle would flip for every other chat. */
  getIsYoloMode(sessionId: string): boolean;
  getWorkingDirectory(): string;
  /** Resolve the project bound to this exact session, or reject if unavailable. */
  resolveSessionWorkingDirectoryPublic(sessionId: string): Promise<string>;
  getWorkerReasoningLevel(): string;
  getQualityPolicy(
    workingDirectory?: string,
    sessionId?: string,
  ): {
    gateStrictness: 'strict' | 'advisory' | 'off';
    maxCriticIterations: number;
  };
  waitForUserInput(
    sessionId: string,
    question: string,
    options: string[],
    opts?: { allowOther?: boolean; allowKeepChatting?: boolean },
  ): Promise<string>;
  emitThought(sessionId: string, phase: string, thought: string): void;
  updateWorkflowState(sessionId: string, state: string): Promise<void>;
  resolveActiveRouting(
    preferredModel?: string,
    domain?: WorkerDomain,
    avoidLegacy?: boolean,
    prompt?: string,
    preferCheap?: boolean,
    workingDirectory?: string,
  ): { model: string; provider: ProviderName | undefined };
  executeWithProvider(
    sessionId: string,
    provider: Provider,
    modelId: string,
    userMessage: string,
    domain: WorkerDomain,
    reasoningLevel: string | undefined,
    isAutoMode: boolean,
    allowedPaths: string[],
    isSandboxed: boolean,
    taskContract?: TaskContract,
  ): Promise<{
    success: boolean;
    error?: string;
    workerMessages?: InternalMessage[];
    skillReviewContext?: SkillReviewContext;
    usage?: { tokensIn: number; tokensOut: number };
  }>;
  runCriticGate(
    sessionId: string,
    workerMessages: InternalMessage[] | undefined,
    preferredModel?: string,
    task?: string,
    reviewDirectory?: string,
    producerIdentity?: { provider: ProviderName; model: string },
    skillReviewContext?: SkillReviewContext,
  ): Promise<{ passed: boolean; skipped?: boolean; independent?: boolean; feedback?: string }>;
  runDestinationChecks(
    sessionId: string,
    workingDirectory: string,
  ): Promise<{ passed: boolean; output: string }>;
  /** Accumulate worker spend into the manager turn so chat totals include subagents. */
  recordWorkerUsage?(
    sessionId: string,
    usage: { provider?: string; model?: string; tokensIn?: number; tokensOut?: number },
  ): void;
}

export interface WorkerPipelineServiceDependencies {
  providers: ProviderRegistry;
  state: SessionStateService;
  git: GitManager;
  workspaceManager: WorkspaceManager | null;
  snapshotManager: SnapshotManager;
  tasks?: ITaskStore;
  host: WorkerPipelineHost;
  /** Publisher injection keeps durable acknowledgement failures testable. */
  checkpointStoreFactory?: (workingDirectory: string) => Pick<CheckpointStore, 'createGhostCommit'>;
  /**
   * Workspace settings applied to every project this service builds a
   * WorkspaceManager for. Without this, a session whose project differs from
   * the backend's working directory silently fell back to hard-coded defaults
   * instead of the user's configured worktree limit and directory.
   */
  workspaceConfig?: KoryphaiosConfig['workspace'];
}

export class WorkerPipelineService {
  private providers: ProviderRegistry;
  private state: SessionStateService;
  private git: GitManager;
  workspaceManager: WorkspaceManager | null;
  private snapshotManager: SnapshotManager;
  private tasks?: ITaskStore;
  private host: WorkerPipelineHost;
  private alternateProjectResources = new Map<string, Promise<ProjectExecutionResources>>();
  private checkpointStoreFactory?: WorkerPipelineServiceDependencies['checkpointStoreFactory'];
  private workspaceConfig?: KoryphaiosConfig['workspace'];
  private disposed = false;

  constructor(deps: WorkerPipelineServiceDependencies) {
    this.providers = deps.providers;
    this.state = deps.state;
    this.git = deps.git;
    this.workspaceManager = deps.workspaceManager;
    this.snapshotManager = deps.snapshotManager;
    this.tasks = deps.tasks;
    this.host = deps.host;
    this.checkpointStoreFactory = deps.checkpointStoreFactory;
    this.workspaceConfig = deps.workspaceConfig;
  }

  private async canonicalDirectory(path: string, label: string): Promise<string> {
    if (!path?.trim()) throw new Error(`${label} is empty`);
    const canonical = canonicalizePath(resolve(path));
    const info = await stat(canonical);
    if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${canonical}`);
    return canonical;
  }

  private async createAlternateProjectResources(root: string): Promise<ProjectExecutionResources> {
    const git = new GitManager(root);
    // Delegated writes require a Git baseline. Do not create snapshot storage in
    // a non-Git session project merely because a delegation was attempted.
    const snapshotManager = git.isGitRepo() ? new SnapshotManager(root) : null;
    let workspaceManager: WorkspaceManager | null = null;
    if (git.isGitRepo()) {
      // Honour the user's configured workspace settings here too; previously this
      // manager was built with no config and silently used the defaults.
      const candidate = new WorkspaceManager(root, this.workspaceConfig);
      try {
        await candidate.init();
        workspaceManager = candidate;
      } catch (err: unknown) {
        koryLog.warn(
          { root, err: err instanceof Error ? err.message : String(err) },
          'Session project worktree isolation is unavailable; delegation refused',
        );
        throw new Error('Session project worktree initialization failed', { cause: err });
      }
    }
    return { root, git, workspaceManager, snapshotManager };
  }

  /**
   * Release every per-session-project WorkspaceManager this service created.
   * The primary manager is owned and drained by KoryManager; these alternates
   * were previously never shut down, so their worktrees and slots leaked.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const pending = [...this.alternateProjectResources.values()];
    this.alternateProjectResources.clear();
    await Promise.allSettled(
      pending.map(async (resourcesPromise) => {
        const resources = await resourcesPromise.catch(() => null);
        if (!resources?.workspaceManager) return;
        try {
          await resources.workspaceManager.shutdown();
        } catch (err: unknown) {
          koryLog.warn(
            { project: resources.root, err: String(err) },
            'Failed to drain an alternate session project workspace during shutdown',
          );
        }
      }),
    );
  }

  private async prepareRecoveryBaseline(
    sessionId: string,
    project: ProjectExecutionResources,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!project.git.isGitRepo()) {
      return {
        ok: false,
        reason:
          'Delegated project changes require a Git repository so Koryphaios can create a reversible baseline. Initialize Git for this project before delegating write work.',
      };
    }

    try {
      const hash = await project.git.getCurrentHash();
      if (!hash) {
        return {
          ok: false,
          reason:
            'Delegated project changes require an existing Git commit so Koryphaios can create a reversible baseline. Commit the initial project state before delegating write work.',
        };
      }
      this.state.saveCheckpoint(sessionId, hash);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: `Koryphaios could not verify a reversible Git baseline: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  /** Recovery must use the same per-chat manager as execution, never the
   * backend launch repository's manager. */
  async workspaceForSession(sessionId: string): Promise<WorkspaceManager | null> {
    return (await this.resolveProjectResources(sessionId)).workspaceManager;
  }

  private async resolveProjectResources(sessionId: string): Promise<ProjectExecutionResources> {
    const sessionRoot = await this.canonicalDirectory(
      await this.host.resolveSessionWorkingDirectoryPublic(sessionId),
      `Session ${sessionId} project directory`,
    );
    const configuredRoot = await this.canonicalDirectory(
      this.host.getWorkingDirectory(),
      'Koryphaios configured project directory',
    );
    if (sessionRoot === configuredRoot) {
      return {
        root: sessionRoot,
        git: this.git,
        workspaceManager: this.workspaceManager,
        snapshotManager: this.snapshotManager,
      };
    }

    let pending = this.alternateProjectResources.get(sessionRoot);
    if (!pending) {
      pending = this.createAlternateProjectResources(sessionRoot).catch((error) => {
        this.alternateProjectResources.delete(sessionRoot);
        throw error;
      });
      this.alternateProjectResources.set(sessionRoot, pending);
    }
    return pending;
  }

  private isWithinProject(root: string, path: string): boolean {
    const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
    const rel = relative(root, target);
    return rel === '' || (!rel.startsWith('../') && rel !== '..' && !isAbsolute(rel));
  }

  private checkpointChanges(
    changes: ChangeSummary[],
    projectRoot: string,
    workerDirectory: string,
    worktreePaths: string[],
  ): ChangeSummary[] {
    const normalized = new Map<string, ChangeSummary>();
    const add = (change: ChangeSummary, base: string, fallbackOnly = false) => {
      const source = isAbsolute(change.path) ? resolve(change.path) : resolve(base, change.path);
      let destination = source;
      if (workerDirectory !== projectRoot && this.isWithinProject(workerDirectory, source)) {
        destination = resolve(projectRoot, relative(workerDirectory, source));
      }
      if (!this.isWithinProject(projectRoot, destination)) return;
      const rel = relative(projectRoot, destination).replaceAll('\\', '/');
      if (
        !rel ||
        rel === '.git' ||
        rel.startsWith('.git/') ||
        rel === '.koryphaios' ||
        rel.startsWith('.koryphaios/')
      ) {
        return;
      }
      if (!fallbackOnly || !normalized.has(rel)) {
        normalized.set(rel, { ...change, path: resolve(projectRoot, rel) });
      }
    };

    for (const change of changes) add(change, workerDirectory);
    for (const path of worktreePaths) {
      add({ path, operation: 'edit', linesAdded: 0, linesDeleted: 0 }, workerDirectory, true);
    }
    return [...normalized.values()];
  }

  private markCheckpointDegraded(
    result: WorkerPipelineResult,
    reason: string,
  ): WorkerPipelineResult {
    const boundedReason = reason.replaceAll(/\s+/g, ' ').trim().slice(0, 280);
    const notice =
      'UNVERIFIED RECOVERY: Work completed, but Koryphaios could not persist a durable ' +
      `project checkpoint${boundedReason ? ` (${boundedReason})` : ''}. Turn evidence was retained.`;
    return {
      ...result,
      verification: 'unverified',
      criticFeedback: [result.criticFeedback, notice].filter(Boolean).join('\n'),
    };
  }

  private async persistCompletionCheckpoint(
    sessionId: string,
    task: string,
    preferredModel: string | undefined,
    result: WorkerPipelineResult,
    project: ProjectExecutionResources,
    workerDirectory: string,
    worktreePaths: string[],
  ): Promise<WorkerPipelineResult> {
    if (!project.git.isGitRepo()) {
      return this.markCheckpointDegraded(result, 'the session project is not a Git repository');
    }

    try {
      const checkpointStore = this.checkpointStoreFactory
        ? this.checkpointStoreFactory(project.root)
        : new (await import('../checkpoint-store')).CheckpointStore(project.root);
      const changes = this.checkpointChanges(
        this.state.getChanges(sessionId),
        project.root,
        workerDirectory,
        worktreePaths,
      );
      const toolCalls = this.state.getToolCalls(sessionId);
      const commands = this.state.getCommands(sessionId);
      const hash = await checkpointStore.createGhostCommit(task.slice(0, 72), {
        agentId: sessionId,
        model: result.model ?? preferredModel ?? 'unknown',
        prompt: task,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        cost:
          result.provider && result.model
            ? computeCostUsd(
                result.provider,
                result.model,
                result.tokensIn ?? 0,
                result.tokensOut ?? 0,
              )?.costUsd
            : undefined,
        checkpointType: 'auto_save',
        changedFiles: changes,
        summary: task.slice(0, 120),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        commands: commands.length > 0 ? commands : undefined,
        fileEdits:
          changes.length > 0
            ? changes.map((file) => ({
                path: file.path,
                operation: file.operation,
                linesAdded: file.linesAdded,
                linesDeleted: file.linesDeleted,
              }))
            : undefined,
        provider: result.provider,
      });
      if (!hash) {
        return this.markCheckpointDegraded(result, 'checkpoint publication returned no hash');
      }
      // Instrumentation is acknowledged only after the checkpoint publication
      // returned a durable object id. A null/throw keeps it available for retry.
      this.state.clearTurnInstrumentation(sessionId);
      koryLog.info({ sessionId, project: project.root, hash }, 'Worker checkpoint persisted');
      return result;
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      serverLog.warn(
        { sessionId, project: project.root, err: reason },
        'Worker completed without a durable checkpoint; instrumentation retained',
      );
      return this.markCheckpointDegraded(result, reason);
    }
  }

  /** @internal Used by orchestration tests to stub worker routing. */
  routeToWorker = this._routeToWorker.bind(this);

  /**
   * Run the worker pipeline (confirm if needed, routeToWorker, return summary).
   * Used when the manager explicitly calls delegate_to_worker.
   */
  async runWorkerPipeline(
    sessionId: string,
    task: string,
    preferredModel?: string,
    reasoningLevel?: string,
    domainHint?: string,
    skillAssignment?: SkillAssignment,
  ): Promise<string> {
    this.host.emitThought(
      sessionId,
      'executing',
      'Running delegated work inside the configured project jail.',
    );

    await this.host.updateWorkflowState(sessionId, 'executing');

    let project: ProjectExecutionResources;
    try {
      project = await this.resolveProjectResources(sessionId);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      koryLog.warn({ sessionId, err: reason }, 'Worker project resolution failed closed');
      await this.host.updateWorkflowState(sessionId, 'idle');
      return `Worker was not started because its exact session project could not be resolved: ${reason}`;
    }

    const baseline = await this.prepareRecoveryBaseline(sessionId, project);
    if (!baseline.ok) {
      koryLog.warn({ sessionId, project: project.root }, 'Worker recovery baseline failed closed');
      await this.host.updateWorkflowState(sessionId, 'idle');
      return `Worker was not started. ${baseline.reason}`;
    }

    const domainOverride =
      domainHint && ['general', 'ui', 'backend', 'test', 'review'].includes(domainHint)
        ? (domainHint as WorkerDomain)
        : undefined;

    const taskId = nanoid(12);
    const routing = this.host.resolveActiveRouting(preferredModel, domainOverride || 'general');
    if (this.tasks) {
      await this.tasks.create({
        id: taskId,
        sessionId,
        description: task,
        domain: domainOverride || 'general',
        assignedModel: routing.model,
        assignedProvider: routing.provider || 'copilot',
      });
    }

    const workspaceManager = project.workspaceManager;
    let workerDir: string;
    try {
      if (!workspaceManager)
        throw new Error('Worktree isolation is unavailable or not initialized.');
      const worktree = await workspaceManager.spawn(taskId, task.slice(0, 60), sessionId);
      if (!worktree)
        throw new Error('An isolated worktree could not be created (unavailable or at capacity).');
      workerDir = await workspaceManager.validateWorktree(taskId, sessionId);
      if (workerDir === project.root || !this.isWithinProject(project.root, workerDir)) {
        throw new Error('Worker worktree does not belong to the resolved session project.');
      }
      koryLog.info({ taskId, path: workerDir }, 'Worker running in isolated worktree');
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      // A spawn can fail after registering a worktree. Cleanup is best effort;
      // unsafe or unrecoverable entries remain tracked for explicit recovery.
      try {
        await workspaceManager?.cleanup(taskId);
      } catch (cleanupError) {
        koryLog.warn(
          { taskId, err: String(cleanupError) },
          'Failed spawn cleanup retained for recovery',
        );
      }
      return this.finishPipeline(sessionId, taskId, {
        success: false,
        verification: 'unverified',
        criticFeedback: `Worker was not started because worktree isolation failed: ${reason}`,
      });
    }

    let result: WorkerPipelineResult;
    try {
      result = await this.routeToWorker(
        sessionId,
        task,
        preferredModel,
        reasoningLevel,
        [workerDir],
        domainOverride,
        taskId,
        project,
        true,
        normalizeSkillAssignment(skillAssignment),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      koryLog.warn({ taskId, err: message }, 'Worker execution failed safely');
      result = {
        success: false,
        verification: 'unverified',
        criticFeedback: `Worker execution failed: ${message}`,
      };
    }

    let worktreePaths: string[] = [];
    if (workspaceManager) {
      try {
        if (result.success) {
          if (typeof workspaceManager.getChangedFiles === 'function') {
            worktreePaths = await workspaceManager.getChangedFiles(taskId);
          }
          const reconcileResult = await workspaceManager.reconcile(taskId);
          if (reconcileResult.outcome === 'conflict') {
            // The user's checkout was never modified — the work is parked on its
            // branch and reported so it can be resolved or discarded explicitly.
            koryLog.warn(
              { taskId, recoveryBranch: reconcileResult.recoveryBranch },
              'Worker changes conflicted; destination untouched',
            );
            result = {
              success: false,
              verification: 'unverified',
              workerTranscript: result.workerTranscript,
              criticFeedback: reconcileResult.message,
            };
          } else if (!reconcileResult.success) {
            koryLog.warn({ taskId, msg: reconcileResult.message }, 'Worktree reconcile failed');
            result = {
              success: false,
              workerTranscript: result.workerTranscript,
              criticFeedback: `Worktree reconcile failed: ${reconcileResult.message}`,
            };
          } else {
            const destinationGate = await this.host.runDestinationChecks(sessionId, project.root);
            if (!destinationGate.passed) {
              result = {
                success: false,
                verification: 'unverified',
                workerTranscript: result.workerTranscript,
                criticFeedback: `Destination-tree verification failed after reconciliation:\n${destinationGate.output}`,
              };
              return await this.finishPipeline(sessionId, taskId, result);
            }
          }
        } else {
          // The worker failed. Discarding its worktree also destroyed whatever it
          // had written, so preserve it on the branch and surface it instead.
          await this.preserveIncompleteWork(workspaceManager, taskId);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        koryLog.warn({ taskId, err: message }, 'Worktree cleanup/reconcile error');
        if (result.success) {
          result = {
            ...result,
            success: false,
            criticFeedback: `Worktree reconcile failed safely: ${message}`,
          };
        }
      }
    }

    if (result.success) {
      result = await this.persistCompletionCheckpoint(
        sessionId,
        task,
        preferredModel,
        result,
        project,
        workerDir,
        worktreePaths,
      );
    }

    if (this.tasks) {
      await this.tasks.update(taskId, {
        status: result.success ? 'done' : 'failed',
        result: result.success ? result.criticFeedback || 'Done' : undefined,
        error: !result.success ? result.criticFeedback || 'Worker failed' : undefined,
      });
    }

    this.reportWorkerUsage(sessionId, result);
    await this.host.updateWorkflowState(sessionId, 'idle');

    if (result.success) {
      return (
        result.criticFeedback ??
        (result.workerTranscript ? 'Worker completed. See transcript.' : 'Done.')
      );
    }
    return result.workerTranscript
      ? `Worker did not pass review. ${result.criticFeedback ?? ''}`
      : (result.criticFeedback ?? 'Worker failed.');
  }

  /**
   * Preserve the output of a worker that did not pass review.
   *
   * The branch keeps every commit; the working copy is released so the
   * concurrency slot is reclaimed. Recorded as an `incomplete` resolution so
   * the work is discoverable instead of being destroyed with the worktree.
   * Nothing is merged — the work never passed review.
   */
  private async preserveIncompleteWork(manager: WorkspaceManager, taskId: string): Promise<void> {
    try {
      const abandoned = await manager.abandon(taskId);
      koryLog.info(
        { taskId, outcome: abandoned.outcome, recoveryBranch: abandoned.recoveryBranch },
        'Incomplete worker work handled',
      );
    } catch (err: unknown) {
      koryLog.warn({ taskId, err: String(err) }, 'Failed to preserve incomplete worker work');
    }
  }

  private reportWorkerUsage(sessionId: string, result: WorkerPipelineResult): void {
    try {
      if (!result.tokensIn && !result.tokensOut) return;
      this.host.recordWorkerUsage?.(sessionId, {
        provider: result.provider,
        model: result.model,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
      });
    } catch {
      // Usage accounting must never fail the worker result.
    }
  }

  private async finishPipeline(
    sessionId: string,
    taskId: string,
    result: WorkerPipelineResult,
  ): Promise<string> {
    if (this.tasks) {
      await this.tasks.update(taskId, {
        status: result.success ? 'done' : 'failed',
        result: result.success ? result.criticFeedback || 'Done' : undefined,
        error: !result.success ? result.criticFeedback || 'Worker failed' : undefined,
      });
    }
    this.reportWorkerUsage(sessionId, result);
    await this.host.updateWorkflowState(sessionId, 'idle');
    return result.success
      ? (result.criticFeedback ?? 'Done.')
      : result.workerTranscript
        ? `Worker did not pass review. ${result.criticFeedback ?? ''}`
        : (result.criticFeedback ?? 'Worker failed.');
  }

  private async _routeToWorker(
    sessionId: string,
    userMessage: string,
    preferredModel?: string,
    reasoningLevel?: string,
    allowedPaths: string[] = [],
    domainOverride?: WorkerDomain,
    taskId?: string,
    executionProject?: ProjectExecutionResources,
    recoveryBaselinePrepared = false,
    skillAssignment?: SkillAssignment,
  ): Promise<WorkerPipelineResult> {
    let domain: WorkerDomain;
    if (domainOverride) domain = domainOverride;
    else
      try {
        domain = this.classifyDomainLLM(userMessage);
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'LLM domain classification failed, defaulting to general',
        );
        domain = 'general';
      }

    // A worker's natural posture is confined: it holds a single worktree grant,
    // so kernel enforcement is what makes that grant real. This is independent
    // of approval — a YOLO chat still confines its workers, it just does not
    // prompt. Tasks that genuinely need host access are routed elsewhere.
    const isSandboxed = !this.requiresSystemAccess(userMessage);
    let project: ProjectExecutionResources;
    try {
      project = executionProject ?? (await this.resolveProjectResources(sessionId));
    } catch (err: unknown) {
      return {
        success: false,
        verification: 'unverified',
        criticFeedback: `Session project resolution failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    const workingDirectory = project.root;
    let effectivePaths: string[];
    try {
      if (!taskId || !project.workspaceManager) {
        throw new Error('A managed isolated worktree is required.');
      }
      const workerDirectory = await project.workspaceManager.validateWorktree(taskId, sessionId);
      effectivePaths = await Promise.all(
        allowedPaths.map((path, index) =>
          this.canonicalDirectory(path, `Worker filesystem grant ${index + 1}`),
        ),
      );
      if (
        effectivePaths.length !== 1 ||
        effectivePaths[0] !== workerDirectory ||
        workerDirectory === workingDirectory ||
        !this.isWithinProject(workingDirectory, workerDirectory)
      ) {
        throw new Error('Worker filesystem grants must match its isolated worktree.');
      }
    } catch (err: unknown) {
      return {
        success: false,
        verification: 'unverified',
        criticFeedback: `Worker isolation is unavailable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!recoveryBaselinePrepared) {
      const baseline = await this.prepareRecoveryBaseline(sessionId, project);
      if (!baseline.ok) {
        return {
          success: false,
          verification: 'unverified',
          criticFeedback: baseline.reason,
        };
      }
    }

    const immutableContract = createTaskContract(userMessage, {
      taskKind: undefined,
      scope: effectivePaths,
      constraints: isSandboxed ? ['Stay within the granted filesystem paths'] : [],
      skillAssignment,
    });
    const immutableObjective = `IMMUTABLE TASK CONTRACT:\n${JSON.stringify(immutableContract, null, 2)}`;
    let workerTask = immutableObjective;

    if (taskId && this.tasks) {
      await this.tasks.update(taskId, { status: 'active' });
    }

    let attempts = 0;
    const configuredPolicy = this.host.getQualityPolicy(workingDirectory, sessionId);
    const taskKind = classifyTask(userMessage, domain);
    const gateStrictness = resolveGateStrictness(taskKind, configuredPolicy.gateStrictness);
    // Read-only answer/research turns get a single worker attempt — a failed
    // review falls back to advisory reporting instead of forced retries.
    const maxAttempts = isReadOnlyTaskKind(taskKind)
      ? 1
      : Math.max(1, Math.min(10, configuredPolicy.maxCriticIterations));
    let failedReviews = 0;
    while (attempts < maxAttempts) {
      try {
        if (
          (await project.workspaceManager!.validateWorktree(taskId!, sessionId)) !==
          effectivePaths[0]
        ) {
          throw new Error('Worker worktree changed between attempts');
        }
      } catch (error) {
        return {
          success: false,
          verification: 'unverified',
          criticFeedback: `Worker isolation was lost: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      attempts++;
      this.host.emitThought(sessionId, 'delegating', `Delegating to ${domain} worker...`);
      const routing = this.host.resolveActiveRouting(
        preferredModel,
        domain,
        false,
        userMessage,
        undefined,
        workingDirectory,
      );
      const provider = this.providers.getAvailable().find((p) => p.name === routing.provider);
      if (!provider) {
        const alt = this.providers.getAvailable()[0];
        if (!alt) return { success: false };
        const res = await this.host.executeWithProvider(
          sessionId,
          alt,
          routing.model,
          workerTask,
          domain,
          reasoningLevel,
          true,
          effectivePaths,
          isSandboxed,
          immutableContract,
        );
        if (res.success) {
          if (gateStrictness === 'off') {
            return {
              success: true,
              provider: alt.name,
              model: routing.model,
              tokensIn: res.usage?.tokensIn,
              tokensOut: res.usage?.tokensOut,
              verification: 'unverified',
              workerTranscript: formatMessagesForCritic(res.workerMessages ?? []),
              criticFeedback: 'UNVERIFIED: Quality gates were disabled for this run.',
            };
          }
          const criticResult = await this.host.runCriticGate(
            sessionId,
            res.workerMessages,
            preferredModel,
            userMessage,
            effectivePaths[0],
            { provider: alt.name, model: routing.model },
            res.skillReviewContext ?? { taskContract: immutableContract },
          );
          if (criticResult.passed) {
            const harness = getProviderHarnessCapabilities(alt.name);
            return {
              success: true,
              provider: alt.name,
              model: routing.model,
              tokensIn: res.usage?.tokensIn,
              tokensOut: res.usage?.tokensOut,
              verification: harness.verificationEligible && !criticResult.skipped && criticResult.independent !== false ? 'verified' : 'unverified',
              workerTranscript: formatMessagesForCritic(res.workerMessages ?? []),
              criticFeedback: harness.verificationEligible
                ? criticResult.feedback
                : `UNVERIFIED: ${alt.name} completed the worker role without OS filesystem isolation.\n${criticResult.feedback ?? ''}`,
            };
          }
          failedReviews += 1;
          if (
            resolveGateStrictness(taskKind, configuredPolicy.gateStrictness, failedReviews) ===
            'advisory'
          ) {
            return {
              success: true,
              provider: alt.name,
              model: routing.model,
              tokensIn: res.usage?.tokensIn,
              tokensOut: res.usage?.tokensOut,
              verification: 'unverified',
              workerTranscript: formatMessagesForCritic(res.workerMessages ?? []),
              criticFeedback: `UNVERIFIED: Advisory gate findings:\n${criticResult.feedback ?? 'Review failed without structured findings.'}`,
            };
          }
          workerTask = `${immutableObjective}\n\nREVIEW FINDINGS FROM ATTEMPT ${attempts}:\n${criticResult.feedback ?? 'Critic rejected the attempt without valid findings.'}\n\nAddress the findings without changing or narrowing the original objective.`;
        } else return { success: false };
        continue;
      }

      const result = await this.host.executeWithProvider(
        sessionId,
        provider,
        routing.model,
        workerTask,
        domain,
        reasoningLevel,
        true,
        effectivePaths,
        isSandboxed,
        immutableContract,
      );
      if (result.success) {
        if (gateStrictness === 'off') {
          return {
            success: true,
            provider: provider.name,
            model: routing.model,
            tokensIn: result.usage?.tokensIn,
            tokensOut: result.usage?.tokensOut,
            verification: 'unverified',
            workerTranscript: formatMessagesForCritic(result.workerMessages ?? []),
            criticFeedback: 'UNVERIFIED: Quality gates were disabled for this run.',
          };
        }
        const criticResult = await this.host.runCriticGate(
          sessionId,
          result.workerMessages,
          preferredModel,
          userMessage,
          effectivePaths[0],
          { provider: provider.name, model: routing.model },
          result.skillReviewContext ?? { taskContract: immutableContract },
        );
        if (criticResult.passed) {
          const harness = getProviderHarnessCapabilities(provider.name);
          return {
            success: true,
            provider: provider.name,
            model: routing.model,
            tokensIn: result.usage?.tokensIn,
            tokensOut: result.usage?.tokensOut,
            verification: harness.verificationEligible && !criticResult.skipped && criticResult.independent !== false ? 'verified' : 'unverified',
            workerTranscript: formatMessagesForCritic(result.workerMessages ?? []),
            criticFeedback: harness.verificationEligible
              ? criticResult.feedback
              : `UNVERIFIED: ${provider.name} completed the worker role without OS filesystem isolation.\n${criticResult.feedback ?? ''}`,
          };
        }
        failedReviews += 1;
        if (
          resolveGateStrictness(taskKind, configuredPolicy.gateStrictness, failedReviews) ===
          'advisory'
        ) {
          return {
            success: true,
            provider: provider.name,
            model: routing.model,
            tokensIn: result.usage?.tokensIn,
            tokensOut: result.usage?.tokensOut,
            verification: 'unverified',
            workerTranscript: formatMessagesForCritic(result.workerMessages ?? []),
            criticFeedback: `UNVERIFIED: Advisory gate findings:\n${criticResult.feedback ?? 'Review failed without structured findings.'}`,
          };
        }
        workerTask = `${immutableObjective}\n\nREVIEW FINDINGS FROM ATTEMPT ${attempts}:\n${criticResult.feedback ?? 'Critic rejected the attempt without valid findings.'}\n\nAddress the findings without changing or narrowing the original objective.`;
        continue;
      }
      const quota = this.providers.isQuotaError(result.error);
      const retriable =
        typeof (this.providers as { isRetriableProviderError?: (e: unknown) => boolean })
          .isRetriableProviderError === 'function'
          ? (
              this.providers as { isRetriableProviderError: (e: unknown) => boolean }
            ).isRetriableProviderError(result.error)
          : false;
      if (!quota && !retriable) return { success: false };
    }
    return { success: false };
  }

  private classifyDomainLLM(message: string): WorkerDomain {
    const lower = message.toLowerCase();
    const scores: Record<string, number> = {};
    for (const [domain, keywords] of Object.entries(DOMAIN.KEYWORDS)) {
      scores[domain] = (keywords as readonly string[]).filter((k) => lower.includes(k)).length;
    }
    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    return (best && best[1] > 0 ? best[0] : 'general') as WorkerDomain;
  }

  private requiresSystemAccess(message: string): boolean {
    const lower = message.toLowerCase();
    const systemPatterns = [
      /\b(sudo|apt|apt-get|yum|dnf|pacman|brew)\b/,
      /\b(systemctl|service|journalctl)\b/,
      /\b(chmod|chown)\b.*\/(etc|var|usr|bin|sbin|boot|lib|sys|dev)/,
      /\/etc\//,
      /\/var\/log\//,
    ];
    return systemPatterns.some((p) => p.test(lower));
  }
}

export const createWorkerPipelineService = (deps: WorkerPipelineServiceDependencies) =>
  new WorkerPipelineService(deps);
