/**
 * WorkerPipelineService
 * Handles the worker task execution pipeline with worktree isolation.
 * Extracted from manager.ts runWorkerPipeline() and routeToWorker() methods.
 */

import type { ChangeSummary, ProviderName, WorkerDomain } from '@koryphaios/shared';
import { DOMAIN } from '../../constants';
import type { ProviderRegistry, Provider } from '../../providers';
import type { ProviderMessage } from '../../providers/types';
import { nanoid } from 'nanoid';
import { realpath, stat } from 'node:fs/promises';
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

// Keep the provider-native block form intact. Image/tool blocks are valid
// worker context and must not be narrowed to text merely to cross the service
// boundary back into KoryManager.
type InternalMessage = ProviderMessage;

/** Task kinds that mutate the repository and therefore cannot skip the
 *  completion-blocking critic review, regardless of user policy. */
const ALWAYS_STRICT: ReadonlySet<TaskKind> = new Set([
  'bug',
  'mechanical-edit',
  'refactor',
  'feature',
  'ui',
  'security-infra',
]);

/**
 * Resolve the effective gate strictness for a task kind given the user's
 * configured policy. Repository-mutating tasks are always strict; answer and
 * research tasks honor the user's setting.
 */
export function resolveGateStrictness(
  kind: TaskKind,
  configured: 'strict' | 'advisory' | 'off',
): 'strict' | 'advisory' | 'off' {
  if (ALWAYS_STRICT.has(kind)) return 'strict';
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
  getIsYoloMode(): boolean;
  getWorkingDirectory(): string;
  /** Resolve the project bound to this exact session, or reject if unavailable. */
  resolveSessionWorkingDirectoryPublic(sessionId: string): Promise<string>;
  getWorkerReasoningLevel(): string;
  getQualityPolicy(workingDirectory?: string): {
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
    usage?: { tokensIn: number; tokensOut: number };
  }>;
  runCriticGate(
    sessionId: string,
    workerMessages: InternalMessage[] | undefined,
    preferredModel?: string,
    task?: string,
    reviewDirectory?: string,
    producerIdentity?: { provider: ProviderName; model: string },
  ): Promise<{ passed: boolean; feedback?: string }>;
  runDestinationChecks(
    sessionId: string,
    workingDirectory: string,
  ): Promise<{ passed: boolean; output: string }>;
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

  constructor(deps: WorkerPipelineServiceDependencies) {
    this.providers = deps.providers;
    this.state = deps.state;
    this.git = deps.git;
    this.workspaceManager = deps.workspaceManager;
    this.snapshotManager = deps.snapshotManager;
    this.tasks = deps.tasks;
    this.host = deps.host;
    this.checkpointStoreFactory = deps.checkpointStoreFactory;
  }

  private async canonicalDirectory(path: string, label: string): Promise<string> {
    if (!path?.trim()) throw new Error(`${label} is empty`);
    const canonical = await realpath(resolve(path));
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
      const candidate = new WorkspaceManager(root);
      try {
        await candidate.init();
        workspaceManager = candidate;
      } catch (err: unknown) {
        koryLog.warn(
          { root, err: err instanceof Error ? err.message : String(err) },
          'Session project worktree isolation is unavailable; using that project directly',
        );
      }
    }
    return { root, git, workspaceManager, snapshotManager };
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
    let workerDir = project.root;
    let worktreeSpawned = false;
    if (workspaceManager) {
      try {
        const worktree = await workspaceManager.spawn(taskId, task.slice(0, 60), sessionId);
        if (worktree) {
          workerDir = worktree.path;
          worktreeSpawned = true;
          koryLog.info({ taskId, path: workerDir }, 'Worker running in isolated worktree');
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        koryLog.warn({ err: message }, 'Worktree spawn failed — using main directory');
      }
    } else {
      // WorkspaceManager is null — either git is unavailable, or init() hasn't
      // completed yet (async init in sync constructor). Warn so the user knows
      // parallel workers will share the main directory and may clobber each other.
      koryLog.warn(
        { taskId },
        'WorkspaceManager not ready — worker shares main directory (no isolation)',
      );
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
    if (worktreeSpawned && workspaceManager) {
      try {
        if (result.success) {
          if (typeof workspaceManager.getChangedFiles === 'function') {
            worktreePaths = await workspaceManager.getChangedFiles(taskId);
          }
          const reconcileResult = await workspaceManager.reconcile(taskId);
          if (!reconcileResult.success) {
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
          await workspaceManager.cleanup(taskId);
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

    await this.host.updateWorkflowState(sessionId, 'idle');

    if (result.success) {
      return (
        result.criticFeedback ??
        (result.workerTranscript ? 'Worker completed. See transcript.' : 'Done.')
      );
    }
    return result.workerTranscript
      ? `Worker did not pass review. ${result.criticFeedback ?? ''}`
      : 'Worker failed.';
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
    await this.host.updateWorkflowState(sessionId, 'idle');
    return result.success
      ? (result.criticFeedback ?? 'Done.')
      : result.workerTranscript
        ? `Worker did not pass review. ${result.criticFeedback ?? ''}`
        : 'Worker failed.';
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

    const isSandboxed = this.host.getIsYoloMode() ? false : !this.requiresSystemAccess(userMessage);
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
      effectivePaths = await Promise.all(
        (allowedPaths.length > 0 ? allowedPaths : [workingDirectory]).map((path, index) =>
          this.canonicalDirectory(path, `Worker filesystem grant ${index + 1}`),
        ),
      );
    } catch (err: unknown) {
      return {
        success: false,
        verification: 'unverified',
        criticFeedback: `Worker filesystem grant is unavailable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    if (effectivePaths.some((path) => !this.isWithinProject(workingDirectory, path))) {
      return {
        success: false,
        verification: 'unverified',
        criticFeedback: 'Worker filesystem grants escaped the resolved session project.',
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
    });
    const immutableObjective = `IMMUTABLE TASK CONTRACT:\n${JSON.stringify(immutableContract, null, 2)}`;
    let workerTask = immutableObjective;

    if (taskId && this.tasks) {
      await this.tasks.update(taskId, { status: 'active' });
    }

    let attempts = 0;
    const configuredPolicy = this.host.getQualityPolicy(workingDirectory);
    const gateStrictness = resolveGateStrictness(
      classifyTask(userMessage, domain),
      configuredPolicy.gateStrictness,
    );
    const maxAttempts = Math.max(1, Math.min(10, configuredPolicy.maxCriticIterations));
    while (attempts < maxAttempts) {
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
          );
          if (criticResult.passed) {
            const harness = getProviderHarnessCapabilities(alt.name);
            return {
              success: true,
              provider: alt.name,
              model: routing.model,
              tokensIn: res.usage?.tokensIn,
              tokensOut: res.usage?.tokensOut,
              verification: harness.verificationEligible ? 'verified' : 'unverified',
              workerTranscript: formatMessagesForCritic(res.workerMessages ?? []),
              criticFeedback: harness.verificationEligible
                ? criticResult.feedback
                : `UNVERIFIED: ${alt.name} completed the worker role without OS filesystem isolation.\n${criticResult.feedback ?? ''}`,
            };
          }
          if (gateStrictness === 'advisory') {
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
        );
        if (criticResult.passed) {
          const harness = getProviderHarnessCapabilities(provider.name);
          return {
            success: true,
            provider: provider.name,
            model: routing.model,
            tokensIn: result.usage?.tokensIn,
            tokensOut: result.usage?.tokensOut,
            verification: harness.verificationEligible ? 'verified' : 'unverified',
            workerTranscript: formatMessagesForCritic(result.workerMessages ?? []),
            criticFeedback: harness.verificationEligible
              ? criticResult.feedback
              : `UNVERIFIED: ${provider.name} completed the worker role without OS filesystem isolation.\n${criticResult.feedback ?? ''}`,
          };
        }
        if (gateStrictness === 'advisory') {
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
      }
      if (!this.providers.isQuotaError(result.error)) return { success: false };
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
