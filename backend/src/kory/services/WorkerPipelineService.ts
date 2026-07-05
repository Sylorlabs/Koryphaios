/**
 * WorkerPipelineService
 * Handles the worker task execution pipeline with worktree isolation.
 * Extracted from manager.ts runWorkerPipeline() and routeToWorker() methods.
 */

import type { ProviderName, WorkerDomain } from '@koryphaios/shared';
import { DOMAIN } from '../../constants';
import type { ProviderRegistry, Provider } from '../../providers';
import { nanoid } from 'nanoid';
import { koryLog } from '../../logger';
import type { SessionStateService } from './SessionStateService';
import type { GitManager } from '../git-manager';
import type { WorkspaceManager } from '../workspace-manager';
import type { SnapshotManager } from '../snapshot-manager';
import type { ITaskStore } from '../../stores/task-store';
import { formatMessagesForCritic } from '../critic-util';

interface InternalMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
}

interface WorkerPipelineResult {
  success: boolean;
  workerTranscript?: string;
  criticFeedback?: string;
}

export interface WorkerPipelineConfig {
  getIsYoloMode: () => boolean;
  getWorkingDirectory: () => string;
  getWorkerReasoningLevel: () => string;
  waitForUserInput: (sessionId: string, question: string, options: string[]) => Promise<string>;
  emitThought: (sessionId: string, phase: string, thought: string) => void;
  updateWorkflowState: (sessionId: string, state: string) => Promise<void>;
  handleAutoCommit: (sessionId: string, taskDescription: string) => Promise<void>;
  resolveActiveRouting: (
    preferredModel?: string,
    domain?: WorkerDomain,
    avoidLegacy?: boolean,
    prompt?: string,
    preferCheap?: boolean,
  ) => { model: string; provider: ProviderName | undefined };
  executeWithProvider: (
    sessionId: string,
    provider: Provider,
    modelId: string,
    userMessage: string,
    domain: WorkerDomain,
    reasoningLevel: string | undefined,
    isAutoMode: boolean,
    allowedPaths: string[],
    isSandboxed: boolean,
  ) => Promise<{ success: boolean; error?: string; workerMessages?: InternalMessage[] }>;
  runCriticGate: (
    sessionId: string,
    workerMessages: InternalMessage[] | undefined,
    preferredModel?: string,
    task?: string,
  ) => Promise<{ passed: boolean; feedback?: string }>;
}

export interface WorkerPipelineServiceDependencies {
  providers: ProviderRegistry;
  state: SessionStateService;
  git: GitManager;
  workspaceManager: WorkspaceManager | null;
  snapshotManager: SnapshotManager;
  tasks?: ITaskStore;
  config: WorkerPipelineConfig;
}

export class WorkerPipelineService {
  private providers: ProviderRegistry;
  private state: SessionStateService;
  private git: GitManager;
  workspaceManager: WorkspaceManager | null;
  private snapshotManager: SnapshotManager;
  private tasks?: ITaskStore;
  private config: WorkerPipelineConfig;

  constructor(deps: WorkerPipelineServiceDependencies) {
    this.providers = deps.providers;
    this.state = deps.state;
    this.git = deps.git;
    this.workspaceManager = deps.workspaceManager;
    this.snapshotManager = deps.snapshotManager;
    this.tasks = deps.tasks;
    this.config = deps.config;
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
    if (!this.config.getIsYoloMode()) {
      const selection = await this.config.waitForUserInput(
        sessionId,
        'Ready to proceed with the delegated task?',
        ['Yes, proceed', 'Cancel'],
      );
      if (selection === '__timeout__') return 'Timed out waiting for user response.';
      if (selection.includes('Cancel')) return 'Cancelled by user.';
    } else {
      this.config.emitThought(sessionId, 'executing', 'YOLO mode: Proceeding with delegated task.');
    }

    await this.config.updateWorkflowState(sessionId, 'executing');

    const domainOverride =
      domainHint && ['general', 'ui', 'backend', 'test', 'review'].includes(domainHint)
        ? (domainHint as WorkerDomain)
        : undefined;

    const taskId = nanoid(12);
    const routing = this.config.resolveActiveRouting(preferredModel, domainOverride || 'general');
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

    let workerDir = this.config.getWorkingDirectory();
    let worktreeSpawned = false;
    if (this.workspaceManager) {
      try {
        const worktree = this.workspaceManager.spawn(taskId, task.slice(0, 60));
        if (worktree) {
          workerDir = worktree.path;
          worktreeSpawned = true;
          koryLog.info({ taskId, path: workerDir }, 'Worker running in isolated worktree');
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        koryLog.warn({ err: message }, 'Worktree spawn failed — using main directory');
      }
    }

    let result = await this.routeToWorker(
      sessionId,
      task,
      preferredModel,
      reasoningLevel,
      [workerDir],
      domainOverride,
      taskId,
    );

    if (worktreeSpawned && this.workspaceManager) {
      try {
        if (result.success) {
          const reconcileResult = this.workspaceManager.reconcile(taskId);
          if (!reconcileResult.success) {
            koryLog.warn({ taskId, msg: reconcileResult.message }, 'Worktree reconcile failed');
            result = {
              success: false,
              workerTranscript: result.workerTranscript,
              criticFeedback: `Worktree reconcile failed: ${reconcileResult.message}`,
            };
          } else {
            try {
              const { ShadowLogger } = await import('../shadow-logger');
              const shadowLogger = new ShadowLogger(this.config.getWorkingDirectory());
              await shadowLogger.createGhostCommit(task.slice(0, 72), {
                agentId: sessionId,
                model: preferredModel ?? 'unknown',
                prompt: task.slice(0, 200),
                cost: 0,
              });
            } catch {
              // Shadow logging is non-critical; don't fail the task if it errors
            }

            await this.config.handleAutoCommit(sessionId, task);
          }
        } else {
          this.workspaceManager.cleanup(taskId);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        koryLog.warn({ taskId, err: message }, 'Worktree cleanup/reconcile error');
      }
    } else if (result.success) {
      await this.config.handleAutoCommit(sessionId, task);
    }

    if (this.tasks) {
      await this.tasks.update(taskId, {
        status: result.success ? 'done' : 'failed',
        result: result.success ? result.criticFeedback || 'Done' : undefined,
        error: !result.success ? result.criticFeedback || 'Worker failed' : undefined,
      });
    }

    await this.config.updateWorkflowState(sessionId, 'idle');

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

  private async _routeToWorker(
    sessionId: string,
    userMessage: string,
    preferredModel?: string,
    reasoningLevel?: string,
    allowedPaths: string[] = [],
    domainOverride?: WorkerDomain,
    taskId?: string,
  ): Promise<WorkerPipelineResult> {
    let domain: WorkerDomain;
    if (domainOverride) domain = domainOverride;
    else
      try {
        domain = this.classifyDomainLLM(userMessage);
      } catch {
        domain = 'general';
      }

    const isSandboxed = this.config.getIsYoloMode()
      ? false
      : !this.requiresSystemAccess(userMessage);
    const workingDirectory = this.config.getWorkingDirectory();
    const effectivePaths = allowedPaths.length > 0 ? allowedPaths : [workingDirectory];

    if (this.git.isGitRepo()) {
      const hash = await this.git.getCurrentHash();
      if (hash) this.state.saveCheckpoint(sessionId, hash);
    } else {
      await this.snapshotManager.createSnapshot(
        sessionId,
        'latest',
        effectivePaths,
        workingDirectory,
      );
    }

    let workerTask = await this.generateWorkerTask(sessionId, userMessage, domain, preferredModel);

    if (taskId && this.tasks) {
      await this.tasks.update(taskId, { status: 'active' });
    }

    let attempts = 0;
    while (attempts < 3) {
      attempts++;
      this.config.emitThought(sessionId, 'delegating', `Delegating to ${domain} worker...`);
      const routing = this.config.resolveActiveRouting(preferredModel, domain);
      const provider = this.providers.getAvailable().find((p) => p.name === routing.provider);
      if (!provider) {
        const alt = this.providers.getAvailable()[0];
        if (!alt) return { success: false };
        const res = await this.config.executeWithProvider(
          sessionId,
          alt,
          routing.model,
          workerTask,
          domain,
          reasoningLevel,
          true,
          effectivePaths,
          isSandboxed,
        );
        if (res.success) {
          const criticResult = await this.config.runCriticGate(
            sessionId,
            res.workerMessages,
            preferredModel,
            workerTask,
          );
          if (criticResult.passed) {
            return {
              success: true,
              workerTranscript: formatMessagesForCritic(res.workerMessages ?? []),
              criticFeedback: criticResult.feedback,
            };
          }
          workerTask = `QUALITY FAILURE. Fix these:\n${criticResult.feedback}`;
        } else return { success: false };
        continue;
      }

      const result = await this.config.executeWithProvider(
        sessionId,
        provider,
        routing.model,
        workerTask,
        domain,
        reasoningLevel,
        true,
        effectivePaths,
        isSandboxed,
      );
      if (result.success) {
        const criticResult = await this.config.runCriticGate(
          sessionId,
          result.workerMessages,
          preferredModel,
          workerTask,
        );
        if (criticResult.passed) {
          return {
            success: true,
            workerTranscript: formatMessagesForCritic(result.workerMessages ?? []),
            criticFeedback: criticResult.feedback,
          };
        }
        workerTask = `QUALITY FAILURE. Fix these:\n${criticResult.feedback}`;
      }
      if (!this.providers.isQuotaError(result.error)) return { success: false };
    }
    return { success: false };
  }

  private async generateWorkerTask(
    sessionId: string,
    message: string,
    domain: WorkerDomain,
    preferredModel?: string,
  ): Promise<string> {
    const routing = this.config.resolveActiveRouting(preferredModel, 'general', true);
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider) return message;

    let res = '';
    try {
      for await (const event of provider.streamResponse({
        model: routing.model,
        systemPrompt: 'Be brief and actionable.',
        messages: [{ role: 'user', content: `Worker instruction for ${domain}: ${message}` }],
        maxTokens: 200,
      })) {
        if (event.type === 'content_delta') res += event.content;
      }
      return res.trim() || message;
    } catch {
      return message;
    }
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