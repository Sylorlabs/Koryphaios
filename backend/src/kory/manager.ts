// Kory Manager Agent — the orchestrator brain.
// The manager is the only agent the user talks to. Sub-agents (workers) run only when the manager
// explicitly calls the delegate_to_worker tool; the code never auto-spawns workers.

import type {
  AgentIdentity,
  AgentStatus,
  WorkerDomain,
  WSMessage,
  ProviderName,
  KoryphaiosConfig,
  KoryAskUserPayload,
  KoryQuestionPresentation,
  KoryQuestionChart,
  KoryQuestionSlider,
  ChangeSummary,
  StreamUsagePayload,
  StreamThinkingPayload,
  ContextBreakdown,
} from '@koryphaios/shared';
import { SANDBOX_PRESETS } from '@koryphaios/shared';
import { normalizeReasoningLevel, determineAutoReasoningLevel } from '@koryphaios/shared';
import { AGENT, DOMAIN, SESSION } from '../constants';
import {
  ProviderRegistry,
  resolveModel,
  resolveTrustedContextWindow,
  isLegacyModel,
  getNonLegacyModels,
  withTimeoutSignal,
  type StreamRequest,
  type ProviderEvent,
  type Provider,
} from '../providers';
import type { ProviderMessage } from '../providers/types';
import { detectJulesApiKey } from '../providers/auth-utils';
import { runJulesTask } from '../providers/jules-runner';
import { JULES_SYNC_INSTRUCTIONS, getProviderDisplay } from '../providers/provider-display';
import { markCliConversationRewritten } from '../providers/cli-session-state';
import { getSessionRuntimeStateService } from './services/SessionRuntimeStateService';
import {
  ToolRegistry,
  type FileChangeProposal,
  type ToolCallInput,
  type ToolContext,
  type ToolCallOutput,
} from '../tools';
import { wsBroker } from '../pubsub';
import { koryLog } from '../logger';
import { initContextArchive, getContextArchive } from './context-archive';
import { nanoid } from 'nanoid';
import { defenseInDepthPromptSanitizer } from '../security';
import {
  checkNoteToolPermission,
  filterToolDefsForNotesPermissions,
  buildNotesNetworkSystemHint,
  hasAnyVisibleNoteTools,
  formatNoteToolApprovalSummary,
} from '../notes/notes-settings';
import { isNoteToolName } from '@koryphaios/shared';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { join } from 'node:path';
import { db, sessions } from '../db';
import { eq } from 'drizzle-orm';
import type { ISessionStore } from '../stores/session-store';
import type { IMessageStore } from '../stores/message-store';
import type { ITaskStore } from '../stores/task-store';
import { SnapshotManager } from './snapshot-manager';
import { processSupervisor } from '../process-supervisor/supervisor';
import { GitManager } from './git-manager';
import { WorkspaceManager } from './workspace-manager';
import {
  EventEmitterService,
  WorkerLifecycleService,
  SessionStateService,
  WorkerPipelineService,
} from './services';
import type { WorkflowHook, WorkflowHookEvent } from './services/EventEmitterService';
import { TimeTravelService } from '../services';
import { computeCostUsd } from '../pricing';
import { RoutingServiceEnhanced } from './services/RoutingServiceEnhanced';
import {
  deriveCriticBudget,
  deriveSkillEvidenceCriteria,
  parseCriticVerdict,
  formatMessagesForCritic as formatMessagesForCriticUtil,
} from './critic-util';
import { getModeManager } from '../mode';
import type { WorkerPipelineConfig } from './services/WorkerPipelineService';
import type { UIMode } from '@koryphaios/shared';
import { compilePrompt, createTaskContract, requiresMultiAgentDelegation } from './prompts';
import { discoverVerificationChecks, emptyQualityGateReport } from './verification';
import {
  getProviderHarnessCapabilities,
  supportsKoryControlPlaneTools,
} from '../providers/provider-harness';
import { buildIntentDiscoveryBatch } from './clarification-gate';
import { collaborationManager } from '../collaboration/manager';
import {
  assembleAgentContext,
  loadAgentSettings,
  rememberExplicitPreference,
  saveAgentSettings,
} from '../agent-settings';
import { assembleMemoryContext, formatMemoryForContext } from '../memory/unified-memory';
import { readSessionMemory, writeSessionMemory } from '../memory/unified-memory';
import {
  answerPendingQuestion,
  createPendingQuestion,
  getPendingQuestion,
} from '../stores/pending-question-store';
import { ensurePlanNote, syncPlanNote } from './plan-mode';
import { resolveSkills } from './skills';
import { rankHarnessCandidates, type QualificationRole } from './skill-qualifications';
import {
  setCollaborationToolPolicy,
  clearCollaborationToolPolicy,
  type CollaborationToolPolicy,
} from '../collaboration/tool-policy';

// ─── Internal Types ─────────────────────────────────────────────────────────

interface CompletedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface InternalMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string | import('../providers/types').ProviderContentBlock[];
  tool_call_id?: string;
  tool_calls?: CompletedToolCall[];
}

interface LLMTurnResult {
  success: boolean;
  content?: string;
  usage?: { tokensIn: number; tokensOut: number };
  completedToolCalls?: CompletedToolCall[];
  /** A native CLI harness performed work, even though it did not request a Kory tool call. */
  observedNativeTool?: boolean;
}

export interface AgentThreadEntry {
  id: string;
  role: 'manager' | 'user' | 'assistant';
  content: string;
  createdAt: number;
}

interface AgentThreadState {
  sessionId: string;
  identity: AgentIdentity;
  kind: 'worker' | 'critic';
  status: AgentStatus;
  providerName: ProviderName;
  modelId: string;
  systemPrompt: string;
  promptManifestHash: string;
  taskContractHash: string;
  toolRole: 'worker' | 'critic';
  reasoningLevel?: string;
  maxTurns: number;
  maxTokens: number;
  messages: InternalMessage[];
  threadEntries: AgentThreadEntry[];
  ctx: ToolContext;
  abort?: AbortController;
  busy: boolean;
  updatedAt: number;
}

// Agent threads contain complete prompts, provider replies, and tool results.
// They are useful while a user is inspecting or continuing an agent, but must
// never become an unbounded process-lifetime transcript store. Persistent chat
// history belongs in the session/message stores, not this live UI cache.
const AGENT_THREAD_IDLE_TTL_MS = 30 * 60 * 1000;
const MAX_COMPLETED_AGENT_THREADS_PER_SESSION = 24;

function normalizeQuestionPresentation(
  presentation?: KoryQuestionPresentation,
): Required<Pick<KoryQuestionPresentation, 'allowKeepChatting'>> &
  Pick<KoryQuestionPresentation, 'chart' | 'sliders'> {
  const normalized: {
    allowKeepChatting: boolean;
    chart?: KoryQuestionChart;
    sliders?: KoryQuestionSlider[];
  } = {
    allowKeepChatting: true,
  };

  const chart = presentation?.chart;
  if (chart && ['bar', 'line', 'pie'].includes(chart.type) && Array.isArray(chart.labels)) {
    const labels = chart.labels.map(String).map((label) => label.slice(0, 80)).slice(0, 24);
    const datasets = Array.isArray(chart.datasets)
      ? chart.datasets.slice(0, 6).flatMap((dataset) => {
          if (!dataset || !Array.isArray(dataset.data)) return [];
          const data = dataset.data
            .slice(0, labels.length)
            .map(Number)
            .filter((value) => Number.isFinite(value));
          if (data.length !== labels.length || data.length === 0) return [];
          return [{ label: dataset.label ? String(dataset.label).slice(0, 80) : undefined, data }];
        })
      : [];
    if (labels.length > 0 && datasets.length > 0) {
      normalized.chart = {
        type: chart.type,
        title: chart.title ? String(chart.title).slice(0, 160) : undefined,
        labels,
        datasets,
      };
    }
  }

  if (Array.isArray(presentation?.sliders)) {
    const sliders = presentation.sliders.slice(0, 6).flatMap((slider, index) => {
      const min = Number(slider?.min);
      const max = Number(slider?.max);
      const step = Number(slider?.step);
      const initial = Number(slider?.value);
      if (![min, max, step, initial].every(Number.isFinite) || max <= min || step <= 0) return [];
      return [{
        id: String(slider.id || `value-${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64),
        label: String(slider.label || `Value ${index + 1}`).slice(0, 120),
        min,
        max,
        step,
        value: Math.min(max, Math.max(min, initial)),
        unit: slider.unit ? String(slider.unit).slice(0, 24) : undefined,
        description: slider.description ? String(slider.description).slice(0, 240) : undefined,
      }];
    });
    if (sliders.length > 0) normalized.sliders = sliders;
  }

  return normalized;
}

// ─── Default Model Assignments per Domain ───────────────────────────────────

for (const [domain, modelId] of Object.entries(DOMAIN.DEFAULT_MODELS)) {
  const def = resolveModel(modelId);
  if (!def) {
    throw new Error(`DOMAIN.DEFAULT_MODELS["${domain}"] references unknown model: "${modelId}".`);
  }
}

// ─── Clarification Gate ─────────────────────────────────────────────────────

// ─── Kory Identity ──────────────────────────────────────────────────────────

let KORY_IDENTITY: AgentIdentity = {
  id: 'kory-manager',
  name: 'Kory',
  role: 'manager',
  model: 'pending',
  provider: 'copilot',
  domain: 'general',
  glowColor: 'rgba(255,215,0,0.6)', // Gold
};

function koryIdentityWithModel(model: string, provider: ProviderName): AgentIdentity {
  KORY_IDENTITY = { ...KORY_IDENTITY, model, provider };
  return KORY_IDENTITY;
}

// ─── System Prompts ──────────────────────────────────────────────────────────

/** Parse a JSON string into an object, tolerating malformed input (returns {}). */
function safeParseJson(s?: string): Record<string, unknown> {
  if (!s) return {};
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ─── Kory Manager Class ─────────────────────────────────────────────────────

export interface KoryTask {
  id: string;
  description: string;
  domain: WorkerDomain;
  assignedModel: string;
  assignedProvider: ProviderName;
  status: 'pending' | 'active' | 'done' | 'failed';
  result?: string;
  error?: string;
}

export class KoryManager {
  private memoryDir: string;
  private readonly sessionState = getSessionRuntimeStateService();
  private isYoloMode = false;
  private snapshotManager: SnapshotManager;
  public readonly git: GitManager;
  private workspaceManager: WorkspaceManager | null = null;
  /** AbortController for the current manager run per session (so cancelSessionWorkers can abort manager too). */
  private managerAbortBySession = new Map<string, AbortController>();
  /** Tracks whether the compaction flow successfully wrote a summary.
   *  This is a result flag, not a state — the state machine lives in
   *  SessionStateService. Cleared in the compactSession finally block. */
  private compactionSucceeded = new Map<string, boolean>();
  /** In-memory worker/critic chat threads keyed by agentId. */
  private agentThreads = new Map<string, AgentThreadState>();
  /** Services */
  private events: EventEmitterService;
  private routing: RoutingServiceEnhanced;
  private workers: WorkerLifecycleService;
  private state: SessionStateService;
  private workerPipeline: WorkerPipelineService;
  /** Sessions whose title has already been auto-generated. Prevents racing
   *  LLM calls when the user sends a second message before the first title
   *  resolves. */
  private titledSessions = new Set<string>();
  /** Last visible prompt manifest per session; prevents repeated disclosure on tool-loop turns. */
  private promptManifestHashBySession = new Map<string, string>();
  /** Collision choices persist per project and are reused by task workers/critics. */
  private skillCollisionChoicesBySession = new Map<
    string,
    Record<string, 'personal' | 'project'>
  >();
  /** User-selected manager identity, used only to enforce role independence. */
  private managerRoutingBySession = new Map<
    string,
    { model: string; provider: ProviderName | undefined }
  >();
  /** A CLI mutation invalidates this latch until deterministic checks and a critic pass. */
  private cliMutationVerifiedBySession = new Map<string, boolean>();
  /** Goal state is immutable task context, not a conversational suggestion. */
  private goalContextBySession = new Map<
    string,
    NonNullable<import('./prompts').TaskContract['goalContext']>
  >();

  /** Extend lifecycle policy without embedding provider-specific behavior in prompts. */
  public registerWorkflowHook(event: WorkflowHookEvent, hook: WorkflowHook): () => void {
    return this.events.registerWorkflowHook(event, hook);
  }

  constructor(
    private providers: ProviderRegistry,
    private tools: ToolRegistry,
    private workingDirectory: string,
    private config: KoryphaiosConfig,
    private sessions?: ISessionStore,
    private messages?: IMessageStore,
    private tasks?: ITaskStore,
    private timeTravel?: TimeTravelService,
  ) {
    this.memoryDir = join(workingDirectory, '.koryphaios/memory');
    mkdirSync(this.memoryDir, { recursive: true });
    this.snapshotManager = new SnapshotManager(workingDirectory);
    this.git = new GitManager(workingDirectory);
    initContextArchive(workingDirectory);

    // Initialize WorkspaceManager if git is available
    try {
      if (this.git.isGitRepo()) {
        this.workspaceManager = new WorkspaceManager(workingDirectory, config.workspace);
        koryLog.info('WorkspaceManager initialized for parallel agent isolation');
      }
    } catch {
      koryLog.warn('WorkspaceManager unavailable — workers will share the main directory');
    }

    // Initialize services
    this.events = new EventEmitterService({ managerAgentId: KORY_IDENTITY.id });
    this.routing = new RoutingServiceEnhanced({ config: this.config, providers: this.providers });
    this.workers = new WorkerLifecycleService({ events: this.events });
    this.state = new SessionStateService();

    // Background terminals: surface start/exit in the chat feed and wake the
    // agent when a process it was waiting on finishes.
    processSupervisor.onLifecycle((e) => {
      if (!e.sessionId) return;
      this.emitWSMessage(e.sessionId, e.type === 'started' ? 'process.started' : 'process.exited', {
        id: e.id,
        name: e.name,
        command: e.command,
        pid: e.pid,
        exitCode: e.exitCode,
        status: e.status,
        willRestart: e.willRestart,
        logsTail: e.logsTail,
      });
      if (
        e.type === 'exited' &&
        e.status !== 'killed' &&
        !e.willRestart &&
        !this.isSessionRunning(e.sessionId)
      ) {
        // The manager's turn already ended (button shows "Waiting…") — wake it
        // with the outcome so it can react or report back to the user.
        const summary =
          `[background terminal] Process "${e.name}" (${e.command.slice(0, 120)}) ` +
          `${e.status} with exit code ${e.exitCode ?? 'unknown'}.` +
          (e.logsTail ? `\nRecent output:\n${e.logsTail}` : '') +
          `\nReview the result (shell_manage logs id=${e.id} for full output), fix anything broken, or summarize for the user.`;
        this.emitWSMessage(e.sessionId, 'agent.status', {
          agentId: KORY_IDENTITY.id,
          status: 'thinking',
        });
        void this.handleDirectly(e.sessionId, summary, undefined, undefined).catch((err) =>
          koryLog.warn({ err, sessionId: e.sessionId }, 'Background-process wake-up failed'),
        );
      }
    });

    const pipelineConfig: WorkerPipelineConfig = {
      getIsYoloMode: () => this.isYoloMode,
      getWorkingDirectory: () => this.workingDirectory,
      getWorkerReasoningLevel: () => this.getWorkerReasoningLevel(),
      getQualityPolicy: () => {
        const settings = loadAgentSettings(this.workingDirectory);
        return {
          gateStrictness: settings.criticGateEnabled
            ? (settings.gateStrictness ?? 'strict')
            : 'off',
          maxCriticIterations: settings.maxCriticIterations,
        };
      },
      waitForUserInput: (sessionId, question, options) =>
        this.waitForUserInputInternal(sessionId, question, options),
      emitThought: (sessionId, phase, thought) => this.emitThought(sessionId, phase, thought),
      updateWorkflowState: (sessionId, state) => this.updateWorkflowState(sessionId, state),
      resolveActiveRouting: (preferredModel, domain, avoidLegacy, prompt, preferCheap) =>
        this.resolveActiveRouting(preferredModel, domain, avoidLegacy, prompt, preferCheap),
      executeWithProvider: (
        sessionId,
        provider,
        modelId,
        userMessage,
        domain,
        reasoningLevel,
        isAutoMode,
        allowedPaths,
        isSandboxed,
        taskContract,
      ) =>
        this.executeWithProvider(
          sessionId,
          provider,
          modelId,
          userMessage,
          domain,
          reasoningLevel,
          isAutoMode,
          allowedPaths,
          isSandboxed,
          taskContract,
        ),
      runCriticGate: (sessionId, workerMessages, preferredModel, task, reviewDirectory) =>
        this.runCriticGate(sessionId, workerMessages, preferredModel, task, reviewDirectory),
      runDestinationChecks: (sessionId, workingDirectory) =>
        this.runHardChecks(sessionId, workingDirectory),
    };

    this.workerPipeline = new WorkerPipelineService({
      providers: this.providers,
      state: this.state,
      git: this.git,
      workspaceManager: this.workspaceManager,
      snapshotManager: this.snapshotManager,
      tasks: this.tasks,
      config: pipelineConfig,
    });

    // Recover state from persistent stores
    this.recoverState();
  }

  private async recoverState() {
    if (!this.tasks) return;
    try {
      const activeTasks = await this.tasks.listActive();
      if (activeTasks.length > 0) {
        koryLog.info({ count: activeTasks.length }, 'Recovered active tasks from store');
        // Note: We can't easily resume the LLM turns, but we mark them as failed
        // if they were active, so the user knows they were interrupted.
        for (const task of activeTasks) {
          if (task.status === 'active') {
            await this.tasks.update(task.id, {
              status: 'failed',
              error: 'Process interrupted (server restart)',
            });
          }
        }
      }
    } catch (err) {
      koryLog.warn({ err }, 'Failed to recover tasks from store');
    }
  }

  setYoloMode(enabled: boolean) {
    this.isYoloMode = enabled;
    koryLog.info({ enabled }, 'YOLO mode state updated');
  }

  /** Reasoning level the manager uses for delegated workers (from config). */
  private getWorkerReasoningLevel(): string {
    return (
      (this.config.agents?.manager as { reasoningLevel?: string } | undefined)?.reasoningLevel ??
      AGENT.DEFAULT_REASONING_LEVEL
    );
  }

  private async extractAllowedPaths(
    sessionId: string,
    plan: string,
    preferredModel?: string,
  ): Promise<string[]> {
    const routing = this.resolveActiveRouting(preferredModel, 'general', true);
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider) return [];

    const prompt = `Identify paths to modify or read. PLAN: ${plan}. Return ONLY JSON array.`;
    let result = '';
    try {
      const stream = provider.streamResponse({
        model: routing.model,
        systemPrompt: 'JSON only.',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 300,
      });
      for await (const event of stream)
        if (event.type === 'content_delta') result += event.content ?? '';
      return JSON.parse(result.trim().match(/\[.*\]/s)?.[0] || '[]');
    } catch {
      return [];
    }
  }

  private async updateWorkflowState(sessionId: string, state: string) {
    // Route through the SessionStateService for transition validation and
    // in-memory cache sync. Legacy callers pass string states; cast to the
    // union type. Unknown states are passed through as-is (the service logs
    // a warning for invalid transitions but does not throw).
    await this.sessionState.transition(sessionId, state as 'idle' | 'processing' | 'compacting' | 'waiting' | 'error' | 'paused');
  }

  /**
   * Build and atomically install a new conversation root. The compactor uses a
   * unique provider session id, so CLI/API continuation caches cannot inherit
   * the manager's prior context.
   */
  async compactSession(input: {
    sessionId: string;
    selectedModel: string;
    reasoningLevel?: string;
    automatic?: boolean;
  }): Promise<{ compactionId: string; sourceMessages: number; checkpointTokens: number }> {
    if (!this.messages) throw new Error('Message store unavailable');
    if (this.isSessionRunning(input.sessionId) || this.compactingSessions.has(input.sessionId)) {
      throw new Error('This session is already running');
    }
    const separator = input.selectedModel.indexOf(':');
    if (separator < 1) throw new Error('Select a model before compacting');
    const providerName = input.selectedModel.slice(0, separator) as ProviderName;
    const model = input.selectedModel.slice(separator + 1);
    const status = this.providers.getStatus().find((item) => item.name === providerName);
    if (!status?.authenticated || !status.models.includes(model)) {
      throw new Error('The selected model is no longer available. Select another model.');
    }
    const provider = await this.providers.resolveProvider(model, providerName);
    if (!provider) throw new Error('The selected model provider is unavailable');

    const compactionId = nanoid(12);
    const automatic = input.automatic === true;
    const abort = new AbortController();
    this.compactingSessions.set(input.sessionId, abort);
    const emit = (
      phase: 'preparing' | 'summarizing' | 'validating' | 'committing' | 'complete' | 'failed',
      progress: number,
      message: string,
      extra: Record<string, unknown> = {},
    ) =>
      this.emitWSMessage(
        input.sessionId,
        phase === 'preparing'
          ? 'compaction.started'
          : phase === 'complete'
            ? 'compaction.completed'
            : phase === 'failed'
              ? 'compaction.failed'
              : 'compaction.progress',
        {
          compactionId,
          sessionId: input.sessionId,
          phase,
          progress,
          provider: providerName,
          model,
          automatic,
          message,
          ...extra,
        },
      );

    await this.updateWorkflowState(input.sessionId, 'compacting');
    try {
      emit('preparing', 10, 'Preparing the current conversation revision');
      const source = await this.messages.getContextMessages(input.sessionId, 1000);
      const conversational = source.filter(
        (message) => message.role !== 'system' || message.content.startsWith('[KORY_COMPACTION]'),
      );
      if (conversational.length < 2) throw new Error('There is not enough conversation to compact');
      const transcript = conversational
        .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
        .join('\n\n');
      const sourceTokens = Math.ceil(transcript.length / 4);
      emit('summarizing', 30, 'Summarizing with a fresh selected-model context', {
        sourceMessages: conversational.length,
        sourceTokens,
      });

      const projectRoot = await this.resolveSessionWorkingDirectory(input.sessionId);
      const priorMemory = readSessionMemory(projectRoot, input.sessionId).content;
      const prompt = `Return one JSON object and nothing else. Preserve concrete truth; never invent completion or verification.\n\nRequired keys:\nprojectBrief (string)\ndecisions (string[])\nfilesAndCodeState (string[])\ncompletedWork (string[])\nactiveWork (string[])\nopenIssues (string[])\nnextActions (string[])\ncriticalContext (string[])\nconfidenceAndRisk (string)\ndurableMemory (string)\n\nEXISTING SESSION MEMORY:\n${priorMemory || '[none]'}\n\nTRANSCRIPT TO COMPACT:\n${transcript}`;
      let raw = '';
      let tokensIn = sourceTokens;
      let tokensOut = 0;
      const stream = provider.streamResponse({
        model,
        systemPrompt:
          'You are a loss-averse conversation compactor. Produce valid JSON only. This is a fresh, read-only context boundary.',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 8192,
        reasoningLevel: input.reasoningLevel,
        signal: abort.signal,
        workingDirectory: projectRoot,
        sessionId: `${input.sessionId}:compaction:${compactionId}`,
        harnessRole: 'manager',
        sandbox: SANDBOX_PRESETS.readonly,
      });
      for await (const event of stream) {
        if (event.type === 'error') throw new Error(event.error ?? 'Compaction model failed');
        if (event.type === 'content_delta') raw += event.content ?? '';
        if (event.type === 'usage_update') {
          tokensIn = Math.max(tokensIn, (event.tokensIn ?? 0) + (event.tokensCache ?? 0));
          tokensOut = Math.max(tokensOut, event.tokensOut ?? 0);
        }
      }

      emit('validating', 75, 'Validating the continuation checkpoint', {
        sourceMessages: conversational.length,
        sourceTokens,
      });
      const jsonText = raw
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '');
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      const requiredArrays = [
        'decisions',
        'filesAndCodeState',
        'completedWork',
        'activeWork',
        'openIssues',
        'nextActions',
        'criticalContext',
      ];
      if (
        typeof parsed.projectBrief !== 'string' ||
        typeof parsed.confidenceAndRisk !== 'string' ||
        typeof parsed.durableMemory !== 'string' ||
        requiredArrays.some((key) => !Array.isArray(parsed[key]))
      ) {
        throw new Error(
          'The compactor returned an invalid checkpoint; original history was preserved',
        );
      }
      const section = (title: string, values: unknown) =>
        `## ${title}\n${(values as unknown[]).map((value) => `- ${String(value)}`).join('\n') || '- None recorded'}`;
      const summary = [
        `# Compacted Session Checkpoint`,
        String(parsed.projectBrief),
        section('Decisions', parsed.decisions),
        section('Files and Code State', parsed.filesAndCodeState),
        section('Completed Work', parsed.completedWork),
        section('Active Work', parsed.activeWork),
        section('Open Issues', parsed.openIssues),
        section('Next Actions', parsed.nextActions),
        section('Critical Context', parsed.criticalContext),
        `## Confidence and Risk\n${String(parsed.confidenceAndRisk)}`,
      ].join('\n\n');
      if (summary.length < 200)
        throw new Error('The compaction checkpoint was too small; original history was preserved');

      emit('committing', 90, 'Committing the new context revision', {
        sourceMessages: conversational.length,
        sourceTokens,
      });
      await this.messages.commitCompaction({
        id: compactionId,
        sessionId: input.sessionId,
        provider: String(providerName),
        model,
        automatic,
        summary,
        sourceMessageCount: conversational.length,
        sourceTokens: tokensIn,
        checkpointTokens: tokensOut || Math.ceil(summary.length / 4),
      });
      writeSessionMemory(projectRoot, input.sessionId, String(parsed.durableMemory));
      const checkpointTokens = tokensOut || Math.ceil(summary.length / 4);
      emit(
        'complete',
        100,
        'Compaction complete — the next manager turn starts from this checkpoint',
        { sourceMessages: conversational.length, sourceTokens: tokensIn, checkpointTokens },
      );
      return { compactionId, sourceMessages: conversational.length, checkpointTokens };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit('failed', 100, 'Compaction failed; the original conversation remains active', {
        error: message,
      });
      throw error;
    } finally {
      this.compactingSessions.delete(input.sessionId);
      await this.updateWorkflowState(input.sessionId, 'idle');
    }
  }

  async handleUserInput(sessionId: string, selection: string, text?: string, questionId?: string) {
    const answer = text || selection;
    const question = await answerPendingQuestion(sessionId, answer, 'answered', questionId);
    if (questionId && !question) return;
    if (this.state.resolveUserInput(sessionId, answer)) return;
    // A backend restart loses the suspended provider stack, but not the
    // decision. Resume as a new durable turn containing both sides.
    if (!question || !this.sessions || !this.messages) return;
    const session = await this.sessions.get(sessionId);
    if (!session) return;
    const content = `Resume after restart. Pending question: ${question.question}\nUser answer: ${answer}`;
    await this.messages.add(sessionId, {
      id: nanoid(12),
      sessionId,
      role: 'user',
      content,
      createdAt: Date.now(),
    });
    void this.processTask(
      sessionId,
      content,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      session.interactionMode ?? 'act',
    );
  }

  async handleSessionResponse(sessionId: string, accepted: boolean) {
    if (accepted) {
      this.emitThought(sessionId, 'synthesizing', 'User accepted changes.');
    } else {
      this.emitThought(sessionId, 'synthesizing', 'User rejected changes. Rolling back...');
      const prevHash = this.state.getCheckpoint(sessionId);
      const changes = this.state.getChanges(sessionId);
      if (prevHash && this.git.isGitRepo()) {
        await this.git.rollbackFiles(prevHash, changes);
      } else {
        await this.snapshotManager.restoreSnapshot(sessionId, 'latest', this.workingDirectory);
      }
    }
    this.state.clearCheckpoint(sessionId);
    this.state.clearChanges(sessionId);
  }

  private async handleManagerInquiry(
    sessionId: string,
    agentId: string,
    question: string,
    preferredModel?: string,
  ): Promise<string> {
    this.emitThought(sessionId, 'analyzing', `Worker help: "${question}"`);
    const routing = this.resolveActiveRouting(preferredModel, 'general', true);
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider) return 'Error.';

    let decision = 'ANSWER';
    try {
      const stream = provider.streamResponse({
        model: routing.model,
        systemPrompt:
          'You are helping route an inquiry. You must call exactly one tool to indicate your choice.',
        messages: [{ role: 'user', content: question }],
        tools: [
          {
            name: 'route_inquiry',
            description: 'Route the inquiry',
            inputSchema: {
              type: 'object',
              properties: { decision: { type: 'string', enum: ['WEB_SEARCH', 'ANSWER'] } },
              required: ['decision'],
            },
          },
        ],
        maxTokens: 50,
      });

      for await (const event of stream) {
        if (event.type === 'tool_use_stop' && event.toolName === 'route_inquiry') {
          try {
            const args = JSON.parse(event.toolInput || '{}');
            if (args.decision) decision = args.decision;
          } catch {
            /* default to ANSWER */
          }
        }
      }
    } catch (err) {
      koryLog.warn({ err }, 'Manager inquiry routing failed, defaulting to ANSWER');
    }

    if (decision === 'WEB_SEARCH') {
      const toolCtx: ToolContext = { sessionId, workingDirectory: this.workingDirectory };
      const searchResult = await this.tools.execute(toolCtx, {
        id: nanoid(10),
        name: 'web_search',
        input: { query: question },
      });
      return `MANAGER ADVICE: ${searchResult.output}`;
    }
    return `MANAGER ANSWER: I recommend proceeding with the current task.`;
  }

  private async waitForUserInputInternal(
    sessionId: string,
    question: string,
    options: string[],
    presentation?: KoryQuestionPresentation,
  ): Promise<string> {
    const normalized = normalizeQuestionPresentation(presentation);
    this.emitWSMessage(sessionId, 'kory.ask_user', {
      question: String(question || 'What would you like to do next?').slice(0, 2_000),
      options: Array.isArray(options)
        ? options.map(String).map((option) => option.trim()).filter(Boolean).slice(0, 5)
        : [],
      allowOther: true,
      allowKeepChatting: normalized.allowKeepChatting,
      chart: normalized.chart,
      sliders: normalized.sliders,
    } satisfies KoryAskUserPayload);
    return this.state.requestUserInput(sessionId, AGENT.USER_INPUT_TIMEOUT_MS);
  }

  private async resolveSkillCollisionsForTask(
    sessionId: string,
    workingDirectory: string,
    goal: string,
    collisionChoices: Record<string, 'personal' | 'project'> = {},
  ): Promise<Record<string, 'personal' | 'project'>> {
    const contract = createTaskContract(goal);
    const initial = resolveSkills(workingDirectory, goal, contract, { collisionChoices });
    const choices: Record<string, 'personal' | 'project'> = { ...collisionChoices };
    let updated = false;
    for (const collision of initial.collisions) {
      const personal = `Use personal ${collision.name}`;
      const project = `Use project ${collision.name}`;
      const answer = await this.waitForUserInputInternal(
        sessionId,
        `Both this project and your personal library define “${collision.name}”. Which revision should apply to this task?`,
        [project, personal, 'Cancel this task'],
      );
      if (answer === project) choices[collision.name] = 'project';
      else if (answer === personal) choices[collision.name] = 'personal';
      else throw new Error(`Skill collision for ${collision.name} was not resolved.`);
      if (collisionChoices[collision.name] !== choices[collision.name]) updated = true;
    }
    this.skillCollisionChoicesBySession.set(sessionId, choices);

    if (updated) {
      const settings = loadAgentSettings(this.workingDirectory);
      saveAgentSettings(this.workingDirectory, {
        ...settings,
        skillCollisionChoices: { ...settings.skillCollisionChoices, ...choices },
      });
    }

    return choices;
  }

  /** Main entry point for processing a task. */
  async processTask(
    sessionId: string,
    userMessage: string,
    preferredModel?: string,
    reasoningLevel?: string,
    attachments?: Array<{ type: string; data: string; name: string; mimeType?: string }>,
    collaborationToolPolicy?: CollaborationToolPolicy,
    responseVariant?: { groupId: string; index: number },
    goalContext?: import('./prompts').TaskContract['goalContext'],
    interactionMode?: 'act' | 'plan',
    fastMode?: boolean,
  ): Promise<void> {
    interactionMode = interactionMode ?? (await this.sessions?.get(sessionId))?.interactionMode ?? 'act';
    await this.sessionState.transition(sessionId, 'processing');
    this.state.clearChanges(sessionId);
    this.state.clearCheckpoint(sessionId);
    if (interactionMode !== 'plan' && this.git.isGitRepo()) {
      const checkpoint = await this.git.createWorktreeCheckpoint();
      if (checkpoint) this.state.saveCheckpoint(sessionId, checkpoint);
    }
    userMessage = defenseInDepthPromptSanitizer(userMessage);

    const sessionRoot = await this.resolveSessionWorkingDirectory(sessionId);
    const workflowSettings = loadAgentSettings(sessionRoot);
    const remembered = rememberExplicitPreference(sessionRoot, userMessage);
    if (remembered) {
      this.emitWSMessage(sessionId, 'system.info', {
        message: `Remembered as a project preference: ${remembered}`,
      });
    }
    if (interactionMode === 'plan') {
      const planNote = await ensurePlanNote(sessionId, userMessage);
      await this.sessions?.update(sessionId, { planNoteId: planNote.id });
    }
    const configuredCollisionChoices = workflowSettings.skillCollisionChoices ?? {};
    if (goalContext) this.goalContextBySession.set(sessionId, goalContext);
    const initialContract = createTaskContract(userMessage, {
      goalContext: goalContext ?? this.goalContextBySession.get(sessionId),
    });
    const discoveryQuestions = buildIntentDiscoveryBatch(
      userMessage,
      initialContract.taskKind,
      workflowSettings.intentInterview,
    );
    const decisions: string[] = [];
    for (const question of discoveryQuestions) {
      const answer = await this.waitForUserInputInternal(
        sessionId,
        question.question,
        question.options,
      );
      if (answer === '__timeout__' || answer === '__cancelled__' || answer.includes('Stop asking'))
        break;
      decisions.push(`${question.question} ${answer}`);
    }
    if (decisions.length > 0) {
      userMessage += `\n\nResolved intent decisions:\n- ${decisions.join('\n- ')}`;
    }

    await this.resolveSkillCollisionsForTask(
      sessionId,
      await this.resolveSessionWorkingDirectory(sessionId),
      userMessage,
      configuredCollisionChoices,
    );

    // Resolve provider before any UI updates or work. No provider = manager responds once and returns.
    let routing = this.resolveActiveRouting(preferredModel, 'general', true, userMessage);
    let provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider && (!preferredModel || preferredModel === 'auto')) {
      const fallback = this.providers.getFirstAvailableRouting();
      if (fallback) {
        routing = { model: fallback.model, provider: fallback.provider };
        provider = this.providers.resolveProvider(routing.model, routing.provider);
      }
    }
    if (!provider) {
      await this.updateWorkflowState(sessionId, 'idle');
      this.emitError(sessionId, this.getModelConfigurationError(preferredModel));
      await this.sessionState.transition(sessionId, 'idle');
      return;
    }
    this.managerRoutingBySession.set(sessionId, {
      model: routing.model,
      provider: provider.name,
    });

    koryLog.debug(
      { sessionId, routing, providerName: provider.name },
      'Resolved provider for task',
    );

    // Broadcast the user message to relay guests
    collaborationManager.broadcastEvent({ type: 'chat', from: 'human', content: userMessage });

    await this.updateWorkflowState(sessionId, 'processing');
    if (collaborationToolPolicy) setCollaborationToolPolicy(sessionId, collaborationToolPolicy);
    try {
      koryLog.debug({ sessionId }, 'Calling handleDirectly');
      this.emitThought(sessionId, 'analyzing', `Analyzing request...`);

      // Global timeout: abort the task if it runs too long (prevents indefinite hangs)
      const TIMEOUT_MIN = AGENT.PROCESS_TASK_TIMEOUT_MS / 60_000;
      const processTimeout = setTimeout(() => {
        // Abort any active LLM stream
        const abort = this.managerAbortBySession.get(sessionId);
        if (abort) {
          abort.abort(
            new DOMException(`Process task timed out after ${TIMEOUT_MIN} minutes`, 'TimeoutError'),
          );
        }
        // Resolve any pending user input so the task doesn't hang forever
        this.state.resolveUserInput(sessionId, '__timeout__');
      }, AGENT.PROCESS_TASK_TIMEOUT_MS);

      try {
        await this.handleDirectly(
          sessionId,
          userMessage,
          reasoningLevel,
          preferredModel,
          attachments,
          responseVariant,
          interactionMode,
          fastMode,
        );
      } finally {
        clearTimeout(processTimeout);
      }

      koryLog.debug({ sessionId }, 'handleDirectly completed');

      await this.updateWorkflowState(sessionId, 'idle');
      const changes = this.state.getChanges(sessionId);
      if (changes.length > 0) this.emitWSMessage(sessionId, 'session.changes', { changes });
    } catch (err) {
      const errDetail =
        err instanceof Error
          ? { message: err.message, name: err.name, stack: err.stack, cause: err.cause }
          : { raw: String(err), typeof: typeof err };
      koryLog.error({ sessionId, err, errDetail }, 'Error in processTask');
      await this.updateWorkflowState(sessionId, 'error');
      this.emitError(sessionId, `Error: ${String(err)}`);
      // Emit session.idle on error too — the session is no longer processing.
      this.emitWSMessage(sessionId, 'session.idle', { sessionId });
    } finally {
      if (collaborationToolPolicy) clearCollaborationToolPolicy(sessionId);
      this.skillCollisionChoicesBySession.delete(sessionId);
      this.goalContextBySession.delete(sessionId);
      // Only transition to idle if we're still processing/compacting — if an
      // error already moved us to 'error' state, don't clobber it.
      if (this.sessionState.isProcessing(sessionId)) {
        await this.sessionState.transition(sessionId, 'idle');
      }
    }
  }

  private buildFallbackChain(startModelId: string): string[] {
    return this.routing.buildFallbackChain(startModelId);
  }

  private resolveActiveRouting(
    preferredModel?: string,
    domain: WorkerDomain = 'general',
    avoidLegacy = false,
    prompt?: string,
    preferCheap?: boolean,
  ): { model: string; provider: ProviderName | undefined } {
    const routed = this.routing.resolveActiveRouting(
      preferredModel,
      domain,
      avoidLegacy,
      prompt,
      preferCheap,
    );
    // User-configured per-category allowlist: when set for this domain, the
    // manager may only use those models. An explicit user model pick wins.
    if (!preferredModel || preferredModel === 'auto') {
      try {
        const { loadAgentSettings } =
          require('../agent-settings') as typeof import('../agent-settings');
        const allowed = loadAgentSettings(this.workingDirectory).managerModelAccess?.[domain];
        if (allowed?.length && !allowed.includes(routed.model)) {
          for (const candidate of allowed) {
            const alt = this.routing.resolveActiveRouting(
              candidate,
              domain,
              avoidLegacy,
              prompt,
              preferCheap,
            );
            if (this.providers.resolveProvider(alt.model, alt.provider)) return alt;
          }
        }
      } catch {
        /* settings unavailable — use the routed default */
      }
    }
    return routed;
  }

  /**
   * Resolve a delegated role from the user's configured category pool while
   * keeping the manually selected manager identity out of material work.
   * Different providers are preferred because a second alias of the same
   * harness is weaker independence than a genuinely separate harness.
   */
  private resolveIndependentRouting(
    avoidModel: string | undefined,
    avoidProvider: ProviderName | undefined,
    domain: WorkerDomain,
    additionalAvoid: Array<{ model: string | undefined; provider: ProviderName | undefined }> = [],
    task?: string,
    qualificationRole: QualificationRole = 'worker',
  ): { model: string; provider: ProviderName | undefined } | null {
    const settings = loadAgentSettings(this.workingDirectory);
    const configured = settings.managerModelAccess?.[domain] ?? [];
    const candidates =
      configured.length > 0
        ? configured
        : this.providers
            .getStatus()
            .filter((status) => status.authenticated)
            .flatMap((status) => status.models.map((model) => `${status.name}:${model}`));
    const resolved: Array<{ model: string; provider: ProviderName | undefined }> = [];
    for (const candidate of candidates) {
      try {
        const route = this.routing.resolveActiveRouting(candidate, domain);
        const provider = this.providers.resolveProvider(route.model, route.provider);
        const excluded =
          (route.model === avoidModel && route.provider === avoidProvider) ||
          additionalAvoid.some(
            (identity) => route.model === identity.model && route.provider === identity.provider,
          );
        if (provider && !excluded) {
          resolved.push(route);
        }
      } catch {
        // Stale user-enabled model: skip it and continue through the pool.
      }
    }
    const independent = resolved.filter((route) => route.provider !== avoidProvider);
    const differentModel = resolved.filter((route) => route.model !== avoidModel);
    const pool = independent.length ? independent : differentModel;
    const contract = createTaskContract(task ?? 'Delegate task');
    const skillResolution = resolveSkills(this.workingDirectory, contract.goal, contract);
    const ranked = rankHarnessCandidates(
      this.workingDirectory,
      pool,
      qualificationRole,
      skillResolution.selected.map((item) => item.skill.name),
      skillResolution.evidence.declaredMedia[0],
    );
    return ranked[0] ?? null;
  }

  private formatProviderName(provider: string): string {
    if (provider === 'openai') return 'OpenAI';
    if (provider === 'codex') return 'Codex CLI';
    if (provider === 'codex-auth') return 'OpenAI Codex';
    if (provider === 'anthropic') return 'Anthropic';
    if (provider === 'google') return 'Google';
    if (provider === 'aistudio') return 'Google AI Studio';
    if (provider === 'xai') return 'xAI';
    if (provider === 'openrouter') return 'OpenRouter';
    if (provider === 'vertexai') return 'Vertex AI';
    if (provider === 'copilot') return 'Copilot';
    if (provider === 'kimicode') return 'Kimi Code';
    if (provider === 'moonshot') return 'Moonshot AI / Kimi API';
    return provider.charAt(0).toUpperCase() + provider.slice(1);
  }

  private getModelConfigurationError(preferredModel?: string): string {
    const statuses = this.providers.getStatus();
    const authenticated = statuses.filter((provider) => provider.authenticated);

    if (authenticated.length === 0) {
      return 'No model provider is configured. Open Settings and connect a provider before chatting.';
    }

    if (preferredModel && preferredModel !== 'auto' && preferredModel.includes(':')) {
      const separator = preferredModel.indexOf(':');
      const providerName = preferredModel.slice(0, separator);
      const modelId = preferredModel.slice(separator + 1);
      if (providerName && modelId) {
        const selectedProvider = authenticated.find((provider) => provider.name === providerName);
        if (!selectedProvider) {
          return `${this.formatProviderName(providerName)} is not configured. Open Settings and connect it.`;
        }
        if (!selectedProvider.models.includes(modelId)) {
          return `${modelId} is not enabled for ${this.formatProviderName(providerName)}. Open Settings -> Manage Models and enable it.`;
        }
      }
    }

    const enabledModelCount = authenticated.reduce(
      (count, provider) => count + provider.models.length,
      0,
    );
    if (enabledModelCount === 0) {
      return 'No models are enabled for your configured providers. Open Settings -> Manage Models and enable at least one model.';
    }

    return 'No usable model is configured. Open Settings and connect a provider or enable at least one model.';
  }

  /**
   * Run the worker pipeline (confirm if needed, routeToWorker, return summary).
   * Used when the manager explicitly calls delegate_to_worker. Only the manager LLM decides to spawn a worker.
   */
  async runWorkerPipeline(
    sessionId: string,
    task: string,
    preferredModel?: string,
    reasoningLevel?: string,
    domainHint?: string,
  ): Promise<string> {
    const before = await this.events.runWorkflowHooks('before-delegate', sessionId, {
      task,
      preferredModel: preferredModel ?? null,
      domainHint: domainHint ?? null,
    });
    if (before.decision === 'deny') {
      return `Delegation denied by workflow hook: ${before.reason ?? 'no reason supplied'}`;
    }
    const managerRouting = this.resolveActiveRouting(preferredModel, 'general', true, task);
    const workerDomain =
      domainHint && ['general', 'ui', 'backend', 'test', 'review'].includes(domainHint)
        ? (domainHint as WorkerDomain)
        : 'general';
    const workerRouting = this.resolveIndependentRouting(
      managerRouting.model,
      managerRouting.provider,
      workerDomain,
      [],
      task,
      'worker',
    );
    const selectedWorkerRouting = workerRouting ?? managerRouting;
    if (!workerRouting) {
      this.emitThought(
        sessionId,
        'delegating',
        `The user-enabled ${workerDomain} pool has only the manager model; reusing ${managerRouting.provider ?? 'unknown'}:${managerRouting.model} for the subagent.`,
      );
    }
    const workerChoice = selectedWorkerRouting.provider
      ? `${selectedWorkerRouting.provider}:${selectedWorkerRouting.model}`
      : selectedWorkerRouting.model;
    const result = await this.workerPipeline.runWorkerPipeline(
      sessionId,
      task,
      workerChoice,
      reasoningLevel,
      domainHint,
    );
    const after = await this.events.runWorkflowHooks('after-worker', sessionId, { task, result });
    return after.decision === 'deny'
      ? `Worker result rejected by workflow hook: ${after.reason ?? 'no reason supplied'}`
      : result;
  }

  /** Whether Jules cloud delegation is configured (API key). */
  isJulesAvailable(): boolean {
    const jules = this.providers.get('jules');
    if (jules?.isAvailable()) return true;
    return !!detectJulesApiKey();
  }

  /** Fire-and-forget session title generation. Called by the messages route
   *  the first time a user sends a message into a session whose title is still
   *  the default. A small/cheap LLM is asked for a 3-6 word title; if the call
   *  fails or the model isn't available we fall back to a truncated first-line
   *  summary of the user message so the session is never stuck on "New Session".
   *
   *  The result is persisted to the DB and broadcast as `session.updated` so
   *  the sidebar updates in place without a full refetch. */
  async generateSessionTitle(sessionId: string, userMessage: string): Promise<void> {
    if (!this.sessions) return;
    // De-dupe across overlapping calls: if the user fires a second message
    // before the first title resolves, we don't want two LLM calls racing.
    if (this.titledSessions.has(sessionId)) return;
    this.titledSessions.add(sessionId);

    const session = await this.sessions.get(sessionId);
    if (!session) {
      this.titledSessions.delete(sessionId);
      return;
    }
    // Only rename sessions that are still on the default title — user-renamed
    // sessions are sacred.
    if (session.title !== SESSION.DEFAULT_TITLE) return;
    // Only rename the very first user message; later turns keep the existing
    // name even if the user hasn't renamed it manually.
    if ((session.messageCount ?? 0) > 0) return;

    const cleaned = userMessage.replace(/\s+/g, ' ').trim();
    let title = this.fallbackTitle(cleaned);

    try {
      const llmTitle = await this.askForTitle(cleaned);
      if (llmTitle) title = llmTitle;
    } catch (err) {
      koryLog.debug(
        { sessionId, err: String(err) },
        'Agent title generation failed, using fallback',
      );
    }

    title = title.slice(0, SESSION.MAX_TITLE_LENGTH).trim();
    if (!title || title === SESSION.DEFAULT_TITLE) return;

    const updated = await this.sessions.update(sessionId, { title });
    if (updated) this.events.emit(sessionId, 'session.updated', { session: updated });
  }

  /** Ask a small/fast model for a 3-6 word title. Returns null on any failure. */
  private async askForTitle(userMessage: string): Promise<string | null> {
    // Pick the cheapest available routing so title generation stays cheap.
    let routing;
    try {
      routing = this.resolveActiveRouting(undefined, 'general', true, undefined, true);
    } catch {
      return null;
    }
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider) return null;

    const systemPrompt =
      'You generate short chat titles. Output ONLY the title, no quotes, no punctuation ' +
      'at the ends, no prefix like "Title:". 3-6 words, sentence case, specific to the ' +
      "user's actual topic. Never reuse the literal text of the message unless it is a " +
      'proper noun or unique identifier.';
    const userPrompt = `First user message in a chat:\n\n"""${userMessage.slice(0, 1000)}"""\n\nTitle:`;

    let out = '';
    try {
      const stream = provider.streamResponse({
        model: routing.model,
        systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: 32,
      });
      for await (const event of stream) {
        if (event.type === 'content_delta') out += event.content ?? '';
      }
    } catch (err) {
      koryLog.debug({ err: String(err) }, 'title LLM stream failed');
      return null;
    }

    const cleaned = out
      .replace(/^["'`\s]+|["'`\s]+$/g, '')
      .replace(/^title\s*[:\-]\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || cleaned.length < 2) return null;
    return cleaned;
  }

  /** Deterministic, no-LLM fallback. Truncates to AUTO_TITLE_CHARS. */
  private fallbackTitle(content: string): string {
    if (!content) return SESSION.DEFAULT_TITLE;
    return content.length > SESSION.AUTO_TITLE_CHARS
      ? content.slice(0, SESSION.AUTO_TITLE_CHARS - 3).trim() + '...'
      : content.trim();
  }

  private resolveJulesApiKey(): string | null {
    const cfg = this.providers.getConfigs().jules;
    return cfg?.apiKey?.trim() || detectJulesApiKey();
  }

  /**
   * Delegate a task to Google Jules (cloud async agent). Used by delegate_to_jules tool.
   * Streams progress to the session feed while polling the Jules API.
   */
  async runJulesDelegation(
    sessionId: string,
    task: string,
    options?: { createPr?: boolean; branch?: string },
  ): Promise<string> {
    const apiKey = this.resolveJulesApiKey();
    if (!apiKey) {
      return 'Jules is not configured. Add JULES_API_KEY in Settings (https://jules.google.com/settings#api).';
    }

    if (!this.isYoloMode) {
      const selection = await this.waitForUserInputInternal(
        sessionId,
        'Delegate this task to Jules (cloud agent — runs remotely, may take minutes)?',
        ['Yes, send to Jules', 'Cancel'],
      );
      if (selection === '__timeout__') return 'Timed out waiting for user response.';
      if (selection.includes('Cancel')) return 'Jules delegation cancelled by user.';
    }

    this.emitThought(sessionId, 'executing', 'Jules cloud agent working…');
    await this.updateWorkflowState(sessionId, 'processing');

    let summary = '';
    const automationMode = options?.createPr === false ? undefined : 'AUTO_CREATE_PR';

    try {
      for await (const event of runJulesTask({
        apiKey,
        prompt: task,
        workingDirectory: await this.resolveSessionWorkingDirectory(sessionId),
        korySessionId: sessionId,
        defaultBranch: options?.branch,
        automationMode,
        signal: this.state.getAbortController(sessionId).signal,
      })) {
        this.emitJulesProviderEvent(sessionId, event);
        if (event.type === 'content_delta' && event.content) summary += event.content;
        if (event.type === 'error') {
          await this.updateWorkflowState(sessionId, 'idle');
          return event.error ?? 'Jules cloud delegation failed.';
        }
        if (event.type === 'complete') break;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.updateWorkflowState(sessionId, 'idle');
      return `Jules cloud delegation failed: ${msg}`;
    }

    await this.updateWorkflowState(sessionId, 'idle');
    const tail = summary.trim() || 'Jules cloud task finished. Check the session link or PR above.';
    return `${tail}\n\n**Sync locally:** ${JULES_SYNC_INSTRUCTIONS}`;
  }

  private emitJulesProviderEvent(sessionId: string, event: ProviderEvent): void {
    if (event.type === 'thinking_delta' && event.thinking) {
      this.emitWSMessage(sessionId, 'stream.thinking', {
        agentId: KORY_IDENTITY.id,
        thinking: event.thinking,
      } satisfies StreamThinkingPayload);
    } else if (event.type === 'content_delta' && event.content) {
      this.emitWSMessage(sessionId, 'stream.delta', {
        agentId: KORY_IDENTITY.id,
        content: event.content,
        model: 'jules',
      });
    } else if (event.type === 'tool_executed') {
      const callId = `jules-${nanoid(8)}`;
      this.emitWSMessage(sessionId, 'stream.tool_call', {
        agentId: KORY_IDENTITY.id,
        toolCall: {
          id: callId,
          name: event.toolName ?? 'jules_cloud',
          input: safeParseJson(event.toolInput),
        },
      });
      this.emitWSMessage(sessionId, 'stream.tool_result', {
        agentId: KORY_IDENTITY.id,
        toolResult: {
          callId,
          name: event.toolName ?? 'jules_cloud',
          output: event.toolOutput ?? '',
          isError: event.isError === true,
          durationMs: 0,
        },
      });
    } else if (event.type === 'file_edit' && event.filePath) {
      this.emitWSMessage(sessionId, 'stream.file_delta', {
        agentId: KORY_IDENTITY.id,
        path: event.filePath,
        delta: event.fileContent ?? '',
        totalLength: (event.fileContent ?? '').length,
        operation: event.fileOperation ?? 'edit',
      });
    }
  }

  /** Critic can only read files and grep. It sees the full worker transcript (truncated) and outputs PASS or FAIL with feedback. */
  private async runCriticGate(
    sessionId: string,
    workerMessages: InternalMessage[] | undefined,
    preferredModel?: string,
    task?: string,
    reviewDirectory = this.workingDirectory,
  ): Promise<{ passed: boolean; feedback?: string; skipped?: boolean }> {
    // The dashboard Critic toggle is the global source of truth. Every critic
    // entry point (workers, direct manager edits, CLI stop hooks, and Goal
    // Mode) funnels through this method so Off truly means off everywhere.
    if (!loadAgentSettings(this.workingDirectory).criticGateEnabled) {
      return { passed: true, skipped: true, feedback: 'Critic disabled by user.' };
    }
    const beforeCritic = await this.events.runWorkflowHooks('before-critic', sessionId, {
      task: task ?? 'Review delegated work',
      reviewDirectory,
    });
    if (beforeCritic.decision === 'deny') {
      return {
        passed: false,
        feedback: `Critic denied by workflow hook: ${beforeCritic.reason ?? 'no reason supplied'}`,
      };
    }
    const hardCheckResult = await this.runHardChecks(sessionId, reviewDirectory);
    if (!hardCheckResult.passed) return { passed: false, feedback: hardCheckResult.output };

    const baseTaskContract = createTaskContract(task ?? 'Review delegated work');
    const skillResolution = resolveSkills(
      reviewDirectory,
      baseTaskContract.goal,
      baseTaskContract,
      { collisionChoices: this.skillCollisionChoicesBySession.get(sessionId) },
    );
    if (skillResolution.blocked) {
      return {
        passed: false,
        feedback: 'Critic could not establish the required skill contract because skill resolution is blocked.',
      };
    }
    const skillEvidence = deriveSkillEvidenceCriteria(
      skillResolution.selected.map(({ skill }) => ({
        name: skill.name,
        evidence: skill.metadata.evidence,
      })),
    );
    const taskContract = {
      ...baseTaskContract,
      acceptanceCriteria: [...baseTaskContract.acceptanceCriteria, ...skillEvidence],
      requiredEvidence: [...new Set([...baseTaskContract.requiredEvidence, ...skillEvidence])],
    };
    const recordedChanges = this.state.getChanges(sessionId);
    const criticBudget = deriveCriticBudget({
      risk: taskContract.risk,
      changedFiles: new Set(recordedChanges.map((change) => change.path)).size,
      changedLines: recordedChanges.reduce(
        (total, change) => total + change.linesAdded + change.linesDeleted,
        0,
      ),
    });

    const producerRouting = preferredModel
      ? this.resolveActiveRouting(preferredModel, 'general')
      : { model: undefined, provider: undefined };
    const managerIdentity = this.managerRoutingBySession.get(sessionId);
    const routing = this.resolveIndependentRouting(
      producerRouting.model,
      producerRouting.provider,
      'critic',
      managerIdentity ? [managerIdentity] : [],
      task,
      'critic',
    );
    const criticRouting = routing ?? {
      model: producerRouting.model,
      provider: producerRouting.provider,
    };
    if (!criticRouting.model) {
      return { passed: false, feedback: 'Critic unavailable; result is unverified.' };
    }
    if (!routing && taskContract.risk === 'high') {
      return {
        passed: false,
        feedback: 'High-risk work requires a critic independent from the producer and manager; no eligible independent critic is configured.',
      };
    }
    if (!routing) {
      this.emitThought(
        sessionId,
        'reviewing',
        `The user-enabled critic pool has no independent alternative; reusing ${criticRouting.provider ?? 'unknown'}:${criticRouting.model}.`,
      );
    }
    const provider = await this.providers.resolveProvider(
      criticRouting.model,
      criticRouting.provider,
    );
    if (!provider) return { passed: false, feedback: 'Critic unavailable; result is unverified.' };
    const criticCompilation = compilePrompt({
      role: 'critic',
      mode: getModeManager().getMode(),
      provider: provider.name,
      model: criticRouting.model,
      workingDirectory: reviewDirectory,
      occupiedContextChars: JSON.stringify(workerMessages ?? []).length,
      taskContract,
      contextPaths: this.config.contextPaths,
      skillSelection: {
        collisionChoices: this.skillCollisionChoicesBySession.get(sessionId),
      },
    });
    const criticGuidance = assembleAgentContext(
      reviewDirectory,
      loadAgentSettings(reviewDirectory),
    );
    const criticMemory = formatMemoryForContext(assembleMemoryContext(reviewDirectory, sessionId));
    const criticSystemPrompt =
      criticCompilation.systemPrompt +
      (criticGuidance.preferences.trim()
        ? `\n\n## Durable user preferences\n${criticGuidance.preferences.trim()}`
        : '') +
      (criticMemory ? `\n\n${criticMemory.slice(0, 8_000)}` : '');

    const transcriptText = formatMessagesForCriticUtil(
      workerMessages ?? [],
      criticBudget.transcriptChars,
    );
    // The critic is a FRESH-context agent — it never shares the manager's
    // conversation. The manager briefs it here: the original objective plus
    // what to scrutinize, so the review judges fitness-for-purpose instead of
    // vibing over an anonymous transcript.
    const objective = task?.trim()
      ? `THE OBJECTIVE (what the worker was asked to accomplish):\n${task.trim().slice(0, criticBudget.objectiveChars)}\n\n`
      : '';
    const criticPrompt =
      `${objective}Acceptance criteria (cover each exact string in criterionCoverage):\n${taskContract.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n')}\n\nDeterministic checks executed by the gate:\n${hardCheckResult.output}\n\nWorker transcript to review:\n\n${transcriptText}\n\n` +
      `Critique against the objective: (1) does the work actually accomplish it, ` +
      `(2) is the implementation correct (verify claims by reading the real files — do not trust the transcript), ` +
      `(3) did it break or regress anything nearby, (4) is anything incomplete or stubbed. ` +
      `Use read_file/grep/glob/ls as needed. Return the structured JSON critic report required by your system contract.`;
    const criticId = `critic-${nanoid(8)}`;
    const identity: AgentIdentity = {
      id: criticId,
      name: 'Critic',
      role: 'critic',
      model: criticRouting.model,
      provider: provider.name,
      domain: 'critic',
      glowColor: DOMAIN.GLOW_COLORS.critic,
    };
    this.emitWSMessage(sessionId, 'agent.spawned', {
      agent: identity,
      task: 'Review delegated work',
    });
    const criticAbort = new AbortController();
    let criticSessionWd: string;
    try {
      criticSessionWd = mkdtempSync(join(tmpdir(), 'kory-critic-'));
      cpSync(reviewDirectory, criticSessionWd, {
        recursive: true,
        filter: (source) => {
          const relativePath = source.slice(reviewDirectory.length).replace(/^\/+/, '');
          const top = relativePath.split('/')[0];
          return ![
            '.git',
            '.trees',
            '.koryphaios',
            'node_modules',
            'build',
            'dist',
            '.svelte-kit',
          ].includes(top);
        },
      });
    } catch (error) {
      return {
        passed: false,
        feedback: `Could not create the critic's disposable filesystem mirror: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const criticCtx: ToolContext = {
      sessionId,
      workingDirectory: criticSessionWd,
      allowedPaths: [criticSessionWd],
      isSandboxed: true,
      signal: criticAbort.signal,
    };

    const thread: AgentThreadState = {
      sessionId,
      identity,
      kind: 'critic',
      status: 'thinking',
      providerName: provider.name,
      modelId: criticRouting.model,
      systemPrompt: criticSystemPrompt,
      promptManifestHash: criticCompilation.manifest.hash,
      taskContractHash: criticCompilation.manifest.taskContractHash,
      toolRole: 'critic',
      maxTurns: criticBudget.maxTurns,
      maxTokens: criticBudget.maxTokens,
      messages: [{ role: 'user', content: criticPrompt }],
      threadEntries: [],
      ctx: criticCtx,
      abort: criticAbort,
      busy: false,
      updatedAt: Date.now(),
    };
    this.agentThreads.set(criticId, thread);
    this.appendAgentThreadEntry(thread, 'manager', criticPrompt);

    try {
      await this.runAgentThread(criticId, provider);
    } catch {
      rmSync(criticSessionWd, { recursive: true, force: true });
      return { passed: false, feedback: 'Critic failed to run.' };
    }

    const lastContent =
      [...thread.threadEntries].reverse().find((entry) => entry.role === 'assistant')?.content ??
      '';
    const passed = parseCriticVerdict(lastContent, taskContract.acceptanceCriteria);
    rmSync(criticSessionWd, { recursive: true, force: true });
    const afterCritic = await this.events.runWorkflowHooks('after-critic', sessionId, {
      task: task ?? 'Review delegated work',
      passed,
      feedback: lastContent.trim(),
    });
    if (afterCritic.decision === 'deny') {
      return {
        passed: false,
        feedback: `Critic result rejected by workflow hook: ${afterCritic.reason ?? 'no reason supplied'}`,
      };
    }
    return { passed, feedback: lastContent.trim() };
  }

  /** Goal Mode completion claims pass through the same global Critic switch and quality gate. */
  async verifyGoalItem(
    sessionId: string,
    objective: string,
    itemTitle: string,
    preferredModel?: string,
  ): Promise<{ passed: boolean; skipped?: boolean; feedback?: string }> {
    const session = await this.sessions?.get(sessionId);
    return this.runCriticGate(
      sessionId,
      [
        {
          role: 'user',
          content: `Goal objective: ${objective}\nChecklist item claimed complete: ${itemTitle}\nInspect the actual workspace and verify this item is genuinely complete.`,
        },
      ],
      preferredModel,
      `Verify Goal Mode checklist item: ${itemTitle}`,
      session?.workingDirectory ?? this.workingDirectory,
    );
  }

  /** A repeated blocker is terminal only after the enabled Critic accepts that it is real. */
  async verifyGoalBlocker(
    sessionId: string,
    objective: string,
    itemTitle: string,
    blocker: string,
    preferredModel?: string,
  ): Promise<{ passed: boolean; skipped?: boolean; feedback?: string }> {
    const session = await this.sessions?.get(sessionId);
    return this.runCriticGate(
      sessionId,
      [
        {
          role: 'user',
          content: `Goal objective: ${objective}\nActive item: ${itemTitle}\nProposed blocker after repeated attempts: ${blocker}\nVerify whether this is a genuine blocker that requires the goal to stop.`,
        },
      ],
      preferredModel,
      `Adjudicate Goal Mode blocker: ${blocker}`,
      session?.workingDirectory ?? this.workingDirectory,
    );
  }

  private async runHardChecks(
    sessionId: string,
    workingDirectory: string,
  ): Promise<{ passed: boolean; output: string }> {
    const checks = discoverVerificationChecks(workingDirectory);
    if (checks.length === 0) {
      const report = emptyQualityGateReport(
        'No repository-owned deterministic verification command was discovered.',
      );
      return {
        passed: false,
        output: `QUALITY_GATE_REPORT ${JSON.stringify(report)}`,
      };
    }
    const bash = this.tools.get('bash');
    if (!bash) {
      return {
        passed: false,
        output: 'The deterministic-check runner is unavailable; result is unverified.',
      };
    }
    const outputs: string[] = [];
    for (const check of checks) {
      const command = check.command;
      const result = await bash.run(
        { sessionId, workingDirectory, allowedPaths: [workingDirectory], isSandboxed: true },
        { id: nanoid(), name: 'bash', input: { command, timeout: 120 } },
      );
      outputs.push(
        `SOURCE: ${check.source}\nREASON: ${check.reason}\n$ ${command}\n${result.output}`,
      );
      if (result.isError) return { passed: false, output: outputs.join('\n\n') };
    }
    return { passed: true, output: outputs.join('\n\n') };
  }

  /** Manager handles simple tasks directly with full tool access (unsandboxed). Asks user before first tool run unless YOLO. Manager never uses legacy models. */
  private async handleDirectly(
    sessionId: string,
    userMessage: string,
    reasoningLevel?: string,
    preferredModel?: string,
    attachments?: Array<{ type: string; data: string; name: string; mimeType?: string }>,
    responseVariant?: { groupId: string; index: number },
    interactionMode?: 'act' | 'plan',
  ): Promise<void> {
    interactionMode = interactionMode ?? (await this.sessions?.get(sessionId))?.interactionMode ?? 'act';
    koryLog.debug({ sessionId, reasoningLevel, preferredModel }, 'Entering handleDirectly');
    let routing = this.resolveActiveRouting(preferredModel, 'general', true, userMessage);
    let provider = await this.providers.resolveProvider(routing.model, routing.provider);
    // Mirror processTask's fallback: for "auto" (or no model), if the routed model has no
    // available provider, fall back to the first available one — otherwise a configured
    // session spuriously fails with "No provider." even though providers are connected.
    if (!provider && (!preferredModel || preferredModel === 'auto')) {
      const fallback = this.providers.getFirstAvailableRouting();
      if (fallback) {
        routing = { model: fallback.model, provider: fallback.provider };
        provider = this.providers.resolveProvider(routing.model, routing.provider);
      }
    }
    if (!provider) throw new Error('No provider.');
    const providerName = provider.name as ProviderName;
    koryLog.debug({ routing, providerName }, 'Resolved routing and provider');

    const abort = new AbortController();
    this.managerAbortBySession.set(sessionId, abort);

    try {
      this.emitWSMessage(sessionId, 'agent.status', {
        agentId: KORY_IDENTITY.id,
        status: 'thinking',
      });
      let tokensIn = 0;
      let tokensOut = 0;
      let usageKnown = false;
      this.emitUsageUpdate(
        sessionId,
        KORY_IDENTITY.id,
        routing.model,
        providerName,
        tokensIn,
        tokensOut,
        usageKnown,
      );

      const managerCtx: ToolContext = {
        sessionId,
        goalContext: this.goalContextBySession.get(sessionId),
        workingDirectory: await this.resolveSessionWorkingDirectory(sessionId),
        allowedPaths: [],
        isSandboxed: false,
        yoloMode: this.isYoloMode,
        signal: abort.signal,
        waitForUserInput: (question: string, options: string[], presentation) =>
          this.waitForUserInputInternal(sessionId, question, options, presentation),
        emitFileEdit: (e) =>
          this.emitWSMessage(sessionId, 'stream.file_delta', { agentId: KORY_IDENTITY.id, ...e }),
        emitFileComplete: (e) =>
          this.emitWSMessage(sessionId, 'stream.file_complete', {
            agentId: KORY_IDENTITY.id,
            ...e,
          }),
        recordChange: (c) => {
          this.state.recordChange(sessionId, c);
        },
        preflightFileChange: (proposal) => this.enforceAutonomyLimits(sessionId, proposal),
        delegateToWorker: (task: string, domainHint?: string) =>
          this.runWorkerPipeline(
            sessionId,
            task,
            preferredModel,
            this.getWorkerReasoningLevel(),
            domainHint,
          ),
        delegateToJules: (task: string, opts) => this.runJulesDelegation(sessionId, task, opts),
      };

      const history = await this.loadHistory(sessionId);
      // /api/messages persists the user's turn before starting the manager so
      // reloads are durable. Do not send that same turn twice to the model;
      // the multimodal finalContent below is the authoritative current copy.
      const persistedCurrent = history.at(-1);
      const persistedCurrentText = Array.isArray(persistedCurrent?.content)
        ? persistedCurrent.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text ?? '')
            .join('')
        : persistedCurrent?.content;
      if (persistedCurrent?.role === 'user' && persistedCurrentText === userMessage) {
        history.pop();
      }
      koryLog.debug({ historyCount: history.length }, 'Loaded history');

      let finalContent: string | import('../providers/types').ProviderContentBlock[] = userMessage;
      if (attachments && attachments.length > 0) {
        const imageAttachments = attachments.filter((a) => a.type === 'image');
        if (imageAttachments.length > 0) {
          finalContent = [
            { type: 'text', text: userMessage },
            ...imageAttachments.map((att) => {
              let mime = att.mimeType || 'image/png';
              const lowerName = att.name.toLowerCase();
              if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) mime = 'image/jpeg';
              if (lowerName.endsWith('.webp')) mime = 'image/webp';
              if (lowerName.endsWith('.gif')) mime = 'image/gif';
              return {
                type: 'image' as const,
                imageData: att.data,
                imageMimeType: mime,
              };
            }),
          ];
        }
      }

      const messages: InternalMessage[] = [...history, { role: 'user', content: finalContent }];
      // Auto-run tools by default so the app "just works" on launch (changes stay reviewable
      // after the fact + Critic-gated). Set autoRunTools:false to confirm before each run.
      const { loadAgentSettings: loadAgentSettingsForRun } = await import('../agent-settings');
      const autoRunTools = loadAgentSettingsForRun(this.workingDirectory).autoRunTools !== false;
      let turnCount = 0;
      let firstAskForDirectTools = true;
      let stoppedByUser = false;
      // Track whether the run produced anything user-visible — so an empty LLM response
      // surfaces a clear message instead of a silent "weird stop".
      let streamedAnyContent = false;
      let observedNativeTool = false;
      let delegatedWorkerCount = 0;
      let multiModeRetryIssued = false;

      while (turnCount < 25) {
        if (abort.signal.aborted) {
          stoppedByUser = true;
          break;
        }
        turnCount++;
        koryLog.debug({ turnCount }, 'Starting manager turn');
        // Reclaim context: stub out tool outputs the user hid from the agent
        // or that are old enough to be dead weight (recoverable via fetch_context).
        await this.applyContextPruning(sessionId, messages, turnCount);
        let result: LLMTurnResult;
        try {
          result = await this.processManagerTurn(
            sessionId,
            routing.model,
            provider,
            messages,
            managerCtx,
            abort.signal,
            reasoningLevel,
            interactionMode,
            fastMode,
          );
          koryLog.debug(
            {
              resultSuccess: result.success,
              hasContent: !!result.content,
              toolCallCount: result.completedToolCalls?.length,
            },
            'Turn completed',
          );
        } catch (err: unknown) {
          const errDetail =
            err instanceof Error
              ? { message: err.message, name: err.name, stack: err.stack, cause: err.cause }
              : { raw: String(err), typeof: typeof err };
          koryLog.error({ err, errDetail }, 'Error in processManagerTurn');
          if (err instanceof DOMException && err.name === 'AbortError') {
            stoppedByUser = true;
            break;
          }
          throw err;
        }
        if (typeof result.usage?.tokensIn === 'number')
          tokensIn = Math.max(tokensIn, result.usage.tokensIn);
        if (typeof result.usage?.tokensOut === 'number')
          tokensOut = Math.max(tokensOut, result.usage.tokensOut);
        if (result.content && result.content.trim()) streamedAnyContent = true;
        observedNativeTool ||= result.observedNativeTool === true;

        if (!result.success) break;

        const { completedToolCalls } = result;
        if (!completedToolCalls || completedToolCalls.length === 0) {
          const runSettings = loadAgentSettings(this.workingDirectory);
          const multiRequired =
            interactionMode !== 'plan' &&
            runSettings.agentExecutionMode === 'multi' &&
            requiresMultiAgentDelegation(userMessage);
          if (multiRequired && delegatedWorkerCount === 0) {
            if (!supportsKoryControlPlaneTools(provider.name)) {
              messages.push({
                role: 'assistant',
                content: `MULTI-AGENT BLOCKED: ${provider.name} cannot invoke Kory's managed delegation tools in this build. The host refused to silently complete this non-trivial task as a single agent. Choose a control-plane-capable manager provider or switch Agent Mode.`,
              });
              break;
            }
            if (!multiModeRetryIssued) {
              multiModeRetryIssued = true;
              messages.push({
                role: 'system',
                content:
                  'HOST ENFORCEMENT: Multi-Agent mode requires delegation for this non-trivial task. Decompose it into independent workstreams and call delegate_to_worker now. When two or more workstreams are independent, issue those delegate_to_worker calls together so Kory can execute them concurrently. Do not provide a final answer until at least one worker result has been synthesized.',
              });
              continue;
            }
            messages.push({
              role: 'assistant',
              content:
                'MULTI-AGENT BLOCKED: The manager did not delegate after a host enforcement retry. Kory refused to report single-agent work as a Multi-Agent completion.',
            });
          }
          break;
        }

        if (completedToolCalls && completedToolCalls.length > 0) {
          if (!autoRunTools && !this.isYoloMode && firstAskForDirectTools) {
            const selection = await this.waitForUserInputInternal(
              sessionId,
              'Manager will run tools to complete this task. Proceed?',
              ['Yes, proceed', 'Cancel'],
            );
            firstAskForDirectTools = false;
            if (selection === '__timeout__' || selection.includes('Cancel')) {
              if (this.messages)
                await this.messages.add(sessionId, {
                  id: nanoid(12),
                  sessionId,
                  role: 'assistant',
                  content:
                    selection === '__timeout__'
                      ? '[Timed out waiting for user response.]'
                      : '[Cancelled by user.]',
                  model: routing.model,
                  provider: providerName,
                  createdAt: Date.now(),
                });
              break;
            }
          }
          const runTool = async (tc: CompletedToolCall) => ({
            tc,
            toolResult: await this.executeManagerToolCall(sessionId, tc, managerCtx),
          });
          const parallelDelegations =
            completedToolCalls.length > 1 &&
            completedToolCalls.every((tc) => tc.name === 'delegate_to_worker');
          // Independent worker calls emitted together are safe to run concurrently:
          // WorkerPipelineService gives each task its own isolated worktree and
          // reconciles the results before returning them to the manager.
          const executedCalls = parallelDelegations
            ? await Promise.all(completedToolCalls.map(runTool))
            : await (async () => {
                const sequential: Array<Awaited<ReturnType<typeof runTool>>> = [];
                for (const tc of completedToolCalls) {
                  if (abort.signal.aborted) break;
                  sequential.push(await runTool(tc));
                }
                return sequential;
              })();
          for (const { tc, toolResult } of executedCalls) {
            if (tc.name === 'delegate_to_worker' && !toolResult.isError) delegatedWorkerCount++;
            // Archive the full output locally so pruning never loses anything —
            // fetch_context can recover the exact content by this id.
            const archiveId = await this.archiveToolResult(sessionId, tc, toolResult);
            this.emitWSMessage(sessionId, 'stream.tool_result', {
              agentId: KORY_IDENTITY.id,
              toolResult: archiveId ? { ...toolResult, archiveId } : toolResult,
            });
            // Cap what enters the MODEL context — a megabyte build log would
            // blow the window (and made the context bar spike absurdly). The
            // archive keeps the full output; fetch_context recovers it.
            const TOOL_OUTPUT_CONTEXT_CAP = 30_000;
            const cappedResult =
              (toolResult.output?.length ?? 0) > TOOL_OUTPUT_CONTEXT_CAP
                ? {
                    ...toolResult,
                    output:
                      toolResult.output.slice(0, TOOL_OUTPUT_CONTEXT_CAP) +
                      `\n…[truncated ${toolResult.output.length - TOOL_OUTPUT_CONTEXT_CAP} chars${archiveId ? ` — full output via fetch_context id=${archiveId}` : ''}]`,
                  }
                : toolResult;
            const toolMsg: InternalMessage = {
              role: 'tool',
              content: JSON.stringify(cappedResult),
              tool_call_id: tc.id,
            };
            if (archiveId) Object.assign(toolMsg, { archiveId, archiveTurn: turnCount });
            messages.push(toolMsg);
            const visionMsg = this.buildViewImageMessage(toolResult);
            if (visionMsg) messages.push(visionMsg);
          }
          if (abort.signal.aborted) stoppedByUser = true;
        }
      }

      // A stop that lands between turns (or breaks out of the stream loop)
      // must still be reported as user-stopped, not a normal completion.
      if (abort.signal.aborted) stoppedByUser = true;

      // Direct manager edits must pass the same gate as delegated work. This
      // happens before the final response is persisted so a model's optimistic
      // self-assessment cannot become the authoritative completion state.
      const directChanges = this.state.getChanges(sessionId);
      if (!stoppedByUser && directChanges.length > 0) {
        // Every observed repository mutation is completion-blocking. User gate
        // preferences may relax answer/research review, but cannot turn an
        // edited workspace into verified success without deterministic checks
        // and a valid critic report.
        const diffSections = await Promise.all(
          directChanges.map(async (change) => {
            const diff = await this.git.getDiff(change.path);
            return `FILE: ${change.path}\n${diff || '[No Git diff available; inspect the file directly.]'}`;
          }),
        );
        const directEvidence: InternalMessage[] = [
          {
            role: 'user',
            content: `Direct manager change set:\n${JSON.stringify(directChanges, null, 2)}\n\nACTUAL DIFF:\n${diffSections.join('\n\n')}`,
          },
        ];
        const gate = await this.runCriticGate(
          sessionId,
          directEvidence,
          preferredModel,
          userMessage,
          managerCtx.workingDirectory,
        );
        if (gate.skipped) {
          messages.push({
            role: 'assistant',
            content: 'UNVERIFIED: The user disabled the Critic quality gate. The changes remain available for review.',
          });
        } else if (!gate.passed) {
          messages.push({
            role: 'assistant',
            content: `QUALITY GATE FAILED: The edits remain available for inspection, but the task is not complete.\n\n${gate.feedback ?? 'Verification failed without usable evidence.'}`,
          });
        } else {
          const harness = getProviderHarnessCapabilities(providerName);
          messages.push({
            role: 'assistant',
            content: harness.verificationEligible
              ? 'VERIFIED: The harness ran repository-derived deterministic checks and a fresh read-only critic against the actual change set. The persisted completion state is verified.'
              : `UNVERIFIED: Checks and criticism passed, but the ${providerName} native harness ran without OS filesystem isolation. Role capability remains available; verified-success is withheld.`,
          });
        }
      }

      const beforeComplete = await this.events.runWorkflowHooks('before-complete', sessionId, {
        stoppedByUser,
        changedFiles: directChanges.map((change) => change.path),
        lastAssistant:
          messages.filter((message) => message.role === 'assistant').at(-1)?.content ?? '',
      });
      if (!stoppedByUser && beforeComplete.decision === 'deny') {
        messages.push({
          role: 'assistant',
          content: `QUALITY GATE FAILED: Completion was rejected by a lifecycle hook.\n\n${beforeComplete.reason ?? 'No reason supplied.'}`,
        });
      }

      const assistants = messages.filter((m) => m.role === 'assistant');
      koryLog.debug(
        { assistantCount: assistants.length },
        'Filtering assistant messages for persistence',
      );
      const lastAssistant = assistants.pop();
      const rawContent = lastAssistant?.content ?? '';
      const content = (
        typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent)
      ).trim();

      // A native harness can inspect the project using its own tools and then
      // exit without ever returning a user-facing answer. That is a failed
      // turn, not a successful "tool-only" completion. Surface it plainly so
      // a user never has to infer the outcome from raw CLI activity.
      const missingFinalResponse = !stoppedByUser && !streamedAnyContent && !content;
      const EMPTY_NOTICE = observedNativeTool
        ? 'The CLI provider completed tool activity but did not return a final answer. Nothing was claimed as complete. Retry the request; if it repeats, reconnect that CLI provider.'
        : 'The model returned an empty response. Please resend or rephrase your request.';
      if (missingFinalResponse) {
        this.emitWSMessage(sessionId, 'system.info', {
          message: EMPTY_NOTICE,
          kind: 'empty_response',
        });
        this.emitWSMessage(sessionId, 'stream.delta', {
          agentId: KORY_IDENTITY.id,
          content: EMPTY_NOTICE,
          model: routing.model,
        });
      }

      // Stopping must never erase work: persist whatever the model produced
      // as Kory's message, and record the stop as a separate system marker so
      // it renders as plain text — not as something Kory said.
      const toPersist = stoppedByUser
        ? content
        : content || (missingFinalResponse ? EMPTY_NOTICE : '[Task completed using tools.]');
      koryLog.debug({ toPersist, sessionId }, 'Attempting to persist assistant message');
      let finalMessageId: string | undefined;
      if (this.messages && toPersist) {
        finalMessageId = nanoid(12);
        // Persist the provider-reported token usage and computed cost with the
        // assistant message so the session counters (messageCount / totalCost)
        // reflect real spend — not just in the demo.
        const assistantCost = usageKnown
          ? (computeCostUsd(providerName, routing.model, tokensIn, tokensOut)?.costUsd ?? 0)
          : 0;
        await this.messages.add(sessionId, {
          id: finalMessageId,
          sessionId,
          role: 'assistant',
          content: toPersist,
          model: routing.model,
          provider: providerName,
          variantGroupId: responseVariant?.groupId,
          variantIndex: responseVariant?.index,
          tokensIn: usageKnown ? tokensIn : 0,
          tokensOut: usageKnown ? tokensOut : 0,
          cost: assistantCost,
          createdAt: Date.now(),
        });
        koryLog.debug('Assistant message persisted');
      }
      if (interactionMode === 'plan') {
        try {
          const noteId = await syncPlanNote(sessionId, userMessage, toPersist);
          await this.sessions?.update(sessionId, { planNoteId: noteId });
        } catch (err) {
          koryLog.warn({ err, sessionId }, 'Failed to synchronize durable Plan note');
        }
      }
      if (this.messages && stoppedByUser) {
        await this.messages.add(sessionId, {
          id: nanoid(12),
          sessionId,
          role: 'system',
          content: 'Stopped by user.',
          kind: 'cancelled',
          model: routing.model,
          provider: providerName,
          createdAt: Date.now(),
        });
      }
      if (this.messages && this.sessionState.isCompacting(sessionId) && !stoppedByUser && content) {
        const removedMessages = await this.messages.replaceSessionWithSummary(
          sessionId,
          content,
          routing.model,
          providerName,
        );
        await this.sessions?.update(sessionId, { messageCount: 1 });
        await markCliConversationRewritten(sessionId);
        this.emitWSMessage(sessionId, 'system.info', {
          message: `Session compacted: replaced ${removedMessages} messages with one durable summary.`,
          kind: 'compacted',
        });
        this.compactionSucceeded.set(sessionId, true);
      }
      this.emitWSMessage(sessionId, 'agent.status', {
        agentId: KORY_IDENTITY.id,
        // Background terminals still running → the agent is waiting on them,
        // not done; the composer button shows "Waiting…" and the exit event
        // wakes the agent back up.
        status: processSupervisor.hasRunningForSession(sessionId) ? 'waiting' : 'done',
        // Include the persisted message id so the frontend can tag live feed
        // entries before reloading, enabling ID-based dedup instead of text.
        messageId: finalMessageId,
      });
      // Emit a definitive session.idle event when the session is truly done
      // (no background processes still running). The frontend uses this to
      // clear the busy indicator without polling the runtime-status endpoint.
      if (!processSupervisor.hasRunningForSession(sessionId)) {
        this.emitWSMessage(sessionId, 'session.idle', {
          sessionId,
          messageId: finalMessageId,
        });
      }

      // Create rewind point after final response
      if (finalMessageId && interactionMode !== 'plan') {
        await this.createRewindCheckpoint(
          sessionId,
          providerName,
          routing.model,
          userMessage,
          finalMessageId,
          tokensIn,
          tokensOut,
          this.state.getChanges(sessionId),
        );
      }

      const changes = this.state.getChanges(sessionId);
      if (changes.length > 0) {
        this.emitWSMessage(sessionId, 'session.changes', { changes });
      }

      // Auto-compaction is intentionally post-turn: never replace context while
      // the manager or its tools are still using it. Only a provider-reported
      // input count and a trusted model window can trigger it.
      const autoSettings = loadAgentSettings(managerCtx.workingDirectory);
      const trustedWindow = resolveTrustedContextWindow(routing.model, providerName);
      if (
        autoSettings.autoCompactEnabled !== false &&
        tokensIn > 0 &&
        trustedWindow.contextKnown &&
        trustedWindow.contextWindow &&
        tokensIn / trustedWindow.contextWindow >= 0.8
      ) {
        const selectedModel = `${providerName}:${routing.model}`;
        setTimeout(() => {
          void this.compactSession({
            sessionId,
            selectedModel,
            reasoningLevel,
            automatic: true,
          }).catch((error) =>
            koryLog.warn({ error, sessionId }, 'Automatic compaction did not complete'),
          );
        }, 0);
      }
    } finally {
      this.managerAbortBySession.delete(sessionId);
      this.managerRoutingBySession.delete(sessionId);
      await this.updateWorkflowState(sessionId, 'idle');
    }
  }

  private async createRewindCheckpoint(
    sessionId: string,
    provider: string,
    model: string,
    prompt: string,
    messageId: string,
    tokensIn = 0,
    tokensOut = 0,
    changedFiles: Array<{ path: string; operation: 'create' | 'edit' | 'delete' }> = [],
  ) {
    try {
      const metadata = {
        agentId: sessionId,
        model,
        prompt,
        tokensIn,
        tokensOut,
        cost: computeCostUsd(provider, model, tokensIn, tokensOut)?.costUsd,
        messageId,
        checkpointType: 'turn_end' as const,
        changedFiles,
      };
      if (this.timeTravel) {
        await this.timeTravel.checkpoint(prompt.slice(0, 72), metadata);
      } else {
        const { ShadowLogger } = await import('./shadow-logger');
        await new ShadowLogger(this.workingDirectory).createGhostCommit(
          prompt.slice(0, 72),
          metadata,
        );
      }
    } catch (err) {
      koryLog.warn({ err, sessionId }, 'Failed to create rewind checkpoint');
    }
  }

  private async processManagerTurn(
    sessionId: string,
    modelId: string,
    provider: Provider,
    messages: InternalMessage[],
    ctx: ToolContext,
    signal?: AbortSignal,
    reasoningLevel?: string,
    interactionMode: 'act' | 'plan' = 'act',
    fastMode?: boolean,
  ): Promise<LLMTurnResult> {
    if (signal?.aborted) throw new DOMException('Manager run aborted', 'AbortError');

    // Load agent settings to apply experimental overrides
    const { loadAgentSettings } = await import('../agent-settings');
    const promptRoot = await this.resolveSessionWorkingDirectory(sessionId);
    const settings = loadAgentSettings(promptRoot);

    const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
    const taskGoal =
      typeof latestUserMessage?.content === 'string'
        ? latestUserMessage.content
        : 'Continue the current user-requested task.';
    const managerCompilation = compilePrompt({
      role: 'manager',
      mode: getModeManager().getMode(),
      provider: provider.name,
      model: modelId,
      workingDirectory: await this.resolveSessionWorkingDirectory(sessionId),
      occupiedContextChars: JSON.stringify(messages).length,
      taskContract: createTaskContract(taskGoal, {
        goalContext: this.goalContextBySession.get(sessionId),
      }),
      contextPaths: this.config.contextPaths,
      skillSelection: {
        collisionChoices: this.skillCollisionChoicesBySession.get(sessionId),
        ...(interactionMode === 'plan' ? { pins: ['plan-mode'] } : {}),
      },
    });
    let systemPrompt = managerCompilation.systemPrompt;
    if (this.promptManifestHashBySession.get(sessionId) !== managerCompilation.manifest.hash) {
      this.promptManifestHashBySession.set(sessionId, managerCompilation.manifest.hash);
      const manifest = managerCompilation.manifest;
      // Manifest provenance is operational diagnostics, not conversation. Keep
      // it in structured logs; surfacing its path/hash payload in the feed made
      // normal chats unreadable and caused needless rendering work.
      koryLog.debug(
        {
          sessionId,
          promptVersion: manifest.version,
          providerAdapter: manifest.providerAdapter,
          promptManifestHash: manifest.hash,
          instructionCount: manifest.instructions.length,
          skillCount: manifest.skills.length,
          conflictCount: manifest.conflicts.length,
        },
        'Prompt manifest applied',
      );
    }
    const beforeMemoryContext = systemPrompt.length;
    const notesEntries = Object.entries(settings.managerNotes ?? {}).filter(([, v]) => v?.trim());
    if (notesEntries.length > 0) {
      const notesSections = notesEntries
        .map(([group, text]) => `### ${group}\n${text.trim()}`)
        .join('\n\n');
      systemPrompt += `\n\n## User Notes (standing guidance)\n${notesSections}`;
    }
    const agentContext = assembleAgentContext(promptRoot, settings);
    if (agentContext.preferences.trim()) {
      systemPrompt += `\n\n## Durable user preferences\n${agentContext.preferences.trim()}`;
    }
    const memoryContext = assembleMemoryContext(promptRoot, sessionId);
    if (memoryContext.settings.autoIncludeInContext) {
      const formatted = formatMemoryForContext(memoryContext);
      if (formatted) {
        const maxChars = Math.max(400, memoryContext.settings.maxContextTokens * 4);
        systemPrompt += `\n\n${formatted.slice(0, maxChars)}`;
      }
    }
    // Chars contributed by injected memory/notes — tracked separately so the
    // context-usage bar can show memory as its own segment.
    if (hasAnyVisibleNoteTools(promptRoot)) {
      const hint = buildNotesNetworkSystemHint(promptRoot);
      if (hint) systemPrompt += `\n\n${hint}`;
      try {
        const { buildNotesNetworkPrompt } = await import('../memory/unified-memory');
        systemPrompt += await buildNotesNetworkPrompt(2500, promptRoot);
      } catch {
        // Notes DB may be unavailable — continue without network context
      }
    }
    const memoryChars = systemPrompt.length - beforeMemoryContext;

    // Multi-source research instruction
    if (settings.multiSourceResearch) {
      systemPrompt +=
        '\n\n• DEEP RESEARCH: When researching complex topics, do not rely on a single source. Use the web_search tool to find multiple perspectives and fetch/read at least 3-5 different pages to verify information and identify consensus or contradictions.';
    }

    // Filter tools based on local web search setting
    let tools = filterToolDefsForNotesPermissions(
      this.tools.getToolDefsForRole('manager'),
      promptRoot,
    );
    if (settings.localWebSearch === 'off') {
      tools = tools.filter((t) => t.name !== 'web_search');
    }
    if (interactionMode === 'plan') {
      const allowed = new Set([
        'read_file',
        'grep',
        'glob',
        'ls',
        'diff',
        'web_search',
        'web_fetch',
        'view_image',
        'ask_user',
        'search_notes',
        'recall_notes',
        'list_notes',
        'get_note_backlinks',
        'get_note_graph_summary',
        'render_note',
        'fetch_context',
        'load_skill_detail',
      ]);
      tools = tools.filter((tool) => allowed.has(tool.name));
      systemPrompt +=
        '\n\nPLAN MODE IS ENFORCED BY THE HOST. You cannot edit project files, run shell commands, commit, create pull requests, delegate, or write arbitrary Notes. Koryphaios synchronizes the dedicated Plan note after each turn.';
    }

    if (interactionMode === 'plan') {
      const planTools = new Set([
        'read_file', 'grep', 'glob', 'ls', 'diff', 'web_search', 'web_fetch', 'view_image',
        'ask_user', 'create_note', 'update_note', 'search_notes', 'recall_notes', 'list_notes',
        'get_note_backlinks', 'get_note_graph_summary', 'render_note', 'fetch_context', 'load_skill_detail',
      ]);
      tools = tools.filter((tool) => planTools.has(tool.name));
      systemPrompt +=
        '\n\n• PLAN MODE: Do not modify files, run shell commands, commit, create pull requests, or delegate implementation. Ask decision-changing questions, inspect evidence, and update the living plan Note at every meaningful checkpoint. Update durable memory only with stable reusable facts or confirmed decisions. Obtain explicit user approval before leaving Plan mode or performing a write-capable project action.';
    }

    if (!this.isJulesAvailable()) {
      tools = tools.filter((t) => t.name !== 'delegate_to_jules');
    } else {
      systemPrompt += `\n\n• JULES (cloud): delegate_to_jules sends work to Google Jules — remote VMs, async, may take minutes, produces PRs. Never substitute for local tools on quick edits.\n• ${JULES_SYNC_INSTRUCTIONS}`;
    }

    if (provider.name === 'jules') {
      const julesMeta = getProviderDisplay('jules');
      systemPrompt += `\n\n• You are chatting through Jules (cloud provider). All code changes happen on Google's remote infrastructure and GitHub — not in this local workspace until synced.\n• ${julesMeta?.managerHint ?? JULES_SYNC_INSTRUCTIONS}`;
    }

    if (!supportsKoryControlPlaneTools(provider.name)) {
      // Native CLI harnesses may execute and report their own tools, but cannot
      // call back into Kory's control plane. Hiding the schemas prevents a
      // manager from claiming a delegation that Kory never received.
      tools = [];
      systemPrompt +=
        '\n\n• This native CLI harness cannot invoke Kory control-plane tools in this build. Do not claim to delegate, ask Kory for input, or run a Kory-managed tool; complete only work the native harness can actually perform.';
    }

    // Agent execution mode (the composer pill, persisted in agent settings): gate delegation.
    //  • single → never delegate (remove the tool entirely — guaranteed solo)
    //  • multi  → actively prefer delegating substantial coding to specialist workers
    //  • auto   → Kory decides per-task (default)
    const execMode = settings.agentExecutionMode ?? 'auto';
    if (execMode === 'single') {
      tools = tools.filter(
        (t) => t.name !== 'delegate_to_worker' && t.name !== 'delegate_to_jules',
      );
      systemPrompt +=
        '\n\n• AGENT MODE: SOLO — Do NOT delegate. Complete the entire task yourself; delegate_to_worker and delegate_to_jules are unavailable this turn.';
    } else if (execMode === 'multi') {
      systemPrompt +=
        '\n\n• AGENT MODE: MULTI-AGENT — Host-enforced for non-trivial work. Decompose the task into independent workstreams and delegate them to specialist workers. Issue multiple delegate_to_worker calls in the same turn whenever at least two workstreams can proceed independently, then synthesize the results. Questions and genuinely tiny mechanical edits may stay direct; all other work must use at least one worker.';
    }
    // If "fallback", we keep it in the list. The model can choose to use it if its native search fails or is unavailable.

    const providerMessages = this.toProviderMessages(messages);
    // Estimated context composition at dispatch (chars/4) — segment ratios for
    // the context-usage bar; the provider's usage_update stays the real total.
    // Agentic CLI harnesses (claude/grok/antigravity) run their OWN tools —
    // Koryphaios tool schemas are never sent to them, so counting our defs as
    // "Tools" misattributes the CLI's harness overhead. Their real overhead
    // shows up as the gap between this estimate and provider-reported usage
    // (rendered as "Provider harness" in the context bar).
    const NATIVE_TOOL_PROVIDERS = new Set(['claude', 'codex', 'grok', 'antigravity']);
    // Chat = user + assistant text only. Tools = tool definitions + all tool
    // calls/results in the history. Keep them strictly separate in the bar.
    const msgSplit = estimateProviderMessagesChars(providerMessages);
    const toolDefsChars = NATIVE_TOOL_PROVIDERS.has(provider.name)
      ? 0
      : JSON.stringify(tools ?? []).length;
    const contextBreakdown: ContextBreakdown = {
      system: Math.ceil(Math.max(0, systemPrompt.length - memoryChars) / 4),
      memory: Math.ceil(memoryChars / 4),
      tools: Math.ceil((toolDefsChars + msgSplit.tools) / 4),
      chat: Math.ceil(msgSplit.chat / 4),
    };

    const estTokens =
      contextBreakdown.system +
      contextBreakdown.memory +
      contextBreakdown.tools +
      contextBreakdown.chat;
    // This is deliberately a chars/4 planning estimate, not a token count.
    // Do not mark it provider-known or let the UI present it as truth. A
    // provider/CLI usage event replaces it as soon as one is available.
    this.emitUsageUpdate(
      sessionId,
      KORY_IDENTITY.id,
      modelId,
      provider.name,
      estTokens,
      0,
      false,
      contextBreakdown,
    );

    // Context self-awareness: tell the model what its window looks like and
    // what's prunable, so it can decide on its own to free space or compact.
    if (settings.contextSelfAwareness !== false) {
      const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
      const win = resolveTrustedContextWindow(modelId, provider.name);
      const pct = win.contextWindow ? Math.round((estTokens / win.contextWindow) * 100) : null;
      const bulky = messages
        .filter(
          (m): m is InternalMessage & { archiveId: string; content: string } =>
            m.role === 'tool' &&
            typeof (m as { archiveId?: string }).archiveId === 'string' &&
            !(m as { pruneApplied?: boolean }).pruneApplied &&
            typeof m.content === 'string' &&
            m.content.length > 400,
        )
        .map((m) => ({ id: m.archiveId, tok: Math.ceil(m.content.length / 4) }))
        .sort((a, b) => b.tok - a.tok)
        .slice(0, 5);
      systemPrompt +=
        `

[CONTEXT STATUS] ~${k(estTokens)} tokens in your context` +
        (pct !== null ? ` (~${pct}% of a ${k(win.contextWindow!)} window)` : '') +
        ` — system ${k(contextBreakdown.system)}, memory ${k(contextBreakdown.memory)}, tools ${k(contextBreakdown.tools)}, chat/tool-results ${k(contextBreakdown.chat)}.` +
        (bulky.length
          ? ` Largest prunable tool outputs: ${bulky.map((b) => `${b.id} (~${k(b.tok)})`).join(', ')}.`
          : '') +
        ` You own this window: fetch_context with no arguments lists everything you did (with timestamps); ` +
        `prune_context drops outputs you no longer need (always recoverable)` +
        (pct !== null && pct >= 70
          ? `. Note: your context is filling up. It's your call — prune stale outputs, keep going if you're nearly done, or if nothing is prunable, suggest the user compact the session.`
          : `.`);
    }

    // The composer's reasoning tier MUST reach the provider — this was silently
    // dropped for the main chat turn (only worker threads forwarded it).
    const resolvedReasoning =
      reasoningLevel === 'auto'
        ? determineAutoReasoningLevel(
            typeof messages[messages.length - 1]?.content === 'string'
              ? (messages[messages.length - 1].content as string)
              : '',
          )
        : reasoningLevel;
    const normalizedReasoning = normalizeReasoningLevel(provider.name, modelId, resolvedReasoning);

    const streamSignal = withTimeoutSignal(signal, AGENT.LLM_STREAM_TIMEOUT_MS);
    const stream = this.providers.executeWithRetry(
      {
        model: modelId,
        systemPrompt,
        messages: providerMessages,
        tools,
        maxTokens: 16384,
        signal: streamSignal,
        ...(normalizedReasoning !== undefined && { reasoningLevel: normalizedReasoning }),
        ...(fastMode === true && { fastMode: true }),
        // Agentic CLI providers (claude-code) run + edit files in the session's project directory.
        workingDirectory: await this.resolveSessionWorkingDirectory(sessionId),
        sessionId,
        harnessRole: 'manager',
        promptManifestHash: managerCompilation.manifest.hash,
        taskContractHash: managerCompilation.manifest.taskContractHash,
        sandbox: interactionMode === 'plan' ? SANDBOX_PRESETS.readonly : SANDBOX_PRESETS.balanced,
      },
      provider.name,
    );

    let assistantContent = '';
    let pendingToolCalls = new Map<string, { name: string; input: string }>();
    const completedToolCalls: CompletedToolCall[] = [];
    let hasToolCalls = false;
    let observedNativeTool = false;
    let tokensIn = 0;
    let tokensOut = 0;

    try {
      for await (const event of stream) {
        // On user stop, keep everything accumulated so far — breaking (instead of
        // throwing) lets the partial response flow into `messages` and get
        // persisted. Throwing here erased the user's proof-of-work on Stop.
        if (signal?.aborted) break;
        if (event.type === 'error') {
          throw new Error(event.error ?? 'LLM stream error');
        }
        if (event.type === 'content_delta') {
          const delta = event.content ?? '';
          assistantContent += delta;
          // Stream live, token-by-token — so the user sees text appear immediately (no
          // "thinks then dumps" pause) and partial output survives a mid-stream error.
          if (delta) {
            this.emitWSMessage(sessionId, 'stream.delta', {
              agentId: KORY_IDENTITY.id,
              content: delta,
              model: modelId,
            });
          }
        } else if (event.type === 'thinking_delta') {
          if (event.thinking || typeof event.thinkingTokens === 'number') {
            this.emitWSMessage(sessionId, 'stream.thinking', {
              agentId: KORY_IDENTITY.id,
              thinking: event.thinking ?? '',
              ...(typeof event.thinkingTokens === 'number'
                ? { thinkingTokens: event.thinkingTokens }
                : {}),
            } satisfies StreamThinkingPayload);
          }
        } else if (event.type === 'file_edit') {
          // Agentic provider (claude-code) already wrote the file — surface it in the live
          // diff preview (it's done, not a tool for us to execute).
          if (event.filePath) {
            this.streamAgentFileEdit(
              ctx,
              event.filePath,
              event.fileContent ?? '',
              event.fileOperation ?? 'edit',
              event.fileOldContent,
            );
            // Archive the edit so fetch_context can recall exactly what was written.
            await getContextArchive()?.record(
              sessionId,
              'file_edit',
              `${event.fileOperation ?? 'edit'} ${event.filePath}`,
              event.fileContent ?? '',
            );
          }
        } else if (event.type === 'tool_executed') {
          observedNativeTool = true;
          // Agentic provider already ran a non-file tool — surface it in the tool feed.
          const callId = `agent-${nanoid(8)}`;
          // CLI-native background command (Claude Code's Bash run_in_background):
          // register it so the background-terminals UI tracks it with live logs.
          const bgMatch =
            /running in background with ID:\s*(\S+?)\.[\s\S]*?written to:\s*(\S+?\.output)/i.exec(
              event.toolOutput ?? '',
            );
          if (bgMatch) {
            let bgCommand = event.toolName ?? 'background command';
            try {
              const input = JSON.parse(event.toolInput ?? '{}') as { command?: string };
              if (input.command) bgCommand = input.command;
            } catch {
              /* keep tool name */
            }
            void processSupervisor
              .registerExternal({
                name: `cli:${bgMatch[1]}`,
                command: bgCommand,
                sessionId,
                outputFile: bgMatch[2],
              })
              .catch(() => {});
          }
          const agenticArchiveId = await getContextArchive()?.record(
            sessionId,
            'tool_result',
            `${event.toolName ?? 'tool'} ${(event.toolInput ?? '').slice(0, 140)}`,
            event.toolOutput ?? '',
          );
          this.emitWSMessage(sessionId, 'stream.tool_call', {
            agentId: KORY_IDENTITY.id,
            sourceProvider: provider.name,
            toolCall: {
              id: callId,
              name: event.toolName ?? 'tool',
              input: safeParseJson(event.toolInput),
            },
          });
          this.emitWSMessage(sessionId, 'stream.tool_result', {
            agentId: KORY_IDENTITY.id,
            sourceProvider: provider.name,
            toolResult: {
              callId,
              name: event.toolName ?? 'tool',
              output: event.toolOutput ?? '',
              isError: event.isError === true,
              durationMs: 0,
              ...(agenticArchiveId ? { archiveId: agenticArchiveId } : {}),
            },
          });
        } else if (event.type === 'usage_update') {
          // Cached prompt tokens still occupy the context window — fold them in
          // so the context bar reflects real occupancy, not just billed input.
          if (typeof event.tokensIn === 'number')
            tokensIn = Math.max(tokensIn, event.tokensIn + (event.tokensCache ?? 0));
          if (typeof event.tokensOut === 'number') tokensOut = Math.max(tokensOut, event.tokensOut);
          this.emitUsageUpdate(
            sessionId,
            KORY_IDENTITY.id,
            modelId,
            provider.name,
            tokensIn,
            tokensOut,
            true,
            contextBreakdown,
          );
        } else if (event.type === 'tool_use_start') {
          hasToolCalls = true;
          pendingToolCalls.set(event.toolCallId!, { name: event.toolName!, input: '' });
          this.emitWSMessage(sessionId, 'stream.tool_call', {
            agentId: KORY_IDENTITY.id,
            toolCall: { id: event.toolCallId, name: event.toolName, input: {} },
          });
        } else if (event.type === 'tool_use_delta') {
          const tc = pendingToolCalls.get(event.toolCallId!);
          if (tc) tc.input += event.toolInput ?? '';
        } else if (event.type === 'tool_use_stop') {
          const call = pendingToolCalls.get(event.toolCallId!);
          if (call) {
            let parsedInput = {};
            try {
              parsedInput = JSON.parse(call.input || '{}');
            } catch {
              /* Expected: malformed tool input JSON, defaults to {} */
            }
            this.emitWSMessage(sessionId, 'stream.tool_call', {
              agentId: KORY_IDENTITY.id,
              toolCall: { id: event.toolCallId, name: call.name, input: parsedInput },
            });
            completedToolCalls.push({ id: event.toolCallId!, name: call.name, input: parsedInput });
            pendingToolCalls.delete(event.toolCallId!);
          }
        }
      }
    } catch (err) {
      // Provider streams can throw on abort (fetch AbortError) — salvage the
      // partial response instead of discarding the turn. Real errors rethrow.
      const aborted = signal?.aborted || (err instanceof DOMException && err.name === 'AbortError');
      if (!aborted) throw err;
    }

    messages.push({
      role: 'assistant',
      content: assistantContent,
      tool_calls:
        hasToolCalls && completedToolCalls.length > 0
          ? completedToolCalls.map((tc) => ({ id: tc.id, name: tc.name, input: tc.input }))
          : undefined,
    });

    if (hasToolCalls && completedToolCalls.length > 0) {
      return {
        success: true,
        content: assistantContent,
        usage: { tokensIn, tokensOut },
        completedToolCalls,
        observedNativeTool,
      };
    }
    return {
      success: assistantContent.length > 0,
      content: assistantContent,
      usage: { tokensIn, tokensOut },
      observedNativeTool,
    };
  }

  /**
   * Surface a file edit an AGENTIC provider (claude-code) already performed, via the live
   * diff preview pipeline (stream.file_delta/file_complete) + change tracking. The agent
   * did the write; we only display it.
   */
  private streamAgentFileEdit(
    ctx: ToolContext,
    path: string,
    content: string,
    operation: 'create' | 'edit',
    oldStr?: string,
  ): void {
    // CLI harnesses (grok/antigravity) hand us the COMPLETE file in one shot —
    // no per-token stream. To get the Cursor-style live reveal instead of the
    // file popping in whole, chunk it into progressive deltas over a short,
    // capped window (~1.2s max) — non-blocking so the agent never waits.
    const REVEAL_MS = 1200;
    const MIN_STEP_MS = 40;
    const firstDelta = operation === 'edit' && oldStr !== undefined ? { oldStr } : {};

    if (!content || content.length < 200) {
      // Tiny edits: not worth animating.
      ctx.emitFileEdit?.({
        path,
        delta: content,
        totalLength: content.length,
        operation,
        ...firstDelta,
      });
      ctx.emitFileComplete?.({ path, totalLines: content.split('\n').length, operation });
    } else {
      const steps = Math.max(4, Math.min(30, Math.round(REVEAL_MS / MIN_STEP_MS)));
      const chunkSize = Math.ceil(content.length / steps);
      const stepMs = Math.max(MIN_STEP_MS, Math.round(REVEAL_MS / steps));
      let sent = 0;
      let first = true;
      const emitNext = () => {
        if (sent >= content.length) {
          ctx.emitFileComplete?.({ path, totalLines: content.split('\n').length, operation });
          return;
        }
        const chunk = content.slice(sent, sent + chunkSize);
        sent += chunk.length;
        ctx.emitFileEdit?.({
          path,
          delta: chunk,
          totalLength: sent,
          operation,
          ...(first ? firstDelta : {}),
        });
        first = false;
        setTimeout(emitNext, stepMs).unref?.();
      };
      emitNext();
    }

    ctx.recordChange?.({
      path,
      linesAdded: content ? content.split('\n').length : 0,
      linesDeleted: oldStr ? oldStr.split('\n').length : 0,
      operation,
    });
  }

  private async gateNoteToolCall(
    sessionId: string,
    tc: CompletedToolCall,
  ): Promise<ToolCallOutput | null> {
    if (!isNoteToolName(tc.name)) return null;

    const check = checkNoteToolPermission(tc.name, this.workingDirectory, {
      yoloMode: this.isYoloMode,
    });

    if (!check.allowed) {
      // Tool was hidden from the schema — treat as unknown if the model hallucinates a call
      return {
        callId: tc.id,
        name: tc.name,
        output: `Unknown tool: ${tc.name}`,
        isError: true,
        durationMs: 0,
      };
    }

    if (check.requiresApproval) {
      const summary = formatNoteToolApprovalSummary(
        tc.name,
        (tc.input ?? {}) as Record<string, unknown>,
      );
      const selection = await this.waitForUserInputInternal(
        sessionId,
        `Allow agent to ${summary}?`,
        ['Allow', 'Deny'],
      );
      if (
        selection === '__timeout__' ||
        selection.includes('Deny') ||
        selection.includes('Cancel')
      ) {
        return {
          callId: tc.id,
          name: tc.name,
          output:
            selection === '__timeout__'
              ? 'Note action denied: timed out waiting for approval'
              : 'Note action denied by user',
          isError: true,
          durationMs: 0,
        };
      }
    }

    return null;
  }

  /** Archive a manager tool result for later recovery via fetch_context. */
  private async archiveToolResult(
    sessionId: string,
    tc: CompletedToolCall,
    toolResult: ToolCallOutput,
  ): Promise<string | undefined> {
    // The context meta-tools manage the archive; archiving them is noise.
    if (tc.name === 'fetch_context' || tc.name === 'prune_context') return undefined;
    const archive = getContextArchive();
    if (!archive) return undefined;
    try {
      let inputSummary = '';
      try {
        inputSummary = JSON.stringify(tc.input ?? {}).slice(0, 140);
      } catch {
        /* unstringifiable input */
      }
      return await archive.record(
        sessionId,
        tc.name === 'bash' || tc.name === 'shell_manage' ? 'terminal' : 'tool_result',
        `${tc.name} ${inputSummary}`,
        toolResult.output ?? '',
      );
    } catch {
      return undefined;
    }
  }

  /**
   * Replace stale/hidden tool outputs in the in-flight message array with tiny
   * stubs pointing at the archive. Frees the context window without losing
   * anything — the agent (or user) can always recover via fetch_context.
   */
  private async applyContextPruning(
    sessionId: string,
    messages: InternalMessage[],
    currentTurn: number,
  ): Promise<void> {
    const archive = getContextArchive();
    if (!archive) return;
    const { loadAgentSettings } = await import('../agent-settings');
    const settings = loadAgentSettings(this.workingDirectory);
    const KEEP_FULL_TURNS = settings.contextKeepRecentTurns ?? 3; // recent turns keep full outputs
    const MIN_PRUNE_CHARS = settings.contextPruneMinChars ?? 600; // tiny outputs aren't worth stubbing
    // A single current-turn result can be enormous (for example a tool
    // accidentally serializing image pixels). Do not let it overflow the next
    // provider request before age-based pruning gets a chance to run.
    const MAX_LIVE_TOOL_CHARS = 60_000;
    const autoPrune = settings.contextPruningEnabled !== false;
    for (const m of messages) {
      const meta = m as InternalMessage & {
        archiveId?: string;
        archiveTurn?: number;
        pruneApplied?: boolean;
      };
      if (m.role !== 'tool' || !meta.archiveId || meta.pruneApplied) continue;
      if (typeof m.content !== 'string') continue;
      const hiddenByUserOrAgent = await archive.isPrunedForAgent(sessionId, meta.archiveId);
      const stale =
        autoPrune &&
        typeof meta.archiveTurn === 'number' &&
        currentTurn - meta.archiveTurn > KEEP_FULL_TURNS &&
        m.content.length > MIN_PRUNE_CHARS;
      const oversized = autoPrune && m.content.length > MAX_LIVE_TOOL_CHARS;
      if (!hiddenByUserOrAgent && !stale && !oversized) continue;
      const entry = await archive.get(sessionId, meta.archiveId);
      let original: Record<string, unknown> = {};
      try {
        original = JSON.parse(m.content) as Record<string, unknown>;
      } catch {
        /* keep empty shell */
      }
      m.content = JSON.stringify({
        callId: original.callId ?? meta.tool_call_id,
        name: original.name,
        output: `[Output ${oversized ? 'was too large for the live context and was pruned' : 'pruned'} to save context: ${entry?.label ?? 'tool output'}${entry ? ` at ${new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}. Recover the exact content with fetch_context id=${meta.archiveId}]`,
        isError: false,
        durationMs: 0,
      });
      meta.pruneApplied = true;
    }
  }

  private async executeManagerToolCall(
    sessionId: string,
    tc: CompletedToolCall,
    ctx: ToolContext,
  ): Promise<ToolCallOutput> {
    const before = await this.events.runWorkflowHooks('before-tool', sessionId, {
      role: 'manager',
      tool: tc.name,
      input: tc.input,
    });
    if (before.decision === 'deny') {
      return {
        callId: tc.id,
        name: tc.name,
        output: `Tool denied by workflow hook: ${before.reason ?? 'no reason supplied'}`,
        isError: true,
        durationMs: 0,
      };
    }
    if (tc.name === 'ask_user') {
      const question = (tc.input?.question as string) ?? 'Proceed?';
      const options = (tc.input?.options as string[]) ?? ['Yes', 'No'];
      const selection = await this.waitForUserInputInternal(sessionId, question, options, {
        chart: tc.input?.chart as KoryQuestionChart | undefined,
        sliders: tc.input?.sliders as KoryQuestionSlider[] | undefined,
        allowKeepChatting: true,
      });
      return {
        callId: tc.id,
        name: tc.name,
        output: `User selected: ${selection}`,
        isError: false,
        durationMs: 0,
      };
    }
    const gated = await this.gateNoteToolCall(sessionId, tc);
    if (gated) return gated;
    const result = await this.tools.execute(ctx, { id: tc.id, name: tc.name, input: tc.input });
    await this.events.runWorkflowHooks('after-tool', sessionId, {
      role: 'manager',
      tool: tc.name,
      isError: result.isError,
    });
    return result;
  }

  /**
   * Runs a worker (sub-agent). Invoked by WorkerPipelineService when the manager calls delegate_to_worker.
   * The code never auto-spawns workers.
   */
  private async executeWithProvider(
    sessionId: string,
    provider: Provider,
    modelId: string,
    userMessage: string,
    domain: WorkerDomain,
    reasoningLevel: string | undefined,
    isAutoMode: boolean,
    allowedPaths: string[],
    isSandboxed: boolean,
    taskContract?: import('./prompts').TaskContract,
  ): Promise<{
    success: boolean;
    error?: string;
    workerMessages?: InternalMessage[];
    usage?: { tokensIn: number; tokensOut: number };
  }> {
    const workerId = `worker-${nanoid(8)}`;
    const abort = new AbortController();
    const workerWorkingDirectory =
      allowedPaths[0] ?? (await this.resolveSessionWorkingDirectory(sessionId));
    const identity: AgentIdentity = {
      id: workerId,
      name: `${domain} Worker`,
      role: 'coder',
      model: modelId,
      provider: provider.name,
      domain,
      glowColor: DOMAIN.GLOW_COLORS[domain],
    };
    this.emitWSMessage(sessionId, 'agent.spawned', { agent: identity, task: userMessage });
    let tokensIn = 0;
    let tokensOut = 0;
    let usageKnown = false;
    this.emitUsageUpdate(
      sessionId,
      workerId,
      modelId,
      provider.name,
      tokensIn,
      tokensOut,
      usageKnown,
    );
    this.workers.registerWorker(
      workerId,
      identity,
      {
        id: workerId,
        description: userMessage,
        domain,
        assignedModel: modelId,
        assignedProvider: provider.name,
        status: 'active',
      },
      abort,
      sessionId,
    );

    const ctx: ToolContext = {
      sessionId,
      workingDirectory: workerWorkingDirectory,
      signal: abort.signal,
      allowedPaths,
      isSandboxed,
      yoloMode: this.isYoloMode,
      emitFileEdit: (e) =>
        this.emitWSMessage(sessionId, 'stream.file_delta', { agentId: workerId, ...e }),
      emitFileComplete: (e) =>
        this.emitWSMessage(sessionId, 'stream.file_complete', { agentId: workerId, ...e }),
      recordChange: (c) => this.state.recordChange(sessionId, c),
      preflightFileChange: (proposal) => this.enforceAutonomyLimits(sessionId, proposal),
      waitForUserInput: (question, options, presentation) =>
        this.waitForUserInputInternal(sessionId, question, options, presentation),
    };
    const history = await this.loadHistory(sessionId);
    const messages: InternalMessage[] = [...history, { role: 'user', content: userMessage }];
    const resolvedReasoningLevel =
      reasoningLevel === 'auto' ? determineAutoReasoningLevel(userMessage) : reasoningLevel;
    const workerCompilation = compilePrompt({
      role: 'worker',
      mode: getModeManager().getMode(),
      provider: provider.name,
      model: modelId,
      workingDirectory: workerWorkingDirectory,
      occupiedContextChars: JSON.stringify(messages).length,
      taskContract: {
        ...(taskContract ??
          createTaskContract(userMessage, {
            scope: allowedPaths,
            constraints: isSandboxed ? ['Stay within the granted filesystem paths'] : [],
          })),
        goalContext: this.goalContextBySession.get(sessionId) ?? taskContract?.goalContext,
      },
      contextPaths: this.config.contextPaths,
      skillSelection: {
        collisionChoices: this.skillCollisionChoicesBySession.get(sessionId),
      },
    });
    let workerSystemPrompt = workerCompilation.systemPrompt;
    const workerSettings = loadAgentSettings(workerWorkingDirectory);
    const workerGuidance = assembleAgentContext(workerWorkingDirectory, workerSettings);
    if (workerGuidance.preferences.trim()) {
      workerSystemPrompt += `\n\n## Durable user preferences\n${workerGuidance.preferences.trim()}`;
    }
    const workerMemory = assembleMemoryContext(workerWorkingDirectory, sessionId);
    if (workerMemory.settings.autoIncludeInContext) {
      const formatted = formatMemoryForContext(workerMemory);
      if (formatted)
        workerSystemPrompt += `\n\n${formatted.slice(0, Math.max(400, workerMemory.settings.maxContextTokens * 4))}`;
    }
    if (hasAnyVisibleNoteTools(this.workingDirectory)) {
      const hint = buildNotesNetworkSystemHint(this.workingDirectory);
      if (hint) workerSystemPrompt += `\n\n${hint}`;
      try {
        const { buildNotesNetworkPrompt } = await import('../memory/unified-memory');
        workerSystemPrompt += await buildNotesNetworkPrompt(2500, this.workingDirectory);
      } catch {
        // Notes DB may be unavailable
      }
    }

    const thread: AgentThreadState = {
      sessionId,
      identity,
      kind: 'worker',
      status: 'thinking',
      providerName: provider.name,
      modelId,
      systemPrompt: workerSystemPrompt,
      promptManifestHash: workerCompilation.manifest.hash,
      taskContractHash: workerCompilation.manifest.taskContractHash,
      toolRole: 'worker',
      reasoningLevel: resolvedReasoningLevel,
      maxTurns: 25,
      maxTokens: 16384,
      messages,
      threadEntries: [],
      ctx,
      abort,
      busy: false,
      updatedAt: Date.now(),
    };
    this.agentThreads.set(workerId, thread);
    // Make the worker transcript self-contained: reviewers can see the
    // original user outcome, the manager's scoped assignment, and then the
    // worker's own progress. This is especially important when opening a
    // worker card after the manager feed has moved on.
    const originalUserMessage = [...history].reverse().find((message) => message.role === 'user');
    const originalUserRequest =
      typeof originalUserMessage?.content === 'string' ? originalUserMessage.content : undefined;
    if (originalUserRequest) this.appendAgentThreadEntry(thread, 'user', originalUserRequest);
    this.appendAgentThreadEntry(thread, 'manager', `Assigned work: ${userMessage}`);

    try {
      await this.runAgentThread(workerId, provider);
      const usage = this.workers.getUsage(workerId);
      return {
        success: true,
        workerMessages: [...thread.messages],
        usage: usage ? { tokensIn: usage.tokensIn, tokensOut: usage.tokensOut } : undefined,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  private updateUsageFromEvent(
    sessionId: string,
    workerId: string,
    modelId: string,
    provider: string,
    event: ProviderEvent,
  ) {
    this.workers.initUsage(workerId);
    if (typeof event.tokensIn === 'number') {
      const usage = this.workers.getUsage(workerId);
      if (usage) {
        // Include cached prompt tokens — they occupy the context window.
        usage.tokensIn = Math.max(usage.tokensIn, event.tokensIn + (event.tokensCache ?? 0));
        if (event.tokensOut !== undefined)
          usage.tokensOut = Math.max(usage.tokensOut, event.tokensOut);
        usage.usageKnown = true;
        this.emitUsageUpdate(
          sessionId,
          workerId,
          modelId,
          provider as ProviderName,
          usage.tokensIn,
          usage.tokensOut,
          usage.usageKnown,
        );
      }
    }
  }

  /** After a successful view_image call, attach the actual image bytes to the
   *  conversation as an image content block so vision-capable models can see
   *  it (the tool result itself carries only a small JSON descriptor). */
  private buildViewImageMessage(toolResult: {
    name: string;
    output: string;
    isError: boolean;
  }): InternalMessage | null {
    if (toolResult.name !== 'view_image' || toolResult.isError) return null;
    try {
      const { path, mimeType } = JSON.parse(toolResult.output) as {
        path?: string;
        mimeType?: string;
      };
      if (!path || !mimeType) return null;
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      const imageData = readFileSync(path).toString('base64');
      return {
        role: 'user',
        content: [
          { type: 'text', text: `[Image from view_image: ${path}]` },
          { type: 'image', imageData, imageMimeType: mimeType },
        ],
      };
    } catch {
      return null;
    }
  }

  private async executeToolCall(
    sessionId: string,
    workerId: string,
    tc: CompletedToolCall,
    ctx: ToolContext,
  ): Promise<ToolCallOutput> {
    const before = await this.events.runWorkflowHooks('before-tool', sessionId, {
      role: 'worker',
      workerId,
      tool: tc.name,
      input: tc.input,
    });
    if (before.decision === 'deny') {
      return {
        callId: tc.id,
        name: tc.name,
        output: `Tool denied by workflow hook: ${before.reason ?? 'no reason supplied'}`,
        isError: true,
        durationMs: 0,
      };
    }
    if (tc.name === 'ask_manager') {
      const ans = await this.handleManagerInquiry(
        sessionId,
        workerId,
        String(tc.input.question ?? ''),
      );
      return { callId: tc.id, name: tc.name, output: ans, isError: false, durationMs: 0 };
    }
    const gated = await this.gateNoteToolCall(sessionId, tc);
    if (gated) return gated;
    const result = await this.tools.execute(ctx, { id: tc.id, name: tc.name, input: tc.input });
    await this.events.runWorkflowHooks('after-tool', sessionId, {
      role: 'worker',
      workerId,
      tool: tc.name,
      isError: result.isError,
    });
    return result;
  }
  cancelWorker(agentId: string) {
    const thread = this.agentThreads.get(agentId);
    if (thread?.abort && thread.busy) {
      thread.abort.abort();
      thread.status = 'done';
      thread.busy = false;
      this.emitWSMessage(thread.sessionId, 'agent.status', { agentId, status: 'done' });
    }
    this.workers.cancelWorker(agentId);
  }

  /** Re-baseline the session's context bar for a model the user just picked:
   *  emits (and persists) a usage snapshot with the new model's trusted
   *  window and the session's last-known occupancy. Backend stays the single
   *  source of truth — works for every provider and CLI. */
  async previewModelContext(sessionId: string, modelId: string, providerName: ProviderName) {
    const last = await getContextArchive()?.getLastUsage(sessionId);
    const context = resolveTrustedContextWindow(modelId, providerName);
    this.emitUsageUpdate(
      sessionId,
      KORY_IDENTITY.id,
      modelId,
      providerName,
      last?.used ?? 0,
      0,
      true,
      last?.breakdown,
    );
    return {
      used: last?.used ?? 0,
      contextWindow: context.contextWindow ?? 0,
      contextKnown: context.contextKnown,
      contextSource: context.contextSource,
      usageKnown: true,
      ...(last?.breakdown ? { breakdown: last.breakdown } : {}),
    };
  }

  /** Summarize the current history, then replace it only after a successful result. */
  async compactSession(
    sessionId: string,
    preferredModel?: string,
    reasoningLevel?: string,
  ): Promise<void> {
    if (!this.messages) throw new Error('Message storage is unavailable.');
    if (this.isSessionRunning(sessionId)) throw new Error('Stop the active run before compacting.');
    if ((await this.messages.getAll(sessionId)).length < 2) {
      throw new Error('There is not enough conversation to compact yet.');
    }
    await this.sessionState.transition(sessionId, 'compacting');
    this.compactionSucceeded.set(sessionId, false);
    try {
      await this.processTask(
        sessionId,
        'Create a precise, self-contained session summary for future work. Preserve active goals, decisions, changed files, verification, blockers, and next actions. Do not use tools, do not delegate, and return only the compacted summary.',
        preferredModel,
        reasoningLevel,
      );
      if (!this.compactionSucceeded.get(sessionId)) {
        throw new Error(
          'The provider did not return a usable summary; the original conversation was kept.',
        );
      }
    } finally {
      this.compactionSucceeded.delete(sessionId);
      // Transition back to idle — processTask's finally block may have already
      // done this, but calling transition is idempotent (no-op if already idle).
      await this.sessionState.transition(sessionId, 'idle');
    }
  }

  cancelSessionWorkers(sessionId: string) {
    this.abortManagerRun(sessionId);
    this.abortCompaction(sessionId);
    this.workers.cancelSessionWorkers(sessionId);
  }

  /** True if the session has an active manager run, any worker, or a
   *  non-idle runtime state. */
  isSessionRunning(sessionId: string): boolean {
    if (this.managerAbortBySession.has(sessionId)) return true;
    if (this.workers.hasSessionWorkers(sessionId)) return true;
    return this.sessionState.isRunning(sessionId);
  }

  getStatus() {
    return this.workers.getStatus();
  }

  cancel() {
    const sessionIds = new Set(this.workers.cancelAll());
    this.managerAbortBySession.forEach((ac, sid) => {
      sessionIds.add(sid);
      ac.abort();
    });
    this.managerAbortBySession.clear();
    for (const sid of sessionIds) {
      this.emitWSMessage(sid, 'agent.status', { agentId: KORY_IDENTITY.id, status: 'done' });
      this.emitWSMessage(sid, 'session.idle', { sessionId: sid });
      void this.sessionState.transition(sid, 'idle');
    }
    koryLog.info('All workers cancelled via global cancel');
  }

  private async loadHistory(sessionId: string): Promise<InternalMessage[]> {
    return (
      (await this.messages?.getContextMessages(sessionId, 1000))
        // System rows are UI markers (e.g. "Stopped by user.") — never part of
        // the conversation sent back to the model.
        ?.filter((m) => m.role !== 'system' || m.content.startsWith('[KORY_COMPACTION]'))
        .map((m) => {
          const images = (m.attachments ?? []).filter((attachment) => attachment.type === 'image');
          return {
            role: (m.role === 'system' ? 'user' : m.role) as InternalMessage['role'],
            content:
              images.length > 0
                ? [
                    { type: 'text' as const, text: m.content },
                    ...images.map((attachment) => ({
                      type: 'image' as const,
                      imageData: attachment.data,
                      imageMimeType: attachment.mimeType ?? 'image/png',
                    })),
                  ]
                : m.content.replace(
                    /^\[KORY_COMPACTION\]\n?/,
                    'Authoritative compacted context:\n',
                  ),
          };
        }) || []
    );
  }

  getAgentThreadsForSession(sessionId: string): Array<{
    agent: AgentIdentity;
    status: AgentStatus;
    kind: 'worker' | 'critic';
    updatedAt: number;
    lastMessage?: string;
  }> {
    return Array.from(this.agentThreads.values())
      .filter((thread) => thread.sessionId === sessionId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((thread) => ({
        agent: thread.identity,
        status: thread.status,
        kind: thread.kind,
        updatedAt: thread.updatedAt,
        lastMessage: thread.threadEntries.at(-1)?.content,
      }));
  }

  getAgentThreadEntries(sessionId: string, agentId: string): AgentThreadEntry[] {
    const thread = this.agentThreads.get(agentId);
    if (!thread || thread.sessionId !== sessionId) return [];
    return [...thread.threadEntries];
  }

  async sendMessageToAgent(
    sessionId: string,
    agentId: string,
    content: string,
    options?: { model?: string; reasoningLevel?: string },
  ): Promise<void> {
    const thread = this.agentThreads.get(agentId);
    if (!thread || thread.sessionId !== sessionId) {
      throw new Error('Agent thread not found');
    }
    if (thread.busy) {
      throw new Error('Agent is already working');
    }
    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error('Message cannot be empty');
    }
    // Same controls as the manager: the user can retarget a sub-agent's model
    // and reasoning tier per message (picker value is "provider:modelId").
    if (options?.model && options.model !== 'auto') {
      const [prov, ...rest] = options.model.split(':');
      const bareModel = rest.join(':');
      if (prov && bareModel) {
        thread.providerName = prov as ProviderName;
        thread.modelId = bareModel;
      } else {
        thread.modelId = options.model;
      }
      thread.identity.model = thread.modelId;
      thread.identity.provider = thread.providerName;
    }
    if (options?.reasoningLevel) thread.reasoningLevel = options.reasoningLevel;
    if (thread.abort?.signal.aborted) {
      const abort = new AbortController();
      thread.abort = abort;
      thread.ctx = { ...thread.ctx, signal: abort.signal };
    }
    thread.messages.push({ role: 'user', content: trimmed });
    this.appendAgentThreadEntry(thread, 'user', trimmed);
    void this.runAgentThread(agentId).catch((err) => {
      koryLog.error(
        { agentId, sessionId, err: err instanceof Error ? err.message : String(err) },
        'Direct agent message failed',
      );
    });
  }

  private appendAgentThreadEntry(
    thread: AgentThreadState,
    role: AgentThreadEntry['role'],
    content: string,
  ): void {
    const trimmed = content.trim();
    if (!trimmed) return;
    const entry: AgentThreadEntry = {
      id: nanoid(12),
      role,
      content: trimmed,
      createdAt: Date.now(),
    };
    thread.threadEntries.push(entry);
    thread.updatedAt = entry.createdAt;
    this.emitWSMessage(thread.sessionId, 'agent.thread_message', {
      agentId: thread.identity.id,
      entry,
    });
  }

  private async runAgentThread(agentId: string, providerOverride?: Provider): Promise<void> {
    const thread = this.agentThreads.get(agentId);
    if (!thread) throw new Error('Agent thread not found');
    const provider =
      providerOverride ??
      (await this.providers.resolveProvider(thread.modelId, thread.providerName));
    if (!provider) throw new Error('Agent provider unavailable');

    thread.busy = true;
    thread.status = 'thinking';
    thread.updatedAt = Date.now();
    this.emitWSMessage(thread.sessionId, 'agent.status', {
      agentId: thread.identity.id,
      status: thread.status,
    });

    try {
      let turnCount = 0;
      while (turnCount < thread.maxTurns) {
        turnCount++;
        const shouldContinue =
          thread.kind === 'worker'
            ? await this.processProviderTurn(
                thread.sessionId,
                thread.identity.id,
                thread.modelId,
                provider,
                thread.messages,
                thread.ctx,
                thread.reasoningLevel,
              )
            : await this.processAgentThreadTurn(thread, provider);
        if (!shouldContinue) break;
      }
      thread.status = 'done';
      thread.updatedAt = Date.now();
      this.emitWSMessage(thread.sessionId, 'agent.status', {
        agentId: thread.identity.id,
        status: 'done',
      });
    } catch (err) {
      thread.status = 'error';
      thread.updatedAt = Date.now();
      this.emitWSMessage(thread.sessionId, 'agent.error', {
        agentId: thread.identity.id,
        error: err instanceof Error ? err.message : String(err),
      });
      this.emitWSMessage(thread.sessionId, 'agent.status', {
        agentId: thread.identity.id,
        status: 'error',
      });
      throw err;
    } finally {
      thread.busy = false;
      if (thread.kind === 'worker') {
        this.workers.removeWorker(agentId);
      }
      // A completed worker/critic remains available for the current session's
      // agent feed, but retain a bounded recent set. Before this, every
      // completed thread (including its full prompt, responses, and tool
      // results) remained in agentThreads until the backend exited.
      this.enforceCompletedAgentThreadLimit(thread.sessionId);
    }
  }

  private async processAgentThreadTurn(
    thread: AgentThreadState,
    provider: Provider,
  ): Promise<boolean> {
    const normalizedReasoning = normalizeReasoningLevel(
      provider.name,
      thread.modelId,
      thread.reasoningLevel,
    );
    const streamSignal = withTimeoutSignal(thread.ctx.signal, AGENT.LLM_STREAM_TIMEOUT_MS);
    const stream = this.providers.executeWithRetry(
      {
        model: thread.modelId,
        systemPrompt: thread.systemPrompt,
        messages: this.toProviderMessages(thread.messages),
        tools: filterToolDefsForNotesPermissions(
          this.tools.getToolDefsForRole(thread.toolRole),
          this.workingDirectory,
        ),
        maxTokens: thread.maxTokens,
        signal: streamSignal,
        workingDirectory: thread.ctx.workingDirectory,
        sessionId: thread.sessionId,
        sandbox: thread.toolRole === 'critic' ? SANDBOX_PRESETS.readonly : SANDBOX_PRESETS.balanced,
        harnessRole: thread.toolRole,
        promptManifestHash: thread.promptManifestHash,
        taskContractHash: thread.taskContractHash,
        ...(normalizedReasoning !== undefined && { reasoningLevel: normalizedReasoning }),
      },
      provider.name,
    );

    let assistantContent = '';
    let pendingToolCalls = new Map<string, { name: string; input: string }>();
    const completedToolCalls: CompletedToolCall[] = [];

    for await (const event of stream) {
      if (event.type === 'error') {
        throw new Error(event.error ?? 'LLM stream error');
      }
      if (event.type === 'content_delta') {
        const delta = event.content ?? '';
        assistantContent += delta;
        // Empty content deltas are provider framing, not a response chunk.
        // Do not turn them into a blank manager/worker card in the feed.
        if (delta) {
          thread.status = 'streaming';
          thread.updatedAt = Date.now();
          this.emitWSMessage(thread.sessionId, 'stream.delta', {
            agentId: thread.identity.id,
            content: delta,
            model: thread.modelId,
          });
        }
      } else if (event.type === 'thinking_delta') {
        // Workers reason too — without this branch their thinking text was
        // silently dropped and never reached the agent thread feed.
        if (event.thinking) {
          thread.status = 'thinking';
          thread.updatedAt = Date.now();
          this.emitWSMessage(thread.sessionId, 'stream.thinking', {
            agentId: thread.identity.id,
            thinking: event.thinking,
          } satisfies StreamThinkingPayload);
        }
      } else if (event.type === 'usage_update') {
        this.updateUsageFromEvent(
          thread.sessionId,
          thread.identity.id,
          thread.modelId,
          provider.name,
          event,
        );
      } else if (event.type === 'tool_use_start') {
        thread.status = 'tool_calling';
        thread.updatedAt = Date.now();
        pendingToolCalls.set(event.toolCallId!, { name: event.toolName!, input: '' });
        this.emitWSMessage(thread.sessionId, 'stream.tool_call', {
          agentId: thread.identity.id,
          toolCall: { id: event.toolCallId, name: event.toolName, input: {} },
        });
      } else if (event.type === 'tool_use_delta') {
        const tc = pendingToolCalls.get(event.toolCallId!);
        if (tc) tc.input += event.toolInput ?? '';
      } else if (event.type === 'tool_use_stop') {
        const call = pendingToolCalls.get(event.toolCallId!);
        if (call) {
          let parsedInput = {};
          try {
            parsedInput = JSON.parse(call.input || '{}');
          } catch {
            /* Expected: malformed tool input JSON, defaults to {} */
          }
          this.emitWSMessage(thread.sessionId, 'stream.tool_call', {
            agentId: thread.identity.id,
            toolCall: { id: event.toolCallId, name: call.name, input: parsedInput },
          });
          completedToolCalls.push({ id: event.toolCallId!, name: call.name, input: parsedInput });
          pendingToolCalls.delete(event.toolCallId!);
        }
      }
    }

    if (assistantContent.trim()) {
      this.appendAgentThreadEntry(thread, 'assistant', assistantContent);
    }

    thread.messages.push({
      role: 'assistant',
      content: assistantContent,
      tool_calls: completedToolCalls.length
        ? completedToolCalls.map((tc) => ({ id: tc.id, name: tc.name, input: tc.input }))
        : undefined,
    });

    if (completedToolCalls.length === 0) {
      return false;
    }

    for (const tc of completedToolCalls) {
      const result =
        thread.toolRole === 'critic'
          ? await this.tools.execute(thread.ctx, { id: tc.id, name: tc.name, input: tc.input })
          : await this.executeToolCall(thread.sessionId, thread.identity.id, tc, thread.ctx);
      this.emitWSMessage(thread.sessionId, 'stream.tool_result', {
        agentId: thread.identity.id,
        toolResult: result,
      });
      thread.messages.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: tc.id });
      const visionMsg = this.buildViewImageMessage(result);
      if (visionMsg) thread.messages.push(visionMsg);
    }

    return true;
  }

  private async processProviderTurn(
    sessionId: string,
    workerId: string,
    modelId: string,
    provider: Provider,
    messages: InternalMessage[],
    ctx: ToolContext,
    reasoningLevel?: string,
  ): Promise<boolean> {
    const latestWorkerRequest = [...messages].reverse().find((message) => message.role === 'user');
    const workerGoal =
      typeof latestWorkerRequest?.content === 'string'
        ? latestWorkerRequest.content
        : 'Continue the assigned worker task.';
    const thread = this.agentThreads.get(workerId);
    if (thread) {
      thread.sessionId = sessionId;
      thread.modelId = modelId;
      thread.providerName = provider.name;
      thread.messages = messages;
      thread.ctx = ctx;
      thread.reasoningLevel = reasoningLevel;
      return this.processAgentThreadTurn(thread, provider);
    }

    const fallbackCompilation = compilePrompt({
      role: 'worker',
      mode: getModeManager().getMode(),
      provider: provider.name,
      model: modelId,
      workingDirectory: ctx.workingDirectory,
      occupiedContextChars: JSON.stringify(messages).length,
      taskContract: createTaskContract(workerGoal, {
        scope: ctx.allowedPaths ?? [],
        goalContext: this.goalContextBySession.get(sessionId),
      }),
      contextPaths: this.config.contextPaths,
      skillSelection: {
        collisionChoices: this.skillCollisionChoicesBySession.get(sessionId),
      },
    });
    const fallbackThread: AgentThreadState = {
      sessionId,
      identity: {
        id: workerId,
        name: 'Worker',
        role: 'coder',
        model: modelId,
        provider: provider.name,
        domain: 'general',
        glowColor: DOMAIN.GLOW_COLORS.general,
      },
      kind: 'worker',
      status: 'thinking',
      providerName: provider.name,
      modelId,
      systemPrompt: fallbackCompilation.systemPrompt,
      promptManifestHash: fallbackCompilation.manifest.hash,
      taskContractHash: fallbackCompilation.manifest.taskContractHash,
      toolRole: 'worker',
      reasoningLevel,
      maxTurns: 1,
      maxTokens: 16384,
      messages,
      threadEntries: [],
      ctx,
      busy: true,
      updatedAt: Date.now(),
    };
    return this.processAgentThreadTurn(fallbackThread, provider);
  }

  /** Build provider messages with tool_call_id for role "tool" and tool_calls for assistant so APIs accept tool results. */
  private toProviderMessages(messages: InternalMessage[]): ProviderMessage[] {
    return messages.map((m) => {
      const out: ProviderMessage = { role: m.role, content: m.content };
      if (m.role === 'tool' && m.tool_call_id != null) out.tool_call_id = m.tool_call_id;
      if (m.role === 'assistant' && m.tool_calls?.length) out.tool_calls = m.tool_calls;
      return out;
    });
  }

  abortManagerRun(sessionId: string): void {
    const controller = this.managerAbortBySession.get(sessionId);
    if (controller) {
      controller.abort();
      this.managerAbortBySession.delete(sessionId);
      koryLog.info({ sessionId }, 'Manager run aborted');
    }
  }

  private abortCompaction(sessionId: string): void {
    const controller = this.compactingSessions.get(sessionId);
    if (!controller) return;
    controller.abort();
    koryLog.info({ sessionId }, 'Compaction aborted');
  }

  // ─── Memory Management & Cleanup ────────────────────────────────────────────────

  /**
   * Cleanup all resources for a specific session.
   * Call this when a session is closed or abandoned.
   */
  cleanupSession(sessionId: string): void {
    // Cancel any active workers for this session
    this.workers.cancelSessionWorkers(sessionId);

    // Abort any ongoing manager run
    this.abortManagerRun(sessionId);
    this.abortCompaction(sessionId);

    // Clear pending user inputs (reject with abort error)
    if (this.state.hasPendingInput(sessionId)) {
      this.state.resolveUserInput(sessionId, '');
    }

    // Clear session-specific data
    this.state.cleanupSession(sessionId);
    this.managerRoutingBySession.delete(sessionId);
    this.managerAbortBySession.delete(sessionId);
    for (const [agentId, thread] of this.agentThreads.entries()) {
      if (thread.sessionId === sessionId) this.agentThreads.delete(agentId);
    }

    koryLog.debug({ sessionId }, 'Session resources cleaned up');
  }

  /**
   * Get memory usage statistics for monitoring.
   */
  getMemoryStats(): {
    activeWorkers: number;
    pendingUserInputs: number;
    trackedSessions: number;
    workerUsageEntries: number;
  } {
    const workerStats = this.workers.getActiveCount();
    const sessionStats = this.state.getMemoryStats();
    return {
      activeWorkers: workerStats,
      pendingUserInputs: sessionStats.sessions,
      trackedSessions: this.workers.getActiveSessionIds().length,
      workerUsageEntries: workerStats,
    };
  }

  /**
   * Cleanup abandoned resources.
   * Call this periodically to prevent memory leaks from abandoned sessions.
   */
  cleanupAbandonedResources(maxSessionAgeMs = AGENT_THREAD_IDLE_TTL_MS): void {
    const now = Date.now();
    const activeSessionIds = new Set(this.workers.getActiveSessionIds());

    // Clean up worker usage for workers that no longer exist
    this.workers.cleanupStaleWorkers();

    // Clean up old session data not associated with any active worker. Use the
    // complete session cleanup path so its companion live caches (notably
    // agentThreads) cannot outlive the state entry that triggered cleanup.
    for (const sessionId of this.state.getSessionIds()) {
      if (!activeSessionIds.has(sessionId)) {
        this.cleanupSession(sessionId);
      }
    }

    // A finished agent thread can exist without a SessionStateService entry
    // (for example after a completed worker). Expire those directly. This is
    // the missing ownership edge that caused the backend's retained memory to
    // grow for the life of the process.
    let expiredAgentThreads = 0;
    for (const [agentId, thread] of this.agentThreads) {
      if (!thread.busy && now - thread.updatedAt >= maxSessionAgeMs) {
        this.agentThreads.delete(agentId);
        expiredAgentThreads++;
      }
    }

    koryLog.debug(
      {
        activeWorkers: this.workers.getActiveCount(),
        trackedSessions: activeSessionIds.size,
        expiredAgentThreads,
        retainedAgentThreads: this.agentThreads.size,
      },
      'Abandoned resources cleaned up',
    );
  }

  /** Keep the live agent-feed cache bounded even during a very active session. */
  private enforceCompletedAgentThreadLimit(sessionId: string): void {
    const completed = [...this.agentThreads.entries()]
      .filter(([, thread]) => thread.sessionId === sessionId && !thread.busy)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
    for (const [agentId] of completed.slice(MAX_COMPLETED_AGENT_THREADS_PER_SESSION)) {
      this.agentThreads.delete(agentId);
    }
  }

  /**
   * Complete shutdown - cleanup all resources.
   * Call this during server shutdown.
   */
  shutdown(): void {
    koryLog.info('Shutting down KoryManager');

    // Cancel all active workers
    this.workers.shutdown();

    // Abort all manager runs
    for (const [sessionId, controller] of this.managerAbortBySession) {
      try {
        controller.abort();
      } catch (err) {
        koryLog.warn(
          { sessionId, error: String(err) },
          'Failed to abort manager run during shutdown',
        );
      }
    }
    this.managerAbortBySession.clear();

    // Clear all session state
    this.state.cleanupAll();
    this.agentThreads.clear();

    koryLog.info('KoryManager shutdown complete');
  }

  private emitThought(sessionId: string, phase: string, thought: string) {
    this.events.emitThought(sessionId, phase, thought);
  }
  private emitRouting(sessionId: string, d: WorkerDomain, m: string, p: string) {
    this.events.emitRouting(sessionId, d, m, p);
  }
  private emitError(sessionId: string, error: string) {
    this.events.emitError(sessionId, error);
  }
  // Per-session project folders: a chat created with a project open runs in THAT
  // folder (tools, providers, workers), not the backend's launch directory.
  private sessionWorkingDirs = new Map<string, string>();

  private async resolveSessionWorkingDirectory(sessionId: string): Promise<string> {
    const cached = this.sessionWorkingDirs.get(sessionId);
    if (cached !== undefined) return cached;
    let resolved = this.workingDirectory;
    try {
      const session = await this.sessions?.get(sessionId);
      const wd = session?.workingDirectory?.trim();
      if (wd && existsSync(wd)) resolved = wd;
    } catch {
      /* fall back to the global root */
    }
    this.sessionWorkingDirs.set(sessionId, resolved);
    return resolved;
  }

  /** Public wrapper so routes (e.g. native slash command execution) can
   *  resolve a session's working directory without a private-method breach. */
  async resolveSessionWorkingDirectoryPublic(sessionId: string): Promise<string> {
    return this.resolveSessionWorkingDirectory(sessionId);
  }

  /** Last provider/model the manager routed a task to for a session, or null.
   *  Used by routes that need the active CLI harness (e.g. native /commands). */
  getLastManagerRouting(
    sessionId: string,
  ): { model: string; provider: ProviderName | undefined } | null {
    return this.managerRoutingBySession.get(sessionId) ?? null;
  }

  // ── MCP bridge + hooks bridge helpers ───────────────────────────────────
  // These methods are called by the /api/v1/mcp-bridge/hooks/* endpoints to
  // let CLI lifecycle hooks query Kory state.

  /** Build the Kory context injection string for a session. Called by the
   *  UserPromptSubmit hook to inject Kory context into CLI prompts. */
  async buildContextInjection(sessionId: string): Promise<string> {
    try {
      const session = await this.sessions?.get(sessionId);
      if (!session) return '';
      const parts: string[] = [];
      // Surface the goal context if set for this session.
      const goalCtx = this.goalContextBySession.get(sessionId);
      if (goalCtx) {
        parts.push(`Active goal: ${goalCtx.objective} (item: ${goalCtx.itemTitle})`);
      }
      return parts.join('\n\n');
    } catch {
      return '';
    }
  }

  /** Check if the critic gate allows the CLI to stop. Called by the Stop hook.
   *  Returns false if the critic has not verified the work as complete. */
  async criticGateMayStop(sessionId: string): Promise<boolean> {
    const changes = this.state.getChanges(sessionId);
    if (changes.length === 0) return true;
    if (this.cliMutationVerifiedBySession.get(sessionId) === true) return true;

    const gate = await this.runCriticGate(
      sessionId,
      [{
        role: 'user',
        content: `CLI-authored change set requiring verification:\n${JSON.stringify(changes, null, 2)}`,
      }],
      undefined,
      'Fix and verify the CLI-authored repository changes without hidden scope expansion',
      await this.resolveSessionWorkingDirectory(sessionId),
    );
    this.cliMutationVerifiedBySession.set(sessionId, gate.passed);
    return gate.passed;
  }

  /** Goal Mode completion is adjudicated by a fresh critic, never by the producer alone. */
  async verifyGoalItem(
    sessionId: string,
    objective: string,
    itemTitle: string,
    preferredModel?: string,
  ): Promise<{ passed: boolean; feedback?: string; skipped?: boolean }> {
    const recent = (await this.messages?.getRecent(sessionId, 20)) ?? [];
    const transcript = recent.map((message) => ({
      role: message.role,
      content: message.content,
    })) as InternalMessage[];
    return this.runCriticGate(
      sessionId,
      transcript,
      preferredModel,
      `Goal objective: ${objective}\nChecklist item: ${itemTitle}\nVerify this item is actually complete with concrete evidence.`,
      await this.resolveSessionWorkingDirectory(sessionId),
    );
  }

  /** A producer may propose a blocker, but an enabled Critic decides whether it is real. */
  async verifyGoalBlocker(
    sessionId: string,
    objective: string,
    itemTitle: string,
    blocker: string,
    preferredModel?: string,
  ): Promise<{ passed: boolean; feedback?: string; skipped?: boolean }> {
    const recent = (await this.messages?.getRecent(sessionId, 20)) ?? [];
    const transcript = recent.map((message) => ({ role: message.role, content: message.content })) as InternalMessage[];
    return this.runCriticGate(
      sessionId,
      transcript,
      preferredModel,
      `Goal objective: ${objective}\nChecklist item: ${itemTitle}\nProposed blocker: ${blocker}\nDecide whether this is a genuine blocker after safe alternatives were exhausted. PASS only if continued autonomous work is not currently possible.`,
      await this.resolveSessionWorkingDirectory(sessionId),
    );
  }

  /** Record a file change from a CLI tool execution. Called by the MCP bridge
   *  execute endpoint so changes made via kory__ tools are tracked. */
  recordChange(sessionId: string, change: any): void {
    try {
      this.state.recordChange(sessionId, change);
      this.cliMutationVerifiedBySession.set(sessionId, false);
    } catch {
      // best effort — the state may not exist for CLI-only sessions
    }
  }

  /** Enforce enabled file/line limits before a Kory-owned file tool mutates the workspace. */
  async enforceAutonomyLimits(
    sessionId: string,
    proposal: FileChangeProposal,
  ): Promise<{ allowed: boolean; reason?: string }> {
    const settings = loadAgentSettings(await this.resolveSessionWorkingDirectory(sessionId));
    if (!settings.autonomyLimitsEnabled) return { allowed: true };

    const recordedChanges = this.state.getChanges(sessionId);
    const filesChanged = new Set([
      ...recordedChanges.map((change) => change.path),
      ...proposal.paths,
    ]).size;
    const linesChanged =
      recordedChanges.reduce(
        (total, change) => total + change.linesAdded + change.linesDeleted,
        0,
      ) + proposal.linesChanged;

    if (
      filesChanged <= settings.approvalThresholdFiles &&
      linesChanged <= settings.approvalThresholdLines
    ) {
      return { allowed: true };
    }

    const response = await this.waitForUserInputInternal(
      sessionId,
      `Autonomy limits are active. This edit would reach ${filesChanged} files and ${linesChanged} changed lines (limits: ${settings.approvalThresholdFiles} files / ${settings.approvalThresholdLines} lines). Apply it?`,
      ['Apply this edit', 'Keep limits on — do not apply'],
    );
    if (response === 'Apply this edit') return { allowed: true };
    return { allowed: false, reason: 'Edit was not approved under the active autonomy limits.' };
  }

  private emitUsageUpdate(
    sessionId: string,
    agentId: string,
    model: string,
    provider: ProviderName,
    tokensIn: number,
    tokensOut: number,
    usageKnown: boolean,
    breakdown?: ContextBreakdown,
  ) {
    this.events.emitUsageUpdate(
      sessionId,
      agentId,
      model,
      provider,
      tokensIn,
      tokensOut,
      usageKnown,
      breakdown,
    );
    // Persist only provider/CLI-reported usage. A chars/4 planning estimate
    // must never survive a reload looking like a real token count.
    if (agentId === KORY_IDENTITY.id && usageKnown) {
      const win = resolveTrustedContextWindow(model, provider);
      void getContextArchive()?.recordUsage(sessionId, {
        used: tokensIn + tokensOut,
        max: win.contextWindow ?? 0,
        contextKnown: win.contextKnown,
        ...(breakdown ? { breakdown } : {}),
        ts: Date.now(),
      });
      // Window resolution can lose the startup race (provider model lists
      // refresh in the background). Retry once shortly after — if the window
      // is known by then, re-emit so the bar stops saying "unknown".
      if (!win.contextKnown) {
        const t = setTimeout(() => {
          const retry = resolveTrustedContextWindow(model, provider);
          if (retry.contextKnown) {
            this.emitUsageUpdate(
              sessionId,
              agentId,
              model,
              provider,
              tokensIn,
              tokensOut,
              usageKnown,
              breakdown,
            );
          }
        }, 6_000);
        t.unref?.();
      }
    }
  }
  private emitWSMessage(sessionId: string, type: string, payload: WSMessage['payload']) {
    this.events.emit(sessionId, type, payload);
  }
}

/** Character weight of a provider message list — feeds the context bar's
 *  "chat" segment estimate (images weighted as ~1k tokens' worth of chars). */
/** Split conversation size into CHAT (what the user typed + what the agent
 *  typed back) vs TOOL traffic (tool calls + tool results). The context bar
 *  shows these separately — "chat" should be only the conversation, never the
 *  tool plumbing. */
function estimateProviderMessagesChars(messages: ProviderMessage[]): {
  chat: number;
  tools: number;
} {
  let chat = 0;
  let tools = 0;
  for (const m of messages) {
    // role:'tool' messages are tool results even when content is a plain string.
    if (typeof m.content === 'string') {
      if (m.role === 'tool') tools += m.content.length;
      else chat += m.content.length;
      continue;
    }
    for (const b of m.content) {
      if (b.type === 'text') chat += b.text?.length ?? 0;
      else if (b.type === 'image') chat += 4000;
      else if (b.type === 'tool_use')
        tools += (b.toolName?.length ?? 0) + JSON.stringify(b.toolInput ?? {}).length;
      else if (b.type === 'tool_result') tools += b.toolOutput?.length ?? 0;
    }
  }
  return { chat, tools };
}
