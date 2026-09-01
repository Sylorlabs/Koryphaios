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
  KoryAskUserResolvedPayload,
  KorySessionChangesPayload,
  KorySessionChangesResolvedPayload,
  ChangeSummary,
  StreamUsagePayload,
  StreamThinkingPayload,
  ContextBreakdown,
  SessionRunActivePhase,
  SessionRunPhase,
  StoredMessage,
} from '@koryphaios/shared';
import { SANDBOX_PRESETS, SessionRunTransitionError } from '@koryphaios/shared';
import { normalizeReasoningLevel, determineAutoReasoningLevel } from '@koryphaios/shared';
import { AGENT, DOMAIN, SESSION } from '../constants';
import {
  ProviderRegistry,
  resolveTrustedContextWindow,
  isLegacyModel,
  getNonLegacyModels,
  withTimeoutSignal,
  type StreamRequest,
  type ProviderEvent,
  type Provider,
} from '../providers';
import type { ProviderMessage } from '../providers/types';
import { JULES_APPROVAL_REQUIRED_ERROR } from '../providers/jules-runner';
import { JULES_SYNC_INSTRUCTIONS, getProviderDisplay } from '../providers/provider-display';
import {
  imageAttachmentAdmissionError,
  omitImageInputs,
  type ImageInputMode,
} from '../providers/attachment-admission';
import {
  ToolRegistry,
  decideToolPermission,
  resolveToolPermissionPolicy,
  resolveSandboxOptions,
  resolveSubAgentPermissionPolicy,
  resolveSubAgentSandboxOptions,
  type ToolCallInput,
  type ToolContext,
  type ToolCallOutput,
} from '../tools';
import { wsBroker } from '../pubsub';
import { koryLog, serverLog } from '../logger';
import {
  initContextArchive,
  getContextArchive,
  usageSnapshotMatchesBoundary,
} from './context-archive';
import { nanoid } from 'nanoid';
import { AsyncLocalStorage } from 'node:async_hooks';
import { redactSecretsInText, sanitizeForPrompt } from '../security';
import { logBackgroundRegistrationFailure } from '../security/bash-sandbox';
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
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { join, resolve } from 'node:path';
import { db, sessions } from '../db';
import { eq } from 'drizzle-orm';
import type { ISessionStore } from '../stores/session-store';
import type {
  IMessageStore,
  RegenerationBranchReservation,
} from '../stores/message-store';
import type { ITaskStore } from '../stores/task-store';
import { SnapshotManager } from './snapshot-manager';
import { processSupervisor } from '../process-supervisor/supervisor';
import type { ProcessLifecycleEvent } from '../process-supervisor/supervisor';
import type { PersistedProcess } from '../process-supervisor/database';
import {
  canonicalSessionTurnInputHash,
  deriveSessionTurnCommandIdentity,
  SessionTurnCommandConflictError,
  type SessionTurnCommandRecord,
  type RestartHandoffConversationBoundary,
  type SessionRunRestartHandoff,
} from '../runs/session-run-store';
import { GitManager } from './git-manager';
import { WorkspaceManager } from './workspace-manager';
import {
  EventEmitterService,
  WorkerLifecycleService,
  SessionStateService,
  WorkerPipelineService,
} from './services';
import type { WorkflowHook, WorkflowHookEvent } from './services/EventEmitterService';
import { ProcessCompletionCoordinator } from './services/ProcessCompletionCoordinator';
import { TimeTravelService } from '../services';
import { computeCostUsd } from '../pricing';
import { RoutingServiceEnhanced } from './services/RoutingServiceEnhanced';
import {
  parseCriticVerdict,
  formatMessagesForCritic as formatMessagesForCriticUtil,
} from './critic-util';
import { getModeManager } from '../mode';
import type { WorkerPipelineHost } from './services/WorkerPipelineService';
import type { UIMode } from '@koryphaios/shared';
import type { SessionRunCoordinator } from '../runs/session-run-coordinator';
import {
  ManagerRunLifecycle,
  type ManagerRunHandle,
} from './services/ManagerRunLifecycle';
import { ConflictError } from '../errors/types';
import {
  CRITIC_OUTPUT_TOKEN_LIMIT,
  MANAGER_OUTPUT_TOKEN_LIMIT,
  WORKER_OUTPUT_TOKEN_LIMIT,
  compilePrompt,
  createTaskContract,
  estimateOccupiedContextTokenUpperBound,
  requiresMultiAgentDelegation,
  textTokenUpperBound,
} from './prompts';
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
  type AgentSettings,
} from '../agent-settings';
import { assembleMemoryContext, formatMemoryForContext } from '../memory/unified-memory';
import { readSessionMemory, writeSessionMemory } from '../memory/unified-memory';
import {
  acceptSessionReview,
  beginSessionReviewRejection,
  completeSessionReviewRejection,
  ensurePendingSessionReview,
  getPendingSessionReview,
  getSessionReview,
  terminalizeInterruptedSessionReviewRejections,
  terminalizeSessionReview,
  type DurableSessionReview,
  type SessionReviewRollback,
} from '../stores/session-review-store';
import { ensurePlanNote, syncPlanNote } from './plan-mode';
import { automaticMemoryPrompt } from './settings-contract';
import { resolveSkills } from './skills';
import { rankHarnessCandidates, type QualificationRole } from './skill-qualifications';
import {
  setCollaborationToolPolicy,
  clearCollaborationToolPolicy,
  type CollaborationToolPolicy,
} from '../collaboration/tool-policy';
import { checkAndEnforceCaps } from '../security/spend-caps-enforced';
import { getCliConversationRevision } from '../providers/cli-session-state';

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
  usage?: {
    tokensIn: number;
    tokensOut: number;
    usageKnown: boolean;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    breakdown?: ContextBreakdown;
  };
  completedToolCalls?: CompletedToolCall[];
  /** A native CLI harness performed work, even though it did not request a Kory tool call. */
  observedNativeTool?: boolean;
}

interface CriticGateResult {
  passed: boolean;
  skipped?: boolean;
  feedback?: string;
  model?: string;
  provider?: string;
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
  promptCache: StreamRequest['promptCache'];
  toolRole: 'worker' | 'critic';
  reasoningLevel?: string;
  maxTurns: number;
  maxTokens: number;
  messages: InternalMessage[];
  threadEntries: AgentThreadEntry[];
  ctx: ToolContext;
  abort?: AbortController;
  busy: boolean;
  /** Exact owner task for a post-run follow-up. It remains set until the
   * provider/tool stack has acknowledged cancellation and released SessionRun. */
  activeRun?: Promise<void>;
  updatedAt: number;
}

// Agent threads contain complete prompts, provider replies, and tool results.
// They are useful while a user is inspecting or continuing an agent, but must
// never become an unbounded process-lifetime transcript store. Persistent chat
// history belongs in the session/message stores, not this live UI cache.
const AGENT_THREAD_IDLE_TTL_MS = 30 * 60 * 1000;
const MAX_COMPLETED_AGENT_THREADS_PER_SESSION = 24;

// ─── Default Model Assignments per Domain ───────────────────────────────────
// Model definitions are now resolved at runtime via live provider discovery,
// not from a static catalog. The DEFAULT_MODELS entries are validated lazily
// when a domain actually requests its model — a provider may not be connected
// at startup, so eager validation would reject every default.

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
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to parse JSON string in safeParseJson',
    );
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

export interface ManagerSessionErasureLease {
  waitForIdle(timeoutMs?: number): Promise<void>;
  complete(): void;
  rollback(): void;
}

export type SessionTurnReason =
  | 'user_turn'
  | 'goal_turn'
  | 'collaboration_turn'
  | 'internal_turn'
  | 'regenerate_turn'
  | 'image_turn'
  | 'image_regenerate_turn'
  | 'agent_followup_turn'
  | 'user_input_after_restart';

/** Opaque, single-use proof that a session claim and durable run were acquired. */
export interface SessionTurnAdmission {
  readonly sessionId: string;
  readonly runId: string;
  readonly signal: AbortSignal;
}

export interface SessionTurnResult {
  readonly sessionId: string;
  readonly runId: string;
  readonly status:
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'waiting'
    | 'rejected'
    | 'unknown';
  readonly phase: SessionRunPhase;
  readonly reason: string | null;
}

export interface SessionTurnCommandInput extends AdmittedTaskInput {
  sessionId: string;
  source: 'goal' | 'collaboration' | 'internal';
  /** Stable source-owned identity. Reusing it never replays an interrupted turn. */
  sourceCommandId: string;
}

export type SessionTurnSubmission =
  | {
      accepted: true;
      sessionId: string;
      runId: string;
      completion: Promise<SessionTurnResult>;
    }
  | { accepted: false; result: SessionTurnResult };

export interface AdmittedTaskInput {
  userMessage: string;
  preferredModel?: string;
  reasoningLevel?: string;
  attachments?: Array<{ type: string; data: string; name: string; mimeType?: string }>;
  collaborationToolPolicy?: CollaborationToolPolicy;
  responseVariant?: { groupId: string; index: number };
  goalContext?: import('./prompts').TaskContract['goalContext'];
  interactionMode?: 'act' | 'plan';
  fastMode?: boolean;
  inputAlreadyPersisted?: boolean;
  imageInputMode?: ImageInputMode;
  /** Anchored sibling branch. It changes the active head only when a response commits. */
  regenerationBranch?: RegenerationBranchReservation;
  /** Stable completion projection for a durable command retry. */
  responseMessageId?: string;
}

export interface AdmittedWorkContext {
  readonly signal: AbortSignal;
  phase(phase: SessionRunActivePhase, reason?: string): Promise<void>;
}

interface AdmissionRecord {
  controller: AbortController;
  handle: ManagerRunHandle;
}

export class KoryManager implements WorkerPipelineHost {
  private memoryDir: string;
  private isProcessing = false;
  private isYoloMode = false;
  private snapshotManager: SnapshotManager;
  public readonly git: GitManager;
  private workspaceManager: WorkspaceManager | null = null;
  /** AbortController for the current manager run per session (so cancelSessionWorkers can abort manager too). */
  private managerAbortBySession = new Map<string, AbortController>();
  /** Synchronous intent claims cover provider resolution, intent interviews,
   * and every other pre-controller await. Time Travel uses the paired mutation
   * barrier so a new manager turn cannot start between its busy check and the
   * workspace transaction. */
  private sessionRunClaims = new Set<string>();
  /** Object-identity registry makes admission tokens single-use and unforgeable. */
  private turnAdmissions = new Map<SessionTurnAdmission, AdmissionRecord>();
  /** Async execution provenance. A callback retains the exact run generation
   * that created it, so late work from run A cannot borrow run B's lease. */
  private readonly runContext = new AsyncLocalStorage<ManagerRunHandle>();
  private readonly runControllerByHandle = new WeakMap<ManagerRunHandle, AbortController>();
  private shutdownPromise: Promise<void> | null = null;
  private sessionMutationBarriers = new Set<string>();
  /** Permanent process-lifetime tombstones stop stale callbacks from reviving
   * a session after its durable row and archives have been erased. */
  private erasedSessions = new Set<string>();
  /** Heartbeat timers per session — emit agent.heartbeat every 5s while a
   *  run is active so the client watchdog can distinguish "alive but quiet"
   *  (long tool call) from "dead — terminal event was dropped". */
  private heartbeatBySession = new Map<string, ReturnType<typeof setInterval>>();
  /** Latest manager phase per session, used to populate agent.heartbeat.
   *  Updated at every agent.status emit for kory-manager and at stream/tool
   *  transitions. */
  private heartbeatPhaseBySession = new Map<string, AgentStatus>();
  /** In-memory worker/critic chat threads keyed by agentId. */
  private agentThreads = new Map<string, AgentThreadState>();
  /** Services */
  private events: EventEmitterService;
  private routing: RoutingServiceEnhanced;
  private workers: WorkerLifecycleService;
  private state: SessionStateService;
  private workerPipeline: WorkerPipelineService;
  private processCompletionCoordinator: ProcessCompletionCoordinator;
  private runLifecycle: ManagerRunLifecycle;
  private unsubscribeProcessLifecycle?: () => void;
  /** Sessions whose title has already been auto-generated. Prevents racing
   *  LLM calls when the user sends a second message before the first title
   *  resolves. */
  private titledSessions = new Set<string>();
  private titleGenerationBySession = new Map<string, AbortController>();
  private usageRetryTimersBySession = new Map<string, Set<ReturnType<typeof setTimeout>>>();
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
  private compactingSessions = new Map<string, AbortController>();
  private readonly restartHandoffOwner = `kory-manager-${crypto.randomUUID()}`;
  private readonly restartHandoffTasks = new Map<string, Promise<void>>();
  private readonly restartHandoffConsumers = new Map<
    string,
    { sessionId: string; controller: AbortController }
  >();
  private readonly restartHandoffRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
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
    private readonly runs: SessionRunCoordinator | undefined = undefined,
  ) {
    this.memoryDir = join(workingDirectory, '.koryphaios/memory');
    mkdirSync(this.memoryDir, { recursive: true });
    this.snapshotManager = new SnapshotManager(workingDirectory);
    this.git = new GitManager(workingDirectory);
    initContextArchive(workingDirectory);

    // Initialize services
    this.events = new EventEmitterService({ managerAgentId: KORY_IDENTITY.id });
    this.routing = new RoutingServiceEnhanced({ config: this.config, providers: this.providers });
    this.workers = new WorkerLifecycleService({ events: this.events });
    this.state = new SessionStateService();
    this.runLifecycle = new ManagerRunLifecycle(runs);

    this.processCompletionCoordinator = new ProcessCompletionCoordinator({
      isSessionBusy: (sessionId) => this.isLocallyBlockedForProcessWake(sessionId),
      hasActiveAgentProcess: (sessionId) =>
        processSupervisor.hasActiveAgentToolForSession(sessionId),
      wakeSession: (sessionId, events) => this.wakeForProcessCompletions(sessionId, events),
      onWakeError: (sessionId, error) =>
        koryLog.warn({ sessionId, error }, 'Background-process wake-up failed; batch retained'),
    });

    // Background terminals: surface start/exit in the chat feed and wake the
    // agent when a process it was waiting on finishes.
    this.unsubscribeProcessLifecycle = processSupervisor.onLifecycle((e) => {
      if (!e.sessionId) return;
      const eventType =
        e.type === 'started'
          ? 'process.started'
          : e.type === 'degraded'
            ? 'process.status'
            : 'process.exited';
      this.emitWSMessage(e.sessionId, eventType, {
        id: e.id,
        name: e.name,
        command: redactSecretsInText(e.command, 1_000),
        pid: e.pid,
        exitCode: e.exitCode,
        status: e.status,
        provenance: e.provenance,
        supervision: e.supervision,
        isBackground: e.isBackground,
        terminalReason: e.terminalReason,
        terminalError: e.terminalError ? redactSecretsInText(e.terminalError, 2_000) : undefined,
        willRestart: e.willRestart,
        logsTail: e.logsTail ? redactSecretsInText(e.logsTail, 4_000) : undefined,
        recovered: e.recovered,
      });
      if (e.type === 'exited') this.processCompletionCoordinator.enqueue(e);
    });

    // KoryManager implements WorkerPipelineHost directly — no closure bag.
    // TypeScript verifies conformance; the service depends on the interface,
    // not on KoryManager, so it stays testable in isolation.
    this.workerPipeline = new WorkerPipelineService({
      providers: this.providers,
      state: this.state,
      git: this.git,
      workspaceManager: this.workspaceManager,
      snapshotManager: this.snapshotManager,
      tasks: this.tasks,
      host: this,
    });

    // Initialize WorkspaceManager if git is available.
    // init() is async (git repo check, worktree recovery) so we fire-and-forget
    // it the same way recoverState() is launched below. Until init completes,
    // workspaceManager stays null and workers fall back to the main directory.
    try {
      if (this.git.isGitRepo()) {
        const wm = new WorkspaceManager(workingDirectory, config.workspace);
        void wm
          .init()
          .then(() => {
            this.workspaceManager = wm;
            this.workerPipeline.workspaceManager = wm;
            koryLog.info('WorkspaceManager initialized for parallel agent isolation');
          })
          .catch((err: unknown) => {
            serverLog.debug(
              { err: err instanceof Error ? err.message : String(err) },
              'WorkspaceManager init failed',
            );
            koryLog.warn('WorkspaceManager unavailable — workers will share the main directory');
          });
      }
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'WorkspaceManager initialization failed',
      );
      koryLog.warn('WorkspaceManager unavailable — workers will share the main directory');
    }

    // Recover state from persistent stores
    this.recoverState();
  }

  /** Resolve only a work-admissible session. The fallback keeps narrow test
   * doubles honest while production stores use the indexed active lookup. */
  private async getActiveSession(sessionId: string) {
    if (!this.sessions) return undefined;
    if (typeof this.sessions.getActive === 'function') {
      return this.sessions.getActive(sessionId);
    }
    const session = await this.sessions.get(sessionId);
    return session?.archivedAt === undefined ? session : undefined;
  }

  private async wakeForProcessCompletions(
    sessionId: string,
    events: ProcessLifecycleEvent[],
  ): Promise<void> {
    if (!this.tryBeginSessionRun(sessionId)) {
      throw new Error('Session became busy before its background-process completion drained');
    }
    const wakeAbort = new AbortController();
    this.managerAbortBySession.set(sessionId, wakeAbort);
    try {
      await this.wakeForProcessCompletionsWithClaim(sessionId, events);
    } finally {
      if (this.managerAbortBySession.get(sessionId) === wakeAbort) {
        this.managerAbortBySession.delete(sessionId);
      }
      this.endSessionRun(sessionId);
    }
  }

  private async wakeForProcessCompletionsWithClaim(
    sessionId: string,
    events: ProcessLifecycleEvent[],
  ): Promise<void> {
    if (this.sessions && !(await this.getActiveSession(sessionId))) {
      koryLog.info(
        { sessionId },
        'Discarding process completion for a missing or archived session',
      );
      return;
    }

    const resumed = await this.runLifecycle.resumeProcessWait(sessionId);
    if (!resumed.handle) {
      throw new Error(`Session ${sessionId} process wait resumed without an execution handle`);
    }
    const ownerController = this.managerAbortBySession.get(sessionId);
    if (!ownerController) {
      throw new Error(`Session ${sessionId} process wake has no cancellation owner`);
    }
    this.runControllerByHandle.set(resumed.handle, ownerController);
    await this.runContext.run(resumed.handle, async () => {
      try {
        await this.continueProcessWake(
          sessionId,
          events,
          resumed.processIds,
          resumed.continuationId,
          resumed.expectedBoundary,
        );
      } catch (error) {
        const aborted =
          ownerController.signal.aborted ||
          (error instanceof Error && error.name === 'AbortError');
        await this.runLifecycle.finish(
          resumed.handle!,
          aborted ? 'cancel' : 'fail',
          aborted
            ? 'cancelled_by_user'
            : error instanceof Error
              ? error.message
              : String(error),
        );
        // Once the durable continuation is claimed, replaying a provider/tool
        // turn is unsafe: external side effects may already have happened.
        // The failed SessionRun is the explicit recovery surface; consume the
        // coordinator batch instead of silently retrying it.
        if (!aborted) {
          this.emitError(
            sessionId,
            `Background-process continuation failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    });
  }

  private async continueProcessWake(
    sessionId: string,
    events: ProcessLifecycleEvent[],
    processIds: readonly string[],
    continuationId: string | null,
    expectedBoundary: RestartHandoffConversationBoundary | null,
  ): Promise<void> {
    if (!this.messages) throw new Error('Message store unavailable for process continuation');
    if (!continuationId || !expectedBoundary) {
      throw new Error('Process continuation has no durable conversation boundary');
    }
    const handle = this.requireRunHandle(sessionId);
    this.assertRunHandleActive(handle);
    events = this.toRecoveredProcessEvents(
      await this.loadExactAgentProcesses(sessionId, processIds),
    );
    this.assertRunHandleActive(handle);

    const outcomes = events
      .map((event) => {
        const exit = event.exitCode === undefined ? 'unknown' : String(event.exitCode);
        const output = event.logsTail
          ? `\nRecent output:\n${redactSecretsInText(event.logsTail.slice(-1_200), 1_200)}`
          : '\nNo output was captured; do not infer success from missing logs.';
        return (
          `- ${event.name} [id=${event.id}] ${event.status}; ` +
          `reason=${event.terminalReason ?? 'unknown'}; exit=${exit}\n` +
          `  command: ${redactSecretsInText(event.command.slice(0, 160), 160)}${output}`
        );
      })
      .join('\n');
    const summary =
      `[background terminal completion]\n${events.length} supervised process${events.length === 1 ? '' : 'es'} reached an authoritative terminal state:\n` +
      `${outcomes.slice(0, 8_000)}\n` +
      'Review the outcomes, inspect full captured logs with shell_manage when needed, repair concrete failures, and report truthfully.';

    const inputMessageId = `process-wake-user-${continuationId}`;
    const responseMessageId = `process-wake-response-${continuationId}`;
    this.assertRunHandleActive(handle);
    await this.messages.addIdempotentAtBoundary(
      sessionId,
      {
        id: inputMessageId,
        sessionId,
        role: 'user',
        content: summary,
        createdAt: Date.now(),
      },
      expectedBoundary,
    );
    this.assertRunHandleActive(handle);

    // Runtime waits already have a parked heartbeat; restart-recovery wakes do
    // not. Re-baseline both cases before entering the provider turn.
    this.startHeartbeat(sessionId);
    this.setHeartbeatPhase(sessionId, 'analyzing');
    this.emitWSMessage(sessionId, 'agent.status', {
      agentId: KORY_IDENTITY.id,
      status: 'analyzing',
      detail: 'Preparing the request',
    });
    this.assertRunHandleActive(handle);
    await this.handleDirectly(
      sessionId,
      summary,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      'reject',
      undefined,
      responseMessageId,
    );
    const snapshot = this.runs?.get(sessionId);
    if (!snapshot || (snapshot.status !== 'waiting' && snapshot.status !== 'terminal')) {
      throw new Error('Process continuation returned without a durable run outcome');
    }
  }

  /**
   * Reconcile process waits whose terminal database rows predate this backend
   * process. The normal supervisor subscription covers terminals discovered
   * during initialize(); this covers rows that were already terminal before
   * the previous backend crashed after persistence but before callback drain.
   */
  async recoverDurableProcessWaits(): Promise<{
    queued: number;
    preserved: number;
    cancelled: number;
    failed: number;
  }> {
    let queued = 0;
    let preserved = 0;
    let cancelled = 0;
    let failed = 0;
    for (const wait of this.runLifecycle.listProcessWaits()) {
      try {
        const processes = await this.loadExactAgentProcesses(
          wait.snapshot.sessionId,
          wait.processIds,
        );
        if (processes.some((process) => process.terminalReason === 'session-cancelled')) {
          this.processCompletionCoordinator.cancelSession(wait.snapshot.sessionId);
          await this.runLifecycle.cancelCurrent(
            wait.snapshot.sessionId,
            'recovered_session_cancellation',
          );
          cancelled++;
          continue;
        }
        if (processes.some((process) => process.terminalReason === 'killed-for-restart')) {
          throw new Error('Durable process wait ended during an incomplete process restart');
        }
        if (
          processes.some((process) => process.status === 'starting' || process.status === 'running')
        ) {
          preserved++;
          continue;
        }
        const events = this.toRecoveredProcessEvents(processes);
        this.processCompletionCoordinator.resumeSession(wait.snapshot.sessionId);
        const accepted = this.processCompletionCoordinator.enqueueRecoveredBatch(events);
        // Zero can mean initialize() already queued or is draining this exact
        // continuation. Either case is healthy and must not be double-woken.
        if (
          accepted > 0 ||
          this.processCompletionCoordinator.pendingCount(wait.snapshot.sessionId) > 0 ||
          this.processCompletionCoordinator.isWaking(wait.snapshot.sessionId)
        ) {
          queued++;
        }
      } catch (error) {
        failed++;
        const reason = `process_wait_recovery_failed: ${error instanceof Error ? error.message : String(error)}`;
        await this.runLifecycle.failCurrent(wait.snapshot.sessionId, reason);
        koryLog.error(
          { sessionId: wait.snapshot.sessionId, error },
          'Failed closed while reconciling a durable background-process wait',
        );
      }
    }
    return { queued, preserved, cancelled, failed };
  }

  private async loadExactAgentProcesses(
    sessionId: string,
    processIds: readonly string[],
  ): Promise<PersistedProcess[]> {
    if (processIds.length === 0) throw new Error('Durable process wait has no process ids');
    const records = await processSupervisor.getAgentBackgroundProcessesBySession(sessionId);
    const byId = new Map(records.map((process) => [process.id, process]));
    const exact = processIds.map((id) => byId.get(id));
    const missing = processIds.filter((_id, index) => !exact[index]);
    if (missing.length > 0) {
      throw new Error(`Durable process wait references missing ids: ${missing.join(', ')}`);
    }
    return exact as PersistedProcess[];
  }

  private toRecoveredProcessEvents(
    processes: readonly PersistedProcess[],
  ): ProcessLifecycleEvent[] {
    return processes.map((process) => {
      if (
        process.status === 'starting' ||
        process.status === 'running' ||
        process.status === 'detached' ||
        process.terminalReason === 'session-cancelled' ||
        process.terminalReason === 'killed-for-restart'
      ) {
        throw new Error(
          `Process ${process.id} is not in an authoritative terminal state (${process.status})`,
        );
      }
      return {
        type: 'exited',
        id: process.id,
        name: process.name,
        command: process.command,
        sessionId: process.sessionId,
        pid: process.pid,
        exitCode: process.exitCode,
        status: process.status,
        provenance: process.provenance,
        supervision: process.supervision,
        isBackground: process.isBackground,
        terminalReason: process.terminalReason,
        terminalError: process.terminalError,
        willRestart: false,
        logsTail:
          [process.stdoutSnapshot, process.stderrSnapshot]
            .filter(Boolean)
            .join('\n')
            .slice(-2_000) || undefined,
        recovered: true,
      };
    });
  }

  private async recoverState() {
    try {
      const interrupted = await terminalizeInterruptedSessionReviewRejections();
      for (const review of interrupted) {
        const payload: KorySessionChangesResolvedPayload = {
          reviewId: review.reviewId,
          status: 'terminalized',
          reason: review.resolutionReason,
        };
        this.emitWSMessage(review.sessionId, 'session.changes_resolved', payload);
      }
      if (interrupted.length > 0) {
        koryLog.warn(
          { count: interrupted.length },
          'Terminalized interrupted session change rejections after restart',
        );
      }
    } catch (err) {
      // A review left in `rejecting` must never be retried blindly. Startup
      // proceeds so the explicit response path can surface the error, but the
      // failure is visible in the operational log.
      koryLog.error({ err }, 'Failed to reconcile interrupted session change rejections');
    }

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

  // ─── WorkerPipelineHost accessors ────────────────────────────────────────
  // These expose manager state/behavior to WorkerPipelineService via the
  // WorkerPipelineHost interface, replacing the prior closure bag.
  getIsYoloMode(): boolean {
    return this.isYoloMode;
  }

  getWorkingDirectory(): string {
    return this.workingDirectory;
  }

  getQualityPolicy(workingDirectory = this.workingDirectory): {
    gateStrictness: 'strict' | 'advisory' | 'off';
    maxCriticIterations: number;
  } {
    const settings = loadAgentSettings(workingDirectory);
    return {
      gateStrictness: settings.criticGateEnabled ? (settings.gateStrictness ?? 'strict') : 'off',
      maxCriticIterations: settings.maxCriticIterations,
    };
  }

  /** Public alias for runHardChecks — the WorkerPipelineHost contract names it runDestinationChecks. */
  runDestinationChecks(
    sessionId: string,
    workingDirectory: string,
  ): Promise<{ passed: boolean; output: string }> {
    return this.runHardChecks(sessionId, workingDirectory);
  }

  /** Reasoning level the manager uses for delegated workers (from config). */
  getWorkerReasoningLevel(): string {
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
    const workingDirectory = await this.resolveSessionWorkingDirectory(sessionId);
    const routing = this.resolveActiveRouting(
      preferredModel,
      'general',
      true,
      undefined,
      undefined,
      workingDirectory,
    );
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
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to parse affected paths from LLM response',
      );
      return [];
    }
  }

  async updateWorkflowState(sessionId: string, state: string) {
    await db.update(sessions).set({ workflowState: state }).where(eq(sessions.id, sessionId));
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
    if (!this.tryBeginSessionRun(input.sessionId)) {
      throw new Error('This session is already running or applying a Time Travel recovery');
    }
    // Install cancellation ownership before the first await. Without this,
    // cancelSessionWorkers can correctly detect the local run claim yet have
    // nothing to abort while archived-session/lifecycle/provider preflight is
    // still in progress.
    const abort = new AbortController();
    this.compactingSessions.set(input.sessionId, abort);
    let handle: ManagerRunHandle | null = null;
    try {
      if (this.sessions && !(await this.getActiveSession(input.sessionId))) {
        throw new Error('Recover this archived chat before compacting its conversation');
      }
      abort.signal.throwIfAborted();
      handle = await this.runLifecycle.begin(
        input.sessionId,
        input.automatic ? 'automatic_compaction' : 'manual_compaction',
      );
      abort.signal.throwIfAborted();
      return await this.runContext.run(handle, async () => {
        await this.runLifecycle.phase(handle!, 'compacting', 'compacting_conversation');
        abort.signal.throwIfAborted();
        const result = await this.compactSessionWithClaim(input, abort);
        await this.runLifecycle.finish(handle!, 'complete', 'compaction_completed');
        return result;
      });
    } catch (error) {
      if (handle) {
        const cancelled =
          abort.signal.aborted || (error instanceof Error && error.name === 'AbortError');
        await this.runLifecycle.finish(
          handle,
          cancelled ? 'cancel' : 'fail',
          cancelled
            ? 'cancelled_by_user'
            : error instanceof Error
              ? error.message
              : String(error),
        );
      }
      throw error;
    } finally {
      if (this.compactingSessions.get(input.sessionId) === abort) {
        this.compactingSessions.delete(input.sessionId);
      }
      this.endSessionRun(input.sessionId);
    }
  }

  private async compactSessionWithClaim(
    input: {
      sessionId: string;
      selectedModel: string;
      reasoningLevel?: string;
      automatic?: boolean;
    },
    abort: AbortController,
  ): Promise<{ compactionId: string; sourceMessages: number; checkpointTokens: number }> {
    if (!this.messages) throw new Error('Message store unavailable');
    abort.signal.throwIfAborted();
    const separator = input.selectedModel.indexOf(':');
    if (separator < 1) throw new Error('Select a model before compacting');
    const providerName = input.selectedModel.slice(0, separator) as ProviderName;
    const model = input.selectedModel.slice(separator + 1);
    const status = this.providers.getStatus().find((item) => item.name === providerName);
    if (!status?.adapterAvailable || !status.models.includes(model)) {
      throw new Error('The selected model is no longer available. Select another model.');
    }
    const provider = await this.providers.resolveProvider(model, providerName);
    if (!provider) throw new Error('The selected model provider is unavailable');
    abort.signal.throwIfAborted();

    const compactionId = nanoid(12);
    const automatic = input.automatic === true;
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
      const priorMemoryFile = readSessionMemory(projectRoot, input.sessionId);
      const priorMemory = priorMemoryFile.content;
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
      abort.signal.throwIfAborted();

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
        `## Durable Session Memory\n${String(parsed.durableMemory)}`,
      ].join('\n\n');
      if (summary.length < 200)
        throw new Error('The compaction checkpoint was too small; original history was preserved');

      emit('committing', 90, 'Committing the new context revision', {
        sourceMessages: conversational.length,
        sourceTokens,
      });
      abort.signal.throwIfAborted();
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
      // The authoritative durable memory is inside the atomically committed
      // checkpoint above. Keep memory.md as a convenient mirror; a filesystem
      // issue cannot retroactively turn a committed context revision into a
      // reported failure.
      try {
        writeSessionMemory(
          projectRoot,
          input.sessionId,
          String(parsed.durableMemory),
          priorMemoryFile.revision,
        );
      } catch (error) {
        koryLog.warn(
          { error, sessionId: input.sessionId },
          'Compaction memory mirror could not be updated',
        );
      }
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
      try {
        await this.updateWorkflowState(input.sessionId, 'idle');
      } catch (error) {
        koryLog.warn(
          { error, sessionId: input.sessionId },
          'Legacy workflow-state projection failed after compaction settled',
        );
      }
    }
  }

  async handleUserInput(sessionId: string, selection: string, text?: string, questionId?: string) {
    if (this.sessions && !(await this.getActiveSession(sessionId))) return;
    const answer = text || selection;
    const hadLiveWaiter = this.state.hasPendingInput(sessionId);
    const answered = await this.runLifecycle.answerQuestion(
      sessionId,
      answer,
      questionId,
      hadLiveWaiter,
    );
    if (questionId && !answered) return;
    if (answered) {
      // The lifecycle commits answered/cancelled input before returning. The
      // ordered control row then clears every subscribed renderer and prevents
      // a historical ask event from remaining actionable after reload.
      this.emitQuestionResolution(sessionId, answered.question.questionId, 'answered');
    }
    if (hadLiveWaiter && this.state.resolveUserInput(sessionId, answer)) return;
    if (hadLiveWaiter && answered?.handle) {
      const ownerController = this.runControllerByHandle.get(answered.handle);
      if (!ownerController?.signal.aborted) {
        await this.runLifecycle.finish(
          answered.handle,
          'fail',
          'live_user_input_waiter_disappeared',
        );
      }
    }
    if (answered?.handoff) this.scheduleRestartHandoff(answered.handoff);
  }

  async recoverDurableQuestionHandoffs(): Promise<{ requeued: number; queued: number }> {
    if (!this.runs) return { requeued: 0, queued: 0 };
    const requeued = this.runs.requeueExpiredRestartHandoffs(Date.now(), 100);
    const pending = this.runs.listPendingRestartHandoffs(100);
    for (const handoff of pending) this.scheduleRestartHandoff(handoff);
    return { requeued, queued: pending.length };
  }

  private scheduleRestartHandoff(handoff: SessionRunRestartHandoff): void {
    if (!this.runs || this.restartHandoffTasks.has(handoff.id)) return;
    const retryTimer = this.restartHandoffRetryTimers.get(handoff.id);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this.restartHandoffRetryTimers.delete(handoff.id);
    }
    const controller = new AbortController();
    this.restartHandoffConsumers.set(handoff.id, {
      sessionId: handoff.sessionId,
      controller,
    });
    const task = this.processRestartHandoff(handoff.id, controller.signal)
      .catch((error: unknown) => {
        koryLog.error(
          { handoffId: handoff.id, sessionId: handoff.sessionId, error },
          'Durable answered-question handoff failed',
        );
      })
      .finally(() => {
        this.restartHandoffTasks.delete(handoff.id);
        this.restartHandoffConsumers.delete(handoff.id);
      });
    this.restartHandoffTasks.set(handoff.id, task);
  }

  private scheduleRestartHandoffRetry(handoffId: string, attemptCount: number): void {
    if (!this.runs || this.restartHandoffRetryTimers.has(handoffId)) return;
    const delayMs = Math.min(30_000, Math.max(500, 500 * 2 ** Math.min(attemptCount, 6)));
    const timer = setTimeout(() => {
      this.restartHandoffRetryTimers.delete(handoffId);
      const pending = this.runs?.getRestartHandoff(handoffId);
      if (pending?.state === 'pending') this.scheduleRestartHandoff(pending);
    }, delayMs);
    timer.unref?.();
    this.restartHandoffRetryTimers.set(handoffId, timer);
  }

  private async processRestartHandoff(handoffId: string, signal: AbortSignal): Promise<void> {
    if (!this.runs || !this.sessions || !this.messages) return;
    if (signal.aborted) return;
    const LEASE_MS = 30_000;
    const claimed = this.runs.claimRestartHandoff(
      handoffId,
      this.restartHandoffOwner,
      LEASE_MS,
    );
    if (!claimed) return;
    const userMessageId = `restart-user-${claimed.id}`;
    const responseMessageId = `restart-response-${claimed.id}`;
    const renew = setInterval(() => {
      const renewed = this.runs?.renewRestartHandoff(
        claimed.id,
        claimed.claimToken,
        LEASE_MS,
      );
      if (!renewed) clearInterval(renew);
    }, LEASE_MS / 3);
    renew.unref?.();

    let admission: SessionTurnAdmission | null = null;
    let executionProjected = false;
    try {
      if (signal.aborted) return;
      // A prior attempt that durably projected its final answer is complete
      // even if the process died before acknowledging this command lease.
      if (await this.messages.getById(claimed.sessionId, responseMessageId)) {
        this.runs.consumeRestartHandoff(claimed.id, claimed.claimToken);
        return;
      }
      if (!claimed.expectedBoundary) {
        this.runs.abandonRestartHandoff(
          claimed.id,
          claimed.claimToken,
          'legacy restart handoff has no conversation boundary',
        );
        return;
      }
      if (await this.messages.getById(claimed.sessionId, userMessageId)) {
        // The prior owner crossed the durable execution boundary. Retrying a
        // model/tool turn could duplicate external side effects, so surface the
        // interrupted SessionRun and require an explicit user retry.
        this.runs.abandonRestartHandoff(
          claimed.id,
          claimed.claimToken,
          'replacement turn previously started but has no durable response',
        );
        return;
      }
      const session = await this.getActiveSession(claimed.sessionId);
      if (signal.aborted) return;
      if (!session) {
        const requeued = this.runs.requeueRestartHandoff(
          claimed.id,
          claimed.claimToken,
          'session unavailable or archived',
        );
        if (requeued) this.scheduleRestartHandoffRetry(claimed.id, claimed.attemptCount);
        return;
      }
      admission = await this.reserveSessionTurn(
        claimed.sessionId,
        'user_input_after_restart',
      );
      if (signal.aborted) {
        if (admission) {
          await this.cancelSessionTurn(admission, 'restart_handoff_cancelled_before_dispatch');
          admission = null;
        }
        return;
      }
      if (!admission) {
        const requeued = this.runs.requeueRestartHandoff(
          claimed.id,
          claimed.claimToken,
          'session busy; retry durable handoff',
        );
        if (requeued) this.scheduleRestartHandoffRetry(claimed.id, claimed.attemptCount);
        return;
      }
      const content = `Resume after restart. Pending question: ${claimed.question.question}\nUser answer: ${claimed.answer}`;
      try {
        await this.messages.addIdempotentAtBoundary(
          claimed.sessionId,
          {
            id: userMessageId,
            sessionId: claimed.sessionId,
            role: 'user',
            content,
            createdAt: claimed.createdAt,
          },
          claimed.expectedBoundary,
        );
        executionProjected = true;
      } catch (error) {
        await this.rejectSessionTurn(admission, 'restart_handoff_input_persistence_failed');
        admission = null;
        if (error instanceof ConflictError) {
          this.runs.abandonRestartHandoff(
            claimed.id,
            claimed.claimToken,
            `stale conversation boundary: ${error.message}`,
          );
          return;
        }
        throw error;
      }

      if (signal.aborted) {
        await this.cancelSessionTurn(admission, 'restart_handoff_cancelled_before_dispatch');
        admission = null;
        return;
      }

      const work = this.dispatchAdmittedTask(admission, {
        userMessage: content,
        interactionMode: session.interactionMode ?? 'act',
        inputAlreadyPersisted: true,
        responseMessageId,
      });
      admission = null;
      const outcome = await work;
      const responsePersisted = await this.messages.getById(
        claimed.sessionId,
        responseMessageId,
      );
      if (
        responsePersisted ||
        (outcome.status === 'waiting' && outcome.phase === 'waiting_terminal')
      ) {
        const consumed = this.runs.consumeRestartHandoff(claimed.id, claimed.claimToken);
        if (!consumed) throw new Error('Durable restart handoff lease expired before consumption');
        return;
      }
      this.runs.abandonRestartHandoff(
        claimed.id,
        claimed.claimToken,
        `replacement turn ${outcome.status}: ${outcome.reason ?? outcome.phase}; explicit retry required`,
      );
    } catch (error) {
      if (admission) {
        await (signal.aborted
          ? this.cancelSessionTurn(admission, 'restart_handoff_cancelled_before_dispatch')
          : this.rejectSessionTurn(admission, 'restart_handoff_dispatch_failed')
        ).catch(() => undefined);
      }
      if (signal.aborted) return;
      const reason = error instanceof Error ? error.message : String(error);
      if (executionProjected) {
        this.runs.abandonRestartHandoff(
          claimed.id,
          claimed.claimToken,
          `${reason}; replacement execution had already started`,
        );
      } else {
        const requeued = this.runs.requeueRestartHandoff(
          claimed.id,
          claimed.claimToken,
          reason,
        );
        if (requeued) this.scheduleRestartHandoffRetry(claimed.id, claimed.attemptCount);
      }
      throw error;
    } finally {
      clearInterval(renew);
    }
  }

  /** Resolve the exact durable project for a destructive keep/reject decision.
   * Legacy/global sessions are intentionally rejected here: falling back to
   * the manager launch directory could apply session B's checkpoint to repo A. */
  private async resolveSessionProjectForResponse(sessionId: string): Promise<string> {
    if (!this.sessions) {
      throw new Error('Cannot apply the change decision because the session store is unavailable');
    }
    const session = await this.sessions.get(sessionId);
    if (!session) {
      throw new Error(
        `Cannot apply the change decision because session ${sessionId} was not found`,
      );
    }
    const configured = session.workingDirectory?.trim();
    if (!configured) {
      throw new Error(
        'Cannot apply the change decision because this session has no project folder',
      );
    }
    const requested = resolve(configured);
    if (!existsSync(requested) || !statSync(requested).isDirectory()) {
      throw new Error(
        `Cannot apply the change decision because its project is unavailable: ${requested}`,
      );
    }
    return realpathSync(requested);
  }

  /** Build a durable, session-bound rollback contract before exposing a
   * change review. A best-effort `latest` snapshot is never a safe substitute
   * after restart: it can belong to another turn or an incomplete write. */
  private async reviewRollbackBinding(
    sessionId: string,
  ): Promise<{ projectRoot: string | null; rollback: SessionReviewRollback }> {
    let projectRoot: string | null = null;
    try {
      projectRoot = await this.resolveSessionProjectForResponse(sessionId);
    } catch (error) {
      return {
        projectRoot: null,
        rollback: {
          kind: 'unavailable',
          reason: `No exact session project is available: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
    const baselineHash = this.state.getCheckpoint(sessionId);
    if (baselineHash && new GitManager(projectRoot).isGitRepo()) {
      return { projectRoot, rollback: { kind: 'git', baselineHash } };
    }
    return {
      projectRoot,
      rollback: {
        kind: 'unavailable',
        reason:
          'No durable pre-change Git checkpoint was recorded for this review. Snapshot fallback is disabled because it cannot prove the exact pre-review baseline after restart.',
      },
    };
  }

  /** Persist the current actionable review before publishing it to the event
   * log. Replaying the event alone is never enough to authorize rollback. */
  private async publishPendingSessionReview(
    sessionId: string,
    changes: ChangeSummary[],
  ): Promise<DurableSessionReview> {
    const binding = await this.reviewRollbackBinding(sessionId);
    const review = await ensurePendingSessionReview({
      sessionId,
      changes,
      ...binding,
    });
    if (review.status !== 'pending') {
      throw new ConflictError('This change review was resolved while its projection was being prepared.');
    }
    const payload: KorySessionChangesPayload = {
      changes: review.changes,
      reviewId: review.reviewId,
    };
    this.emitWSMessage(sessionId, 'session.changes', payload);
    return review;
  }

  private emitSessionReviewResolution(
    sessionId: string,
    review: DurableSessionReview,
  ): void {
    const payload: KorySessionChangesResolvedPayload = {
      reviewId: review.reviewId,
      status: review.status === 'accepted' || review.status === 'rejected' || review.status === 'terminalized'
        ? review.status
        : 'terminalized',
      ...(review.resolutionReason ? { reason: review.resolutionReason } : {}),
    };
    this.emitWSMessage(sessionId, 'session.changes_resolved', payload);
  }

  private emitQuestionResolution(
    sessionId: string,
    questionId: string | undefined,
    status: KoryAskUserResolvedPayload['status'],
  ): void {
    const payload: KoryAskUserResolvedPayload = {
      ...(questionId ? { questionId } : {}),
      status,
    };
    this.emitWSMessage(sessionId, 'kory.ask_user_resolved', payload);
  }

  async handleSessionResponse(sessionId: string, accepted: boolean) {
    const sessionLease = this.tryAcquireSessionMutationBarrier(sessionId);
    if (!sessionLease) {
      throw new Error('Wait for active session work to finish before applying this decision');
    }
    const processLease = processSupervisor.tryAcquireAgentToolBarrier(sessionId);
    if (!processLease) {
      sessionLease.release();
      throw new Error('Wait for active agent terminals to finish before applying this decision');
    }
    try {
      if (this.sessions && !(await this.getActiveSession(sessionId))) {
        const current = await this.sessions.get(sessionId);
        if (current?.archivedAt !== undefined) {
          throw new ConflictError(
            'Recover this archived chat before accepting or rejecting its changes.',
          );
        }
        throw new Error(
          `Cannot apply the change decision because session ${sessionId} was not found`,
        );
      }
      const projectRoot = await this.resolveSessionProjectForResponse(sessionId);
      let review = await getPendingSessionReview(sessionId);
      // Compatibility for a still-live manager that predates durable review
      // publication. This path has the exact process-local baseline; after a
      // restart there is no in-memory fallback and the operation fails closed.
      const legacyChanges = this.state.getChanges(sessionId);
      if (!review && legacyChanges.length > 0) {
        review = await this.publishPendingSessionReview(sessionId, legacyChanges);
      }
      if (!review) {
        const previous = await getSessionReview(sessionId);
        if (previous?.status === 'rejecting') {
          const terminalized = await terminalizeSessionReview(
            previous,
            'Backend restarted while a rejection rollback was in progress. No additional rollback was attempted.',
          );
          if (terminalized) this.emitSessionReviewResolution(sessionId, terminalized);
          throw new Error(
            'The prior rejection was interrupted during rollback. Koryphaios made no additional filesystem changes; review the project manually before continuing.',
          );
        }
        if (previous) {
          throw new Error('This change review is no longer actionable.');
        }
        throw new Error('There is no pending change review for this session.');
      }
      if (review.projectRoot !== projectRoot) {
        const terminalized = await terminalizeSessionReview(
          review,
          'The session project changed after this review was created. Koryphaios refused to apply a decision against a different project.',
        );
        if (terminalized) this.emitSessionReviewResolution(sessionId, terminalized);
        throw new Error(
          'This review is bound to a different project directory. No change decision was applied.',
        );
      }

      if (accepted) {
        const resolved = await acceptSessionReview(review);
        if (!resolved) {
          throw new ConflictError('This change review was resolved by another operation.');
        }
        this.emitThought(sessionId, 'synthesizing', 'User accepted changes.');
        this.state.clearCheckpoint(sessionId);
        this.state.clearChanges(sessionId);
        this.emitSessionReviewResolution(sessionId, resolved);
        return;
      }

      if (review.rollback.kind !== 'git') {
        const terminalized = await terminalizeSessionReview(review, review.rollback.reason);
        if (terminalized) this.emitSessionReviewResolution(sessionId, terminalized);
        throw new Error(
          `Koryphaios cannot safely reject this review: ${review.rollback.reason}`,
        );
      }
      const baselineHash = review.rollback.baselineHash;

      // Persist the destructive operation claim first. If this backend dies
      // after Git starts, startup terminalizes the review instead of rerunning
      // reset/clean against a workspace whose current state is unknown.
      const rejecting = await beginSessionReviewRejection(review);
      if (!rejecting) {
        throw new ConflictError('This change review was resolved by another operation.');
      }
      if (rejecting.rollback.kind !== 'git') {
        const terminalized = await terminalizeSessionReview(
          rejecting,
          'The recorded Git rollback checkpoint was unavailable after the rejection was claimed.',
        );
        if (terminalized) this.emitSessionReviewResolution(sessionId, terminalized);
        throw new Error(
          'Koryphaios cannot safely reject this review because its rollback checkpoint is unavailable.',
        );
      }
      this.emitThought(sessionId, 'synthesizing', 'User rejected changes. Rolling back...');
      const projectGit = new GitManager(projectRoot);
      try {
        if (!projectGit.isGitRepo()) {
          throw new Error('The review project is no longer a Git repository.');
        }
        const rolledBack = await projectGit.rollback(baselineHash);
        if (!rolledBack) {
          throw new Error('The session project could not be restored to its recorded checkpoint.');
        }
      } catch (error) {
        const reason = `Rollback outcome is not safe to retry automatically: ${
          error instanceof Error ? error.message : String(error)
        }`;
        const terminalized = await terminalizeSessionReview(rejecting, reason);
        if (terminalized) this.emitSessionReviewResolution(sessionId, terminalized);
        throw error;
      }

      const resolved = await completeSessionReviewRejection(rejecting);
      if (!resolved) {
        const terminalized = await terminalizeSessionReview(
          rejecting,
          'Rollback completed but its durable acknowledgement could not be proven. No automatic retry will occur.',
        );
        if (terminalized) this.emitSessionReviewResolution(sessionId, terminalized);
        throw new Error(
          'Rollback completed but Koryphaios could not durably acknowledge it. No automatic retry will occur.',
        );
      }
      this.state.clearCheckpoint(sessionId);
      this.state.clearChanges(sessionId);
      this.emitSessionReviewResolution(sessionId, resolved);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitError(sessionId, message);
      throw error;
    } finally {
      processLease.release();
      sessionLease.release();
    }
  }

  private async handleManagerInquiry(
    sessionId: string,
    agentId: string,
    question: string,
    preferredModel?: string,
  ): Promise<string> {
    this.emitThought(sessionId, 'analyzing', `Worker help: "${question}"`);
    const workingDirectory = await this.resolveSessionWorkingDirectory(sessionId);
    const routing = this.resolveActiveRouting(
      preferredModel,
      'general',
      true,
      question,
      undefined,
      workingDirectory,
    );
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
          } catch (err: unknown) {
            serverLog.debug(
              { err: err instanceof Error ? err.message : String(err) },
              'Failed to parse route_inquiry tool input, defaulting to ANSWER',
            );
          }
        }
      }
    } catch (err) {
      koryLog.warn({ err }, 'Manager inquiry routing failed, defaulting to ANSWER');
    }

    if (decision === 'WEB_SEARCH') {
      const toolCtx: ToolContext = { sessionId, workingDirectory };
      const searchResult = await this.tools.execute(toolCtx, {
        id: nanoid(10),
        name: 'web_search',
        input: { query: question },
      });
      return `MANAGER ADVICE: ${searchResult.output}`;
    }
    return `MANAGER ANSWER: I recommend proceeding with the current task.`;
  }

  /** Public WorkerPipelineHost entry point — delegates to the internal impl. */
  waitForUserInput(
    sessionId: string,
    question: string,
    options: string[],
    opts?: { allowOther?: boolean; allowKeepChatting?: boolean },
  ): Promise<string> {
    return this.waitForUserInputInternal(sessionId, question, options, opts);
  }

  private async waitForUserInputInternal(
    sessionId: string,
    question: string,
    options: string[],
    opts?: { allowOther?: boolean; allowKeepChatting?: boolean },
  ): Promise<string> {
    const payload = await this.runLifecycle.waitForQuestion(this.requireRunHandle(sessionId), {
      question,
      options,
      allowOther: opts?.allowOther ?? true,
      allowKeepChatting: opts?.allowKeepChatting ?? true,
    });
    this.emitWSMessage(sessionId, 'kory.ask_user', payload satisfies KoryAskUserPayload);
    // The global task timeout may end the suspended provider run, but the DB
    // record remains answerable and resumes as a fresh turn after restart.
    const answer = await this.state.requestUserInput(sessionId, 0);
    return answer;
  }

  /** Surface an authenticated CLI bridge approval through the same durable UI
   *  question and resume path used by first-party manager and worker tools.
   *  Tool approvals are binary (approve/reject) — no custom response or
   *  keep-chatting option is offered unless explicitly requested via opts. */
  requestToolApproval(
    sessionId: string,
    question: string,
    options: string[],
    opts?: { allowOther?: boolean; allowKeepChatting?: boolean },
  ): Promise<string> {
    return this.waitForUserInputInternal(sessionId, question, options, {
      allowOther: opts?.allowOther ?? false,
      allowKeepChatting: opts?.allowKeepChatting ?? false,
    });
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
      const settings = loadAgentSettings(workingDirectory);
      saveAgentSettings(workingDirectory, {
        ...settings,
        skillCollisionChoices: { ...settings.skillCollisionChoices, ...choices },
      });
    }

    return choices;
  }

  /**
   * Reserve a turn before any route persists work it promises to execute.
   * The synchronous claim/controller installation closes the pre-await race;
   * the returned token is issued only after SessionRun start is committed.
   */
  async reserveSessionTurn(
    sessionId: string,
    reason: SessionTurnReason,
  ): Promise<SessionTurnAdmission | null> {
    if (!this.tryBeginSessionRun(sessionId)) return null;
    const controller = new AbortController();
    this.managerAbortBySession.set(sessionId, controller);
    let handle: ManagerRunHandle | null = null;
    try {
      if (this.sessions && !(await this.getActiveSession(sessionId))) {
        throw new Error('Recover this archived chat before starting new work.');
      }
      handle = await this.runLifecycle.begin(sessionId, reason);
      this.runControllerByHandle.set(handle, controller);
      if (controller.signal.aborted) {
        await this.runLifecycle.finish(handle, 'cancel', 'cancelled_during_admission');
        return null;
      }
      const admission = Object.freeze({
        sessionId,
        runId: handle.runId,
        signal: controller.signal,
      });
      this.turnAdmissions.set(admission, { controller, handle });
      return admission;
    } catch (error) {
      if (handle) {
        await this.runLifecycle.finish(handle, 'cancel', 'admission_failed').catch(() => undefined);
      }
      if (error instanceof SessionRunTransitionError && error.code === 'RUN_ALREADY_ACTIVE') {
        return null;
      }
      throw error;
    } finally {
      if (!handle || controller.signal.aborted) {
        if (this.managerAbortBySession.get(sessionId) === controller) {
          this.managerAbortBySession.delete(sessionId);
        }
        this.endSessionRun(sessionId);
      }
    }
  }

  /** Consume an admission synchronously, then execute the normal manager path. */
  dispatchAdmittedTask(
    admission: SessionTurnAdmission,
    input: AdmittedTaskInput,
  ): Promise<SessionTurnResult> {
    const record = this.consumeTurnAdmission(admission);
    return this.executeClaimedTask(admission.sessionId, record.controller, input, record.handle);
  }

  /** Execute non-provider-loop work (currently image turns) under the same run/erasure lease. */
  dispatchAdmittedWork<T>(
    admission: SessionTurnAdmission,
    work: (context: AdmittedWorkContext) => Promise<T>,
    completeReason: string,
  ): Promise<T> {
    const { controller, handle } = this.consumeTurnAdmission(admission);
    return this.runContext.run(handle, async () => {
      this.processCompletionCoordinator.resumeSession(admission.sessionId);
      this.isProcessing = true;
      try {
        this.assertRunHandleActive(handle);
        const result = await work({
          signal: controller.signal,
          phase: async (phase, reason) => {
            this.assertRunHandleActive(handle);
            await this.runLifecycle.phase(handle, phase, reason);
          },
        });
        this.assertRunHandleActive(handle);
        await this.finishRunAndProject(handle, 'complete', completeReason, 'idle');
        return result;
      } catch (error) {
        const aborted =
          controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
        await this.finishRunAndProject(
          handle,
          aborted ? 'cancel' : 'fail',
          aborted ? 'cancelled_by_user' : error instanceof Error ? error.message : String(error),
          aborted ? 'idle' : 'error',
        );
        throw error;
      } finally {
        this.isProcessing = false;
        if (this.managerAbortBySession.get(admission.sessionId) === controller) {
          this.managerAbortBySession.delete(admission.sessionId);
        }
        this.endSessionRun(admission.sessionId);
      }
    });
  }

  /** Release a reserved run when route-side persistence fails before dispatch. */
  rejectSessionTurn(admission: SessionTurnAdmission, reason: string): Promise<void> {
    return this.settleUndispatchedSessionTurn(admission, 'fail', reason, 'error');
  }

  /** Cancellation is a first-class terminal outcome, including before dispatch. */
  private cancelSessionTurn(admission: SessionTurnAdmission, reason: string): Promise<void> {
    return this.settleUndispatchedSessionTurn(admission, 'cancel', reason, 'idle');
  }

  private settleUndispatchedSessionTurn(
    admission: SessionTurnAdmission,
    outcome: 'fail' | 'cancel',
    reason: string,
    workflowState: 'idle' | 'error',
  ): Promise<void> {
    const { controller, handle } = this.consumeTurnAdmission(admission);
    return this.runContext.run(handle, async () => {
      try {
        await this.finishRunAndProject(handle, outcome, reason, workflowState);
      } finally {
        if (this.managerAbortBySession.get(admission.sessionId) === controller) {
          this.managerAbortBySession.delete(admission.sessionId);
        }
        this.endSessionRun(admission.sessionId);
      }
    });
  }

  private consumeTurnAdmission(admission: SessionTurnAdmission): AdmissionRecord {
    const record = this.turnAdmissions.get(admission);
    if (
      !record ||
      admission.sessionId.length === 0 ||
      this.managerAbortBySession.get(admission.sessionId) !== record.controller
    ) {
      throw new Error('Session turn admission is invalid, forged, or already consumed');
    }
    this.turnAdmissions.delete(admission);
    return record;
  }

  /** Canonical terminal state is committed even when the legacy workflow projection fails. */
  private async finishRunAndProject(
    handle: ManagerRunHandle,
    outcome: 'complete' | 'fail' | 'cancel',
    reason: string,
    workflowState: 'idle' | 'error',
  ): Promise<void> {
    const sessionId = handle.sessionId;
    let lifecycleError: unknown;
    try {
      await this.runLifecycle.finish(handle, outcome, reason);
    } catch (error) {
      lifecycleError = error;
    }
    try {
      await this.updateWorkflowState(sessionId, workflowState);
    } catch (error) {
      koryLog.warn(
        { sessionId, error },
        'Legacy workflow-state projection failed after authoritative run transition',
      );
    }
    if (lifecycleError) throw lifecycleError;
  }

  /** Main entry point for processing a task. The claim is installed before the
   * first await, so cancellation and Time Travel see intent discovery/provider
   * resolution as active work rather than a false idle window. */
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
    /** True when the caller has already durably inserted this exact user turn. */
    inputAlreadyPersisted = false,
    imageInputMode: ImageInputMode = 'reject',
  ): Promise<SessionTurnResult> {
    if (inputAlreadyPersisted) {
      throw new Error(
        'Legacy processTask cannot accept pre-persisted input; use reserveSessionTurn and dispatchAdmittedTask.',
      );
    }
    const result = await this.submitSessionTurn({
      sessionId,
      source: goalContext ? 'goal' : collaborationToolPolicy ? 'collaboration' : 'internal',
      sourceCommandId: crypto.randomUUID(),
      userMessage,
      preferredModel,
      reasoningLevel,
      attachments,
      collaborationToolPolicy,
      responseVariant,
      goalContext,
      interactionMode,
      fastMode,
      imageInputMode,
    });
    if (result.status === 'rejected') {
      this.emitError(
        sessionId,
        'This session is already active or is applying a conversation mutation. Wait for it to finish before starting another turn.',
      );
    }
    return result;
  }

  /** Canonical submission boundary for non-HTTP producers. Input persistence,
   * SessionRun admission, stable completion identity, and typed outcome are one
   * contract. Once a command input exists without its response, automatic
   * replay is rejected because provider/tool side effects may have occurred. */
  async startSessionTurn(input: SessionTurnCommandInput): Promise<SessionTurnSubmission> {
    if (!this.messages) throw new Error('Message store unavailable for session turn submission');
    const sourceId = input.sourceCommandId;
    const identity = deriveSessionTurnCommandIdentity({
      sessionId: input.sessionId,
      source: input.source,
      sourceCommandId: sourceId,
    });
    const commandAttachments = input.attachments?.map((attachment) => ({
      type: attachment.type === 'image' ? ('image' as const) : ('file' as const),
      data: attachment.data,
      name: attachment.name,
      mimeType: attachment.mimeType,
    }));
    // Bind every caller-controlled field that can change execution. A stable
    // producer id with a changed model, policy, branch, mode, or attachment is
    // a conflict, not an idempotent retry.
    const inputHash = canonicalSessionTurnInputHash({
      version: 1,
      userMessage: input.userMessage,
      preferredModel: input.preferredModel ?? null,
      reasoningLevel: input.reasoningLevel ?? null,
      attachments: (input.attachments ?? []).map((attachment) => ({
        type: attachment.type,
        data: attachment.data,
        name: attachment.name,
        mimeType: attachment.mimeType ?? null,
      })),
      collaborationToolPolicy: input.collaborationToolPolicy ?? null,
      responseVariant: input.responseVariant ?? null,
      goalContext: input.goalContext ?? null,
      interactionMode: input.interactionMode ?? null,
      fastMode: input.fastMode ?? null,
      imageInputMode: input.imageInputMode ?? 'reject',
      regenerationBranch: input.regenerationBranch ?? null,
    });
    const matchesCommandUser = (message: StoredMessage | undefined): boolean => {
      if (!message || message.role !== 'user' || message.content !== input.userMessage) return false;
      const stored = message.attachments ?? [];
      const expected = commandAttachments ?? [];
      return (
        stored.length === expected.length &&
        stored.every(
          (attachment, index) =>
            attachment.type === expected[index]?.type &&
            attachment.data === expected[index]?.data &&
            attachment.name === expected[index]?.name &&
            (!expected[index]?.mimeType || attachment.mimeType === expected[index]?.mimeType),
        )
      );
    };
    const receiptSubmission = async (
      command: SessionTurnCommandRecord,
    ): Promise<SessionTurnSubmission> => {
      if (command.inputHash !== inputHash) {
        throw new ConflictError(
          'The producer command id is already bound to a different execution payload.',
        );
      }
      const [existingUser, existingResponse] = await Promise.all([
        this.messages!.getById(input.sessionId, command.userMessageId),
        this.messages!.getById(input.sessionId, command.responseMessageId),
      ]);
      if (command.status === 'completed') {
        if (!matchesCommandUser(existingUser) || existingResponse?.role !== 'assistant') {
          return {
            accepted: false,
            result: {
              sessionId: input.sessionId,
              runId: command.runId,
              status: 'failed',
              phase: 'error',
              reason: 'command_completion_projection_missing_or_corrupt',
            },
          };
        }
        return {
          accepted: false,
          result: {
            sessionId: input.sessionId,
            runId: command.runId,
            status: 'completed',
            phase: 'done',
            reason: command.terminalReason,
          },
        };
      }
      if (command.status === 'failed' || command.status === 'cancelled') {
        return {
          accepted: false,
          result: {
            sessionId: input.sessionId,
            runId: command.runId,
            status: command.status,
            phase: command.status === 'cancelled' ? 'cancelled' : 'error',
            reason: command.terminalReason,
          },
        };
      }
      const current = this.runs?.get(input.sessionId);
      if (!current || current.runId !== command.runId) {
        return {
          accepted: false,
          result: {
            sessionId: input.sessionId,
            runId: command.runId,
            status: 'failed',
            phase: 'error',
            reason: 'command_execution_was_interrupted; explicit retry required',
          },
        };
      }
      return {
        accepted: false,
        result: {
          sessionId: input.sessionId,
          runId: command.runId,
          status: command.status === 'waiting' ? 'waiting' : 'rejected',
          phase: current.phase,
          reason:
            command.status === 'waiting'
              ? current.terminalReason
              : 'command_execution_is_already_active',
        },
      };
    };

    const existingCommand = this.runs?.getSessionTurnCommand(identity.commandKey);
    if (existingCommand) return receiptSubmission(existingCommand);

    // Databases upgraded from the pre-ledger build may contain deterministic
    // message projections without a terminal witness. Never infer completion
    // from those rows; doing so turns cancelled partial output into success.
    const [legacyUser, legacyResponse] = await Promise.all([
      this.messages.getById(input.sessionId, identity.userMessageId),
      this.messages.getById(input.sessionId, identity.responseMessageId),
    ]);
    if (legacyUser || legacyResponse) {
      if (
        !matchesCommandUser(legacyUser) ||
        (legacyResponse && legacyResponse.role !== 'assistant')
      ) {
        throw new ConflictError(
          'The producer command id is already bound to different durable input or output.',
        );
      }
      return {
        accepted: false,
        result: {
          sessionId: input.sessionId,
          runId: '',
          status: 'failed',
          phase: 'error',
          reason: 'legacy_command_has_no_terminal_receipt; explicit retry required',
        },
      };
    }

    const reason: SessionTurnReason =
      input.source === 'goal'
        ? 'goal_turn'
        : input.source === 'collaboration'
          ? 'collaboration_turn'
          : 'internal_turn';
    if (!this.tryBeginSessionRun(input.sessionId)) {
      return {
        accepted: false,
        result: {
          sessionId: input.sessionId,
          runId: '',
          status: 'rejected',
          phase: this.runs?.get(input.sessionId)?.phase ?? 'idle',
          reason: 'session_busy',
        },
      };
    }
    if (!this.runs) {
      this.endSessionRun(input.sessionId);
      throw new Error('Session turn command ledger is unavailable');
    }
    const controller = new AbortController();
    this.managerAbortBySession.set(input.sessionId, controller);
    let handle: ManagerRunHandle | null = null;
    let admission: SessionTurnAdmission | null = null;
    let command: SessionTurnCommandRecord | null = null;
    try {
      if (this.sessions && !(await this.getActiveSession(input.sessionId))) {
        throw new Error('Recover this archived chat before starting new work.');
      }
      const begun = await this.runLifecycle.beginCommand({
        sessionId: input.sessionId,
        source: input.source,
        sourceCommandId: sourceId,
        inputHash,
        reason,
        activeAgentIds: ['kory-manager'],
      });
      command = begun.command;
      if (begun.disposition === 'existing') {
        return await receiptSubmission(begun.command);
      }
      handle = begun.handle;
      this.runControllerByHandle.set(handle, controller);
      if (controller.signal.aborted) {
        await this.runLifecycle.finish(handle, 'cancel', 'cancelled_during_admission');
        return await receiptSubmission(
          this.runs.getSessionTurnCommand(command.commandKey) ?? command,
        );
      }
      admission = Object.freeze({
        sessionId: input.sessionId,
        runId: handle.runId,
        signal: controller.signal,
      });
      this.turnAdmissions.set(admission, { controller, handle });
    } catch (error) {
      if (handle && !admission) {
        await this.runLifecycle
          .finish(
            handle,
            controller.signal.aborted ? 'cancel' : 'fail',
            controller.signal.aborted ? 'cancelled_during_admission' : 'command_admission_failed',
          )
          .catch(() => undefined);
      }
      if (error instanceof SessionTurnCommandConflictError) {
        throw new ConflictError(error.message);
      }
      if (error instanceof SessionRunTransitionError && error.code === 'RUN_ALREADY_ACTIVE') {
        return {
          accepted: false,
          result: {
            sessionId: input.sessionId,
            runId: '',
            status: 'rejected',
            phase: this.runs.get(input.sessionId)?.phase ?? 'idle',
            reason: 'session_busy',
          },
        };
      }
      throw error;
    } finally {
      if (!admission) {
        if (this.managerAbortBySession.get(input.sessionId) === controller) {
          this.managerAbortBySession.delete(input.sessionId);
        }
        this.endSessionRun(input.sessionId);
      }
    }

    if (!command || !admission) throw new Error('Session turn command admission was not created');
    try {
      const inserted = await this.messages.addIdempotent(input.sessionId, {
        id: command.userMessageId,
        sessionId: input.sessionId,
        role: 'user',
        content: input.userMessage,
        attachments: commandAttachments,
        createdAt: Date.now(),
      });
      if (inserted !== 'inserted') {
        await this.rejectSessionTurn(admission, 'command_input_was_already_persisted');
        return {
          accepted: false,
          result: {
            sessionId: input.sessionId,
            runId: admission.runId,
            status: 'failed',
            phase: 'error',
            reason: 'command_execution_was_interrupted; explicit retry required',
          },
        };
      }
    } catch (error) {
      await this.rejectSessionTurn(admission, 'command_input_persistence_failed');
      throw error;
    }
    const completion = this.dispatchAdmittedTask(admission, {
      ...input,
      inputAlreadyPersisted: true,
      responseMessageId: command.responseMessageId,
    });
    return {
      accepted: true,
      sessionId: input.sessionId,
      runId: admission.runId,
      completion,
    };
  }

  async submitSessionTurn(input: SessionTurnCommandInput): Promise<SessionTurnResult> {
    const submission = await this.startSessionTurn(input);
    return submission.accepted ? submission.completion : submission.result;
  }

  private async executeClaimedTask(
    sessionId: string,
    intentAbort: AbortController,
    input: AdmittedTaskInput,
    admittedHandle?: ManagerRunHandle,
  ): Promise<SessionTurnResult> {
    let handle = admittedHandle;
    try {
      if (!handle) {
        if (this.sessions && !(await this.getActiveSession(sessionId))) {
          throw new Error('Recover this archived chat before starting new work.');
        }
        handle = await this.runLifecycle.begin(
          sessionId,
          input.goalContext ? 'goal_turn' : 'user_turn',
        );
        this.runControllerByHandle.set(handle, intentAbort);
      }
      await this.runContext.run(handle, () =>
        this.processTaskWithClaim(
          sessionId,
          input.userMessage,
          input.preferredModel,
          input.reasoningLevel,
          input.attachments,
          input.collaborationToolPolicy,
          input.responseVariant,
          input.goalContext,
          input.interactionMode,
          input.fastMode,
          input.inputAlreadyPersisted,
          input.imageInputMode ?? 'reject',
          intentAbort,
          input.regenerationBranch,
          input.responseMessageId,
        ),
      );
    } catch (error) {
      const aborted =
        intentAbort.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      this.stopHeartbeat(sessionId);
      this.isProcessing = false;
      let terminalError: unknown;
      try {
        if (handle) {
          await this.finishRunAndProject(
            handle,
            aborted ? 'cancel' : 'fail',
            aborted ? 'cancelled_by_user' : error instanceof Error ? error.message : String(error),
            aborted ? 'idle' : 'error',
          );
        }
      } catch (finishError) {
        terminalError = finishError;
      }
      if (aborted) {
        this.emitWSMessage(sessionId, 'system.info', { message: 'Stopped by user.' });
      } else {
        koryLog.error({ sessionId, error }, 'Manager run failed before provider execution');
        this.emitError(sessionId, error instanceof Error ? error.message : String(error));
      }
      if (terminalError) throw terminalError;
    } finally {
      if (this.managerAbortBySession.get(sessionId) === intentAbort) {
        this.managerAbortBySession.delete(sessionId);
      }
      this.endSessionRun(sessionId);
    }
    return this.readSessionTurnResult(sessionId, handle?.runId);
  }

  private readSessionTurnResult(sessionId: string, runId?: string): SessionTurnResult {
    const snapshot = this.runs?.get(sessionId);
    if (!runId || !snapshot || snapshot.runId !== runId) {
      return {
        sessionId,
        runId: runId ?? '',
        status: 'unknown',
        phase: snapshot?.phase ?? 'idle',
        reason: snapshot?.terminalReason ?? null,
      };
    }
    const status: SessionTurnResult['status'] =
      snapshot.status === 'waiting'
        ? 'waiting'
        : snapshot.phase === 'done'
          ? 'completed'
          : snapshot.phase === 'cancelled'
            ? 'cancelled'
            : snapshot.phase === 'error'
              ? 'failed'
              : 'unknown';
    return {
      sessionId,
      runId,
      status,
      phase: snapshot.phase,
      reason: snapshot.terminalReason,
    };
  }

  private async processTaskWithClaim(
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
    inputAlreadyPersisted = false,
    imageInputMode: ImageInputMode = 'reject',
    intentAbort?: AbortController,
    regenerationBranch?: RegenerationBranchReservation,
    responseMessageId?: string,
  ): Promise<void> {
    if (!intentAbort) throw new Error('Session execution is missing its abort controller');
    const handle = this.requireRunHandle(sessionId);
    this.processCompletionCoordinator.resumeSession(sessionId);
    const session = await this.getActiveSession(sessionId);
    if (this.sessions && !session) {
      throw new Error('Recover this archived chat before starting new work.');
    }
    this.assertRunHandleActive(handle);
    interactionMode = interactionMode ?? session?.interactionMode ?? 'act';
    this.isProcessing = true;
    this.startHeartbeat(sessionId);
    this.setHeartbeatPhase(sessionId, 'analyzing');
    this.emitWSMessage(sessionId, 'agent.status', {
      agentId: KORY_IDENTITY.id,
      status: 'analyzing',
      detail: 'Preparing the request',
    });
    this.state.clearChanges(sessionId);
    userMessage = sanitizeForPrompt(userMessage);

    const sessionRoot = await this.resolveSessionWorkingDirectory(sessionId);
    this.assertRunHandleActive(handle);
    const workflowSettings = loadAgentSettings(sessionRoot);
    const remembered = workflowSettings.agentCanUpdatePreferences
      ? rememberExplicitPreference(sessionRoot, userMessage)
      : null;
    if (remembered) {
      this.emitWSMessage(sessionId, 'system.info', {
        message: `Remembered as a project preference: ${remembered}`,
      });
    }
    if (interactionMode === 'plan') {
      const planNote = await ensurePlanNote(sessionId, userMessage, sessionRoot);
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
    this.assertRunHandleActive(handle);
    if (decisions.length > 0) {
      userMessage += `\n\nResolved intent decisions:\n- ${decisions.join('\n- ')}`;
    }

    await this.resolveSkillCollisionsForTask(
      sessionId,
      await this.resolveSessionWorkingDirectory(sessionId),
      userMessage,
      configuredCollisionChoices,
    );
    this.assertRunHandleActive(handle);

    // Resolve provider before any UI updates or work. No provider = manager responds once and returns.
    let routing = this.resolveActiveRouting(
      preferredModel,
      'general',
      true,
      userMessage,
      undefined,
      sessionRoot,
    );
    let provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider && (!preferredModel || preferredModel === 'auto')) {
      const fallback = this.providers.getFirstAvailableRouting();
      if (fallback) {
        routing = { model: fallback.model, provider: fallback.provider };
        provider = this.providers.resolveProvider(routing.model, routing.provider);
      }
    }
    this.assertRunHandleActive(handle);
    if (!provider) {
      await this.updateWorkflowState(sessionId, 'idle');
      this.emitError(sessionId, this.getModelConfigurationError(preferredModel));
      this.skillCollisionChoicesBySession.delete(sessionId);
      this.goalContextBySession.delete(sessionId);
      this.stopHeartbeat(sessionId);
      this.isProcessing = false;
      this.processCompletionCoordinator.notifySessionIdle(sessionId);
      await this.runLifecycle.finish(handle, 'fail', 'provider_unavailable');
      return;
    }
    this.managerRoutingBySession.set(sessionId, {
      model: routing.model,
      provider: provider.name,
    });

    // This is the final local preflight before any paid provider stream. It
    // evaluates only recorded spend; Koryphaios does not invent a projected
    // cost when the selected provider has not supplied one.
    const spendGate = await checkAndEnforceCaps(sessionId);
    if (spendGate.reason && spendGate.canProceed) {
      this.emitWSMessage(sessionId, 'system.info', {
        message: `Spend limit warning: ${spendGate.reason}`,
      });
    }
    if (!spendGate.canProceed) {
      await this.updateWorkflowState(sessionId, spendGate.paused ? 'paused' : 'idle');
      this.emitError(
        sessionId,
        spendGate.reason ?? 'A configured spend limit blocked this request.',
      );
      this.skillCollisionChoicesBySession.delete(sessionId);
      this.goalContextBySession.delete(sessionId);
      this.managerRoutingBySession.delete(sessionId);
      this.stopHeartbeat(sessionId);
      this.isProcessing = false;
      this.processCompletionCoordinator.notifySessionIdle(sessionId);
      await this.runLifecycle.finish(handle, 'fail', 'spend_policy_blocked');
      return;
    }

    koryLog.debug(
      { sessionId, routing, providerName: provider.name },
      'Resolved provider for task',
    );

    // Broadcast the user message to relay guests
    collaborationManager.broadcastEvent({ type: 'chat', from: 'human', content: userMessage });

    await this.updateWorkflowState(sessionId, 'analyzing');
    if (collaborationToolPolicy) setCollaborationToolPolicy(sessionId, collaborationToolPolicy);
    try {
      koryLog.debug({ sessionId }, 'Calling handleDirectly');
      this.emitThought(sessionId, 'analyzing', `Preparing provider request...`);

      // Global timeout: abort the task if it runs too long (prevents indefinite hangs)
      const TIMEOUT_MIN = AGENT.PROCESS_TASK_TIMEOUT_MS / 60_000;
      const processTimeout = setTimeout(() => {
        // Abort any active LLM stream
        if (!intentAbort.signal.aborted) {
          intentAbort.abort(
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
          inputAlreadyPersisted,
          imageInputMode,
          regenerationBranch,
          responseMessageId,
        );
      } finally {
        clearTimeout(processTimeout);
      }

      koryLog.debug({ sessionId }, 'handleDirectly completed');

      await this.updateWorkflowState(sessionId, 'idle');
      const changes = this.state.getChanges(sessionId);
      if (changes.length > 0) await this.publishPendingSessionReview(sessionId, changes);
    } catch (err) {
      const errDetail =
        err instanceof Error
          ? { message: err.message, name: err.name, stack: err.stack, cause: err.cause }
          : { raw: String(err), typeof: typeof err };
      koryLog.error({ sessionId, err, errDetail }, 'Error in processTask');
      // Stop the heartbeat before emitting the error — the run is over.
      this.stopHeartbeat(sessionId);
      await this.updateWorkflowState(sessionId, 'error');
      await this.runLifecycle.finish(
        handle,
        'fail',
        err instanceof Error ? err.message : String(err),
      );
      this.emitError(sessionId, err instanceof Error ? err.message : String(err));
    } finally {
      if (collaborationToolPolicy) clearCollaborationToolPolicy(sessionId);
      this.skillCollisionChoicesBySession.delete(sessionId);
      this.goalContextBySession.delete(sessionId);
      this.stopHeartbeat(sessionId);
      this.isProcessing = false;
    }
  }

  private buildFallbackChain(startModelId: string): string[] {
    return this.routing.buildFallbackChain(startModelId);
  }

  resolveActiveRouting(
    preferredModel?: string,
    domain: WorkerDomain = 'general',
    avoidLegacy = false,
    prompt?: string,
    preferCheap?: boolean,
    workingDirectory = this.workingDirectory,
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
        const allowed = loadAgentSettings(workingDirectory).managerModelAccess?.[domain];
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
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Agent settings unavailable — using the routed default',
        );
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
    workingDirectory = this.workingDirectory,
  ): { model: string; provider: ProviderName | undefined } | null {
    const settings = loadAgentSettings(workingDirectory);
    const configured = settings.managerModelAccess?.[domain] ?? [];
    const candidates =
      configured.length > 0
        ? configured
        : this.providers
            .getStatus()
            .filter((status) => status.adapterAvailable)
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
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Stale user-enabled model: skip it and continue through the pool',
        );
      }
    }
    const independent = resolved.filter((route) => route.provider !== avoidProvider);
    const differentModel = resolved.filter((route) => route.model !== avoidModel);
    const pool = independent.length ? independent : differentModel;
    const contract = createTaskContract(task ?? 'Delegate task');
    const skillResolution = resolveSkills(workingDirectory, contract.goal, contract);
    const ranked = rankHarnessCandidates(
      workingDirectory,
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
    const authenticated = statuses.filter((provider) => provider.adapterAvailable);

    if (authenticated.length === 0) {
      return 'No model provider is configured. Open Settings and connect a provider before chatting.';
    }

    if (preferredModel && preferredModel !== 'auto' && preferredModel.includes(':')) {
      const [providerName, modelId] = preferredModel.split(':');
      if (providerName && modelId) {
        const selectedProvider = authenticated.find((provider) => provider.name === providerName);
        if (!selectedProvider || !selectedProvider.models.includes(modelId)) {
          return `${modelId} is no longer available for ${this.formatProviderName(providerName)}. Select another model in the composer.`;
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
    const managerOwnsLifecycle = this.hasActiveSessionExecution(sessionId);
    const lifecycleLease = managerOwnsLifecycle
      ? null
      : this.tryAcquireSessionMutationBarrier(sessionId);
    if (!managerOwnsLifecycle && !lifecycleLease) {
      throw new ConflictError(
        'Wait for chat lifecycle work to finish before delegating new worker work.',
      );
    }
    try {
      if (this.sessions && !(await this.getActiveSession(sessionId))) {
        throw new ConflictError('Recover this archived chat before delegating new worker work.');
      }
      const before = await this.events.runWorkflowHooks('before-delegate', sessionId, {
        task,
        preferredModel: preferredModel ?? null,
        domainHint: domainHint ?? null,
      });
      if (before.decision === 'deny') {
        return `Delegation denied by workflow hook: ${before.reason ?? 'no reason supplied'}`;
      }
      const sessionRoot = await this.resolveSessionWorkingDirectory(sessionId);
      const managerRouting = this.resolveActiveRouting(
        preferredModel,
        'general',
        true,
        task,
        undefined,
        sessionRoot,
      );
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
        sessionRoot,
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
    } finally {
      lifecycleLease?.release();
    }
  }

  /** Whether Jules can run through Kory's enforced approval boundary. */
  isJulesAvailable(): boolean {
    const jules = this.providers.get('jules');
    return jules?.isAvailable() ?? false;
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
    if (
      this.erasedSessions.has(sessionId) ||
      this.sessionMutationBarriers.has(sessionId) ||
      this.titledSessions.has(sessionId)
    ) {
      return;
    }
    this.titledSessions.add(sessionId);
    const controller = new AbortController();
    this.titleGenerationBySession.set(sessionId, controller);
    try {
      const session = await this.getActiveSession(sessionId);
      if (!session || controller.signal.aborted || this.erasedSessions.has(sessionId)) return;
      // Only rename sessions that are still on the default title — user-renamed
      // sessions are sacred.
      if (session.title !== SESSION.DEFAULT_TITLE) return;
      // Only rename the very first user message; later turns keep the existing
      // name even if the user hasn't renamed it manually.
      if ((session.messageCount ?? 0) > 0) return;

      const cleaned = userMessage.replace(/\s+/g, ' ').trim();
      let title = this.fallbackTitle(cleaned);

      try {
        const workingDirectory = await this.resolveSessionWorkingDirectory(sessionId);
        if (controller.signal.aborted || this.erasedSessions.has(sessionId)) return;
        const llmTitle = await this.askForTitle(cleaned, workingDirectory, controller.signal);
        if (llmTitle) title = llmTitle;
      } catch (err) {
        if (controller.signal.aborted || this.erasedSessions.has(sessionId)) return;
        koryLog.debug({ sessionId }, 'Agent title generation failed, using fallback');
      }

      if (controller.signal.aborted || this.erasedSessions.has(sessionId)) return;
      title = title.slice(0, SESSION.MAX_TITLE_LENGTH).trim();
      if (!title || title === SESSION.DEFAULT_TITLE) return;

      const updated = await this.sessions.update(sessionId, { title });
      if (updated && !controller.signal.aborted && !this.erasedSessions.has(sessionId)) {
        this.events.emit(sessionId, 'session.updated', { session: updated });
      }
    } finally {
      if (this.titleGenerationBySession.get(sessionId) === controller) {
        this.titleGenerationBySession.delete(sessionId);
      }
    }
  }

  /** Ask a small/fast model for a 3-6 word title. Returns null on any failure. */
  private async askForTitle(
    userMessage: string,
    workingDirectory = this.workingDirectory,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (signal?.aborted) return null;
    // Pick the cheapest available routing so title generation stays cheap.
    let routing;
    try {
      routing = this.resolveActiveRouting(
        undefined,
        'general',
        true,
        undefined,
        true,
        workingDirectory,
      );
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to resolve active routing for default model',
      );
      return null;
    }
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider || signal?.aborted) return null;

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
        signal,
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

  /**
   * Jules remains a registered compatibility surface, but delegation is
   * fail-closed until Kory can persist and enforce explicit plan approval.
   */
  async runJulesDelegation(
    _sessionId: string,
    _task: string,
    _options?: { createPr?: boolean; branch?: string },
  ): Promise<string> {
    return JULES_APPROVAL_REQUIRED_ERROR;
  }

  /** Critic can only read files and grep. It sees the full worker transcript (truncated) and outputs PASS or FAIL with feedback. */
  async runCriticGate(
    sessionId: string,
    workerMessages: InternalMessage[] | undefined,
    preferredModel?: string,
    task?: string,
    reviewDirectory = this.workingDirectory,
    producerIdentity?: { provider: ProviderName; model: string },
  ): Promise<CriticGateResult> {
    if (!loadAgentSettings(reviewDirectory).criticGateEnabled) {
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

    const producerRouting = producerIdentity
      ? { model: producerIdentity.model, provider: producerIdentity.provider }
      : preferredModel
        ? this.resolveActiveRouting(
            preferredModel,
            'general',
            false,
            undefined,
            undefined,
            reviewDirectory,
          )
        : { model: undefined, provider: undefined };
    const managerIdentity = this.managerRoutingBySession.get(sessionId);
    const routing = this.resolveIndependentRouting(
      producerRouting.model,
      producerRouting.provider,
      'critic',
      managerIdentity ? [managerIdentity] : [],
      task,
      'critic',
      reviewDirectory,
    );
    if (!routing) {
      return {
        passed: false,
        skipped: true,
        feedback:
          'No distinct critic model is available. The producer cannot verify its own work, so the result remains unverified.',
      };
    }
    const criticRouting = routing;
    if (
      criticRouting.model === producerRouting.model &&
      criticRouting.provider === producerRouting.provider
    ) {
      return {
        passed: false,
        skipped: true,
        feedback:
          'The configured critic resolves to the producer provider and model. Self-verification is not independent, so the result remains unverified.',
      };
    }
    const provider = await this.providers.resolveProvider(
      criticRouting.model,
      criticRouting.provider,
    );
    if (!provider) return { passed: false, feedback: 'Critic unavailable; result is unverified.' };
    const criticGuidance = assembleAgentContext(
      reviewDirectory,
      loadAgentSettings(reviewDirectory),
    );
    const criticMemoryContext = assembleMemoryContext(reviewDirectory, sessionId);
    const criticMemory = automaticMemoryPrompt(
      formatMemoryForContext(criticMemoryContext),
      criticMemoryContext.settings,
    );
    const criticSupplementalContext =
      (criticGuidance.preferences.trim()
        ? `\n\n## Durable user preferences\n${criticGuidance.preferences.trim()}`
        : '') + (criticMemory ? `\n\n${criticMemory}` : '');
    const transcriptText = formatMessagesForCriticUtil(workerMessages ?? [], 12_000);
    const objective = task?.trim()
      ? `THE OBJECTIVE (what the worker was asked to accomplish):\n${task.trim().slice(0, 2_000)}\n\n`
      : '';
    const criticPrompt =
      `${objective}Worker transcript to review:\n\n${transcriptText}\n\n` +
      `Critique against the objective: (1) does the work actually accomplish it, ` +
      `(2) is the implementation correct (verify claims by reading the real files — do not trust the transcript), ` +
      `(3) did it break or regress anything nearby, (4) is anything incomplete or stubbed. ` +
      `Use read_file/grep/glob/ls as needed. Return the structured JSON critic report required by your system contract.`;
    const criticCompilation = compilePrompt({
      role: 'critic',
      mode: getModeManager().getMode(),
      provider: provider.name,
      model: criticRouting.model,
      occupiedContextTokenUpperBound:
        textTokenUpperBound(criticPrompt) + textTokenUpperBound(criticSupplementalContext),
      reservedOutputTokens: CRITIC_OUTPUT_TOKEN_LIMIT,
      requireVerifiedContextWindow: true,
      workingDirectory: reviewDirectory,
      taskContract: createTaskContract(task ?? 'Review delegated work'),
      contextPaths: this.config.contextPaths,
      skillSelection: {
        collisionChoices: this.skillCollisionChoicesBySession.get(sessionId),
      },
    });
    if (criticCompilation.warnings?.length) {
      for (const w of criticCompilation.warnings) {
        this.emitWSMessage(sessionId, 'system.info', { message: w });
      }
    }
    const criticSystemPrompt = criticCompilation.systemPrompt + criticSupplementalContext;
    // The critic is a FRESH-context agent — it never shares the manager's
    // conversation. The manager briefs it here: the original objective plus
    // what to scrutinize, so the review judges fitness-for-purpose instead of
    // vibing over an anonymous transcript.
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
    // The critic runs in plan mode (read-only) and is intentionally NOT wired
    // through resolveSubAgent{Permission,Sandbox}Options. The sub-agent approval
    // policy governs workers that make changes; the critic cannot make edits,
    // so approval gating and sandbox bypass are moot for it.
    const criticCtx: ToolContext = {
      sessionId,
      workingDirectory: criticSessionWd,
      allowedPaths: [criticSessionWd],
      isSandboxed: true,
      sandboxOptions: resolveSandboxOptions(loadAgentSettings(criticSessionWd), true),
      permissionPolicy: resolveToolPermissionPolicy(loadAgentSettings(criticSessionWd), 'plan'),
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
      promptCache: criticCompilation.promptCache,
      toolRole: 'critic',
      maxTurns: 5,
      maxTokens: CRITIC_OUTPUT_TOKEN_LIMIT,
      messages: [{ role: 'user', content: criticPrompt }],
      threadEntries: [],
      ctx: criticCtx,
      abort: criticAbort,
      busy: false,
      updatedAt: Date.now(),
    };
    this.agentThreads.set(criticId, thread);
    try {
      // Persist membership before the first visible critic event. A restart
      // after agent.spawned must have enough durable identity to close this
      // exact card rather than replaying it as permanently thinking.
      await this.recordAgentThreadRunMembership(thread, true);
    } catch (error) {
      this.agentThreads.delete(criticId);
      rmSync(criticSessionWd, { recursive: true, force: true });
      return {
        passed: false,
        feedback: `Could not durably start the critic: ${error instanceof Error ? error.message : String(error)}`,
        model: criticRouting.model,
        provider: provider.name,
      };
    }
    this.events.emitAgentSpawned(sessionId, identity, 'Review delegated work');
    this.appendAgentThreadEntry(thread, 'manager', criticPrompt);

    try {
      await this.runAgentThread(criticId, provider);
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'Critic failed to run',
      );
      rmSync(criticSessionWd, { recursive: true, force: true });
      return {
        passed: false,
        feedback: 'Critic failed to run.',
        model: criticRouting.model,
        provider: provider.name,
      };
    }

    const lastContent =
      [...thread.threadEntries].reverse().find((entry) => entry.role === 'assistant')?.content ??
      '';
    const passed = parseCriticVerdict(lastContent);
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
        model: criticRouting.model,
        provider: provider.name,
      };
    }
    return {
      passed,
      feedback: lastContent.trim(),
      model: criticRouting.model,
      provider: provider.name,
    };
  }

  /** Goal Mode completion claims pass through the same global Critic switch and quality gate. */
  async verifyGoalItem(
    sessionId: string,
    objective: string,
    itemTitle: string,
    producerEvidence: string,
    preferredModel?: string,
    producerProvider?: ProviderName,
  ): Promise<CriticGateResult> {
    const session = await this.sessions?.get(sessionId);
    if (!session) {
      return { passed: false, feedback: 'Goal verification session is unavailable.' };
    }
    let reviewDirectory: string;
    try {
      reviewDirectory = await this.resolveSessionWorkingDirectory(sessionId);
    } catch (error) {
      return {
        passed: false,
        feedback: `Goal verification project is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const safeObjective = sanitizeForPrompt(redactSecretsInText(objective, 2_000), 2_000);
    const safeItemTitle = sanitizeForPrompt(redactSecretsInText(itemTitle, 1_000), 1_000);
    const safeEvidence = sanitizeForPrompt(redactSecretsInText(producerEvidence, 8_000), 8_000);
    return this.runCriticGate(
      sessionId,
      [
        {
          role: 'user',
          content:
            `Goal objective: ${safeObjective}\n` +
            `Checklist item claimed complete: ${safeItemTitle}\n` +
            `Producer-submitted evidence (a claim, not a verdict):\n${safeEvidence}\n\n` +
            'Inspect the actual workspace, independently reproduce the relevant checks, and verify whether the evidence genuinely proves this item complete.',
        },
      ],
      preferredModel,
      `Verify Goal Mode checklist item: ${safeItemTitle}`,
      reviewDirectory,
      preferredModel && producerProvider
        ? { provider: producerProvider, model: preferredModel }
        : undefined,
    );
  }

  /** A repeated blocker is terminal only after the enabled Critic accepts that it is real. */
  async verifyGoalBlocker(
    sessionId: string,
    objective: string,
    itemTitle: string,
    blocker: string,
    preferredModel?: string,
    producerProvider?: ProviderName,
  ): Promise<CriticGateResult> {
    const session = await this.sessions?.get(sessionId);
    if (!session) {
      return { passed: false, feedback: 'Goal blocker verification session is unavailable.' };
    }
    let reviewDirectory: string;
    try {
      reviewDirectory = await this.resolveSessionWorkingDirectory(sessionId);
    } catch (error) {
      return {
        passed: false,
        feedback: `Goal blocker project is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
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
      reviewDirectory,
      preferredModel && producerProvider
        ? { provider: producerProvider, model: preferredModel }
        : undefined,
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
    interactionMode: 'act' | 'plan' = 'act',
    fastMode?: boolean,
    inputAlreadyPersisted = false,
    imageInputMode: ImageInputMode = 'reject',
    regenerationBranch?: RegenerationBranchReservation,
    responseMessageId?: string,
  ): Promise<void> {
    const handle = this.requireRunHandle(sessionId);
    koryLog.debug(
      { sessionId, reasoningLevel, preferredModel, fastMode },
      'Entering handleDirectly',
    );
    const directWorkingDirectory = await this.resolveSessionWorkingDirectory(sessionId);
    let routing = this.resolveActiveRouting(
      preferredModel,
      'general',
      true,
      userMessage,
      undefined,
      directWorkingDirectory,
    );
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

    // Normal human/Goal turns preflight immediately after their authoritative
    // routing pass. Recovery wakes enter here directly, so enforce the same
    // boundary before they can start another paid provider stream.
    if (!this.managerRoutingBySession.has(sessionId)) {
      const spendGate = await checkAndEnforceCaps(sessionId);
      if (spendGate.reason && spendGate.canProceed) {
        this.emitWSMessage(sessionId, 'system.info', {
          message: `Spend limit warning: ${spendGate.reason}`,
        });
      }
      if (!spendGate.canProceed) {
        await this.updateWorkflowState(sessionId, spendGate.paused ? 'paused' : 'idle');
        this.emitError(
          sessionId,
          spendGate.reason ?? 'A configured spend limit blocked this request.',
        );
        this.stopHeartbeat(sessionId);
        await this.runLifecycle.finish(handle, 'fail', 'spend_policy_blocked');
        return;
      }
      this.managerRoutingBySession.set(sessionId, {
        model: routing.model,
        provider: providerName,
      });
    }

    const abort = this.managerAbortBySession.get(sessionId) ?? new AbortController();
    this.managerAbortBySession.set(sessionId, abort);
    this.assertRunHandleActive(handle);

    try {
      this.emitWSMessage(sessionId, 'agent.status', {
        agentId: KORY_IDENTITY.id,
        status: 'analyzing',
        detail: 'Preparing the provider request',
      });
      this.setHeartbeatPhase(sessionId, 'analyzing');
      let tokensIn = 0;
      let tokensOut = 0;
      let usageKnown = false;
      let cachedInputTokens: number | undefined;
      let cacheWriteInputTokens: number | undefined;
      let usageBreakdown: ContextBreakdown | undefined;
      this.emitUsageUpdate(
        sessionId,
        KORY_IDENTITY.id,
        routing.model,
        providerName,
        tokensIn,
        tokensOut,
        usageKnown,
      );

      const directGit = new GitManager(directWorkingDirectory);
      const directNaturalSandboxed = interactionMode === 'plan' || regenerationBranch !== undefined;
      const permissionInteractionMode = regenerationBranch ? 'plan' : interactionMode;
      const managerCtx: ToolContext = {
        sessionId,
        agentId: KORY_IDENTITY.id,
        activeProvider: providerName,
        activeModel: routing.model,
        reasoningLevel,
        goalId: this.goalContextBySession.get(sessionId)?.goalId,
        goalItemId: this.goalContextBySession.get(sessionId)?.itemId,
        workingDirectory: directWorkingDirectory,
        allowedPaths: [],
        approvedToolCallIds: new Set(),
        signal: abort.signal,
        waitForUserInput: (
          question: string,
          options: string[],
          opts?: { allowOther?: boolean; allowKeepChatting?: boolean },
        ) => this.waitForUserInputInternal(sessionId, question, options, opts),
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
        delegateToWorker: (task: string, domainHint?: string) =>
          this.runWorkerPipeline(
            sessionId,
            task,
            preferredModel,
            this.getWorkerReasoningLevel(),
            domainHint,
          ),
        delegateToJules: (task: string, opts) => this.runJulesDelegation(sessionId, task, opts),
      } as ToolContext;
      Object.defineProperties(managerCtx, {
        permissionPolicy: {
          get() {
            return resolveToolPermissionPolicy(
              loadAgentSettings(directWorkingDirectory),
              permissionInteractionMode,
            );
          },
          enumerable: true,
          configurable: true,
        },
        sandboxOptions: {
          get() {
            return resolveSandboxOptions(
              loadAgentSettings(directWorkingDirectory),
              directNaturalSandboxed,
            );
          },
          enumerable: true,
          configurable: true,
        },
        isSandboxed: {
          get() {
            return resolveSandboxOptions(
              loadAgentSettings(directWorkingDirectory),
              directNaturalSandboxed,
            ).isSandboxed;
          },
          enumerable: true,
          configurable: true,
        },
      });

      const history = await this.loadHistory(sessionId, regenerationBranch?.promptMessageId);
      koryLog.debug({ historyCount: history.length }, 'Loaded history');

      let finalContent: string | import('../providers/types').ProviderContentBlock[] = userMessage;
      if (attachments && attachments.length > 0) {
        const imageAttachments = attachments.filter((a) => a.type === 'image');
        if (imageAttachments.length > 0) {
          finalContent = [
            { type: 'text', text: userMessage },
            ...imageAttachments.map((att) => {
              let mime = att.mimeType ?? 'image/png';
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

      // `/api/messages` persists the user's row before handing it to the
      // manager, so `history` already contains its text and attachments. Do
      // not append it a second time: that doubled every current prompt and
      // would hand a repaired native image transport the same screenshot twice.
      // Internal/goal/collaboration callers that have not persisted a user row
      // retain the historical append behavior.
      let messages: InternalMessage[] = inputAlreadyPersisted
        ? history
        : [...history, { role: 'user', content: finalContent }];
      if (imageInputMode === 'omit') messages = omitImageInputs(messages);
      const attachmentError = imageAttachmentAdmissionError(provider, routing.model, messages);
      if (attachmentError) throw new Error(attachmentError);
      let turnCount = 0;
      let stoppedByUser = false;
      const observeCancellation = (): boolean => {
        if (abort.signal.aborted) stoppedByUser = true;
        return stoppedByUser;
      };
      // Track whether the run produced anything user-visible — so an empty LLM response
      // surfaces a clear message instead of a silent "weird stop".
      let streamedAnyContent = false;
      let observedNativeTool = false;
      let delegatedWorkerCount = 0;
      let multiModeRetryIssued = false;
      const providerConversationRevision = regenerationBranch
        ? regenerationBranch.expectedProviderConversationRevision
        : await getCliConversationRevision(sessionId);

      while (turnCount < 25) {
        if (abort.signal.aborted) {
          stoppedByUser = true;
          break;
        }
        turnCount++;
        koryLog.debug({ turnCount }, 'Starting manager turn');
        // Reclaim context: stub out tool outputs the user hid from the agent
        // or that are old enough to be dead weight. fetch_context retains only
        // the bounded, redacted durable preview.
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
            providerConversationRevision,
            regenerationBranch !== undefined,
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
        // Only the most recent provider turn can describe the completed
        // context exactly. If it omits usage, fail closed instead of carrying
        // an earlier tool-loop turn's occupancy onto the final boundary.
        usageKnown = result.usage?.usageKnown === true;
        if (usageKnown && result.usage) {
          tokensIn = result.usage.tokensIn;
          tokensOut = result.usage.tokensOut;
          cachedInputTokens = result.usage.cachedInputTokens;
          cacheWriteInputTokens = result.usage.cacheWriteInputTokens;
          usageBreakdown = result.usage.breakdown;
        } else {
          tokensIn = 0;
          tokensOut = 0;
          cachedInputTokens = undefined;
          cacheWriteInputTokens = undefined;
          usageBreakdown = undefined;
        }
        if (result.content && result.content.trim()) streamedAnyContent = true;
        observedNativeTool ||= result.observedNativeTool === true;

        if (!result.success) break;

        const { completedToolCalls } = result;
        if (!completedToolCalls || completedToolCalls.length === 0) {
          const runSettings = loadAgentSettings(managerCtx.workingDirectory);
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
            // Persist a bounded, redacted activity preview before pruning.
            const archiveId = await this.archiveToolResult(sessionId, tc, toolResult);
            this.emitWSMessage(sessionId, 'stream.tool_result', {
              agentId: KORY_IDENTITY.id,
              toolResult: archiveId ? { ...toolResult, archiveId } : toolResult,
            });
            // Record lightweight tool call preview for checkpoint metadata.
            this.state.recordToolCall(sessionId, {
              name: tc.name,
              inputPreview: this.truncateToolPreview(JSON.stringify(tc.input)),
              resultPreview: this.truncateToolPreview(toolResult.output),
              durationMs: toolResult.durationMs,
              isError: toolResult.isError,
            });
            // Track shell commands separately for the command timeline.
            if (tc.name === 'bash' || tc.name === 'shell_manage') {
              const cmd = typeof tc.input?.command === 'string' ? tc.input.command : '';
              this.state.recordCommand(sessionId, {
                command: cmd || tc.name,
                exitCode: toolResult.isError ? 1 : 0,
                durationMs: toolResult.durationMs,
              });
            }
            // Cap what enters the MODEL context — a megabyte build log would
            // blow the window (and made the context bar spike absurdly). The
            // fetch_context can later identify the event and return only its
            // bounded, redacted durable preview.
            const TOOL_OUTPUT_CONTEXT_CAP = 30_000;
            const cappedResult =
              (toolResult.output?.length ?? 0) > TOOL_OUTPUT_CONTEXT_CAP
                ? {
                    ...toolResult,
                    output:
                      toolResult.output.slice(0, TOOL_OUTPUT_CONTEXT_CAP) +
                      `\n…[truncated ${toolResult.output.length - TOOL_OUTPUT_CONTEXT_CAP} chars${archiveId ? ` — durable preview via fetch_context id=${archiveId}` : ''}]`,
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
          observeCancellation();
        }
      }

      // A stop that lands between turns (or breaks out of the stream loop)
      // must still be reported as user-stopped, not a normal completion.
      observeCancellation();

      // Direct manager edits must pass the same gate as delegated work. This
      // happens before the final response is persisted so a model's optimistic
      // self-assessment cannot become the authoritative completion state.
      const directChanges = this.state.getChanges(sessionId);
      if (!stoppedByUser && directChanges.length > 0) {
        const settingsForGate = loadAgentSettings(managerCtx.workingDirectory);
        const hardBoundaryTask = createTaskContract(userMessage).taskKind === 'security-infra';
        const strictness = hardBoundaryTask
          ? 'strict'
          : settingsForGate.criticGateEnabled
            ? settingsForGate.gateStrictness
            : 'off';
        if (strictness === 'off') {
          messages.push({
            role: 'assistant',
            content:
              'UNVERIFIED: The requested edits were applied, but quality gates are disabled. No verified-success claim can be made.',
          });
        } else {
          const diffSections = await Promise.all(
            directChanges.map(async (change) => {
              const diff = await directGit.getDiff(change.path);
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
            { provider: providerName, model: routing.model },
          );
          if (!gate.passed) {
            messages.push({
              role: 'assistant',
              content:
                strictness === 'strict'
                  ? `QUALITY GATE FAILED: The edits remain available for inspection, but the task is not complete.\n\n${gate.feedback ?? 'Verification failed without usable evidence.'}`
                  : `UNVERIFIED: Advisory quality checks found issues.\n\n${gate.feedback ?? 'Verification failed without usable evidence.'}`,
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
      }

      // Criticism, hooks, persistence, and checkpointing are all asynchronous.
      // Cancellation must be sampled again after every such phase; the value
      // observed when the provider loop ended is not a commit decision.
      observeCancellation();

      const beforeComplete = await this.events.runWorkflowHooks('before-complete', sessionId, {
        stoppedByUser,
        changedFiles: directChanges.map((change) => change.path),
        lastAssistant:
          messages.filter((message) => message.role === 'assistant').at(-1)?.content ?? '',
      });
      observeCancellation();
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
      // Conversation text belongs in the message store, not in operational logs. Keep only
      // non-content metadata here so a long response, prompt excerpt, or credential echoed by
      // a provider cannot be copied into stdout or launcher/watchdog log files.
      koryLog.debug(
        { sessionId, contentLength: toPersist.length },
        'Attempting to persist assistant message',
      );
      let finalMessageId: string | undefined;
      if (this.messages && toPersist) {
        finalMessageId = responseMessageId ?? nanoid(12);
        // Persist the provider-reported token usage and computed cost with the
        // assistant message so the session counters (messageCount / totalCost)
        // reflect real spend — not just in the demo.
        const assistantCost = usageKnown
          ? (computeCostUsd(providerName, routing.model, tokensIn, tokensOut, {
              cacheReadTokens: cachedInputTokens,
              cacheWriteTokens: cacheWriteInputTokens,
            })?.costUsd ?? 0)
          : 0;
        const persistedAssistant = {
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
        } as const;
        if (regenerationBranch) {
          await this.messages.commitRegeneratedResponse(regenerationBranch, persistedAssistant);
        } else if (responseMessageId) {
          await this.messages.addIdempotent(sessionId, persistedAssistant);
        } else {
          await this.messages.add(sessionId, persistedAssistant);
        }
        koryLog.debug('Assistant message persisted');
        observeCancellation();
        if (usageKnown && !stoppedByUser) {
          await this.persistCompletedManagerUsage(
            sessionId,
            finalMessageId,
            routing.model,
            providerName,
            tokensIn,
            tokensOut,
            usageBreakdown,
            cachedInputTokens,
          );
        }
      }
      observeCancellation();
      if (interactionMode === 'plan' && !stoppedByUser) {
        try {
          const noteId = await syncPlanNote(
            sessionId,
            userMessage,
            toPersist,
            managerCtx.workingDirectory,
          );
          await this.sessions?.update(sessionId, { planNoteId: noteId });
        } catch (err) {
          koryLog.warn({ err, sessionId }, 'Failed to synchronize durable Plan note');
        }
      }
      observeCancellation();
      const hasActiveAgentProcess =
        !stoppedByUser && processSupervisor.hasActiveAgentToolForSession(sessionId);
      const activeProcessIds = hasActiveAgentProcess
        ? (await processSupervisor.getAgentBackgroundProcessesBySession(sessionId))
            .filter((process) => process.status === 'starting' || process.status === 'running')
            .map((process) => process.id)
        : [];
      observeCancellation();
      if (!stoppedByUser && hasActiveAgentProcess && activeProcessIds.length === 0) {
        throw new Error('Active background process has no durable continuation identity');
      }
      // Create the rewind point before publishing the authoritative terminal
      // transition. A terminal SessionRun is a commit fence: clients may reload
      // immediately after seeing it, so no turn-owned durable projection may be
      // intentionally written afterward.
      // was produced (e.g. tool-only turns, aborted turns with changes).
      // Skip only when there's no message AND no changes (nothing to checkpoint).
      const turnChanges = this.state.getChanges(sessionId);
      if (finalMessageId || turnChanges.length > 0) {
        await this.createRewindCheckpoint(
          sessionId,
          providerName,
          routing.model,
          userMessage,
          finalMessageId,
          tokensIn,
          tokensOut,
          turnChanges,
        );
      }

      observeCancellation();
      if (this.messages && stoppedByUser && (!regenerationBranch || finalMessageId)) {
        try {
          await this.messages.add(sessionId, {
            id: nanoid(12),
            sessionId,
            role: 'system',
            content: 'Stopped by user.',
            model: routing.model,
            provider: providerName,
            createdAt: Date.now(),
          });
        } catch (error) {
          // The authoritative cancellation must not be downgraded to a failed
          // run because its explanatory projection could not be appended.
          koryLog.warn({ error, sessionId }, 'Failed to persist user-stop marker');
        }
      }

      const changes = this.state.getChanges(sessionId);
      if (changes.length > 0) {
        await this.publishPendingSessionReview(sessionId, changes);
      }

      // This check and the following lifecycle call form the commit fence. No
      // await may be inserted between them: cancellation observed before the
      // fence wins; cancellation after finish starts loses to completion.
      const cancelledAtCommit = observeCancellation();
      const terminalStatus =
        cancelledAtCommit || activeProcessIds.length === 0 ? 'done' : 'waiting';
      if (cancelledAtCommit) {
        await this.runLifecycle.finish(handle, 'cancel', 'cancelled_by_user');
      } else if (terminalStatus === 'waiting') {
        await this.runLifecycle.waitForProcesses(handle, activeProcessIds);
      } else {
        await this.runLifecycle.finish(handle, 'complete', 'provider_turn_completed');
      }
      // Stop the heartbeat BEFORE emitting the terminal event. For 'waiting'
      // keep it alive: the run is parked, not over, and process completion will
      // wake the same durable continuation.
      if (terminalStatus === 'done') {
        this.stopHeartbeat(sessionId);
      }
      this.emitWSMessage(sessionId, 'agent.status', {
        agentId: KORY_IDENTITY.id,
        status: terminalStatus,
      });
      this.setHeartbeatPhase(sessionId, terminalStatus);

      // Auto-compaction is intentionally post-turn: never replace context while
      // the manager or its tools are still using it. Only a provider-reported
      // input count and a trusted model window can trigger it.
      const autoSettings = loadAgentSettings(managerCtx.workingDirectory);
      const trustedWindow = resolveTrustedContextWindow(routing.model, providerName);
      const thresholdPercent = Math.max(10, Math.min(99, autoSettings.autoCompactThreshold ?? 80));
      if (
        !stoppedByUser &&
        autoSettings.autoCompactEnabled !== false &&
        tokensIn > 0 &&
        trustedWindow.contextKnown &&
        trustedWindow.contextWindow &&
        tokensIn / trustedWindow.contextWindow >= thresholdPercent / 100
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
      this.processCompletionCoordinator.notifySessionIdle(sessionId);
    }
  }

  private async createRewindCheckpoint(
    sessionId: string,
    provider: string,
    model: string,
    prompt: string,
    messageId: string | undefined,
    tokensIn = 0,
    tokensOut = 0,
    changedFiles: Array<{ path: string; operation: 'create' | 'edit' | 'delete' }> = [],
  ) {
    try {
      // Gather turn-scoped instrumentation for rich metadata.
      const toolCalls = this.state.getToolCalls(sessionId);
      const commands = this.state.getCommands(sessionId);

      // Map ChangeSummary (with line counts) to fileEdits for the checkpoint.
      const fileEdits = changedFiles.map((f) => {
        const cs = f as {
          path: string;
          operation: 'create' | 'edit' | 'delete';
          linesAdded?: number;
          linesDeleted?: number;
        };
        return {
          path: f.path,
          operation: f.operation,
          linesAdded: cs.linesAdded,
          linesDeleted: cs.linesDeleted,
        };
      });

      const hasRichMetadata = Boolean(toolCalls.length || commands.length || fileEdits.length);

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
        // Rich instrumentation — lightweight previews, expandable on demand.
        summary: prompt.slice(0, 120),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        commands: commands.length > 0 ? commands : undefined,
        fileEdits: fileEdits.length > 0 ? fileEdits : undefined,
        provider,
        hasRichMetadata,
      };
      const checkpointDirectory = await this.resolveSessionWorkingDirectory(sessionId);
      if (this.timeTravel) {
        const result = await this.timeTravel
          .forWorkingDirectory(checkpointDirectory)
          .checkpoint(prompt.slice(0, 72), metadata);
        if (!result.success) throw new Error(result.message);
      } else {
        const { CheckpointStore } = await import('./checkpoint-store');
        const hash = await new CheckpointStore(checkpointDirectory).createGhostCommit(
          prompt.slice(0, 72),
          metadata,
        );
        if (!hash) throw new Error('Checkpoint publication failed');
      }
      // Clear turn instrumentation after the checkpoint has captured them.
      this.state.clearTurnInstrumentation(sessionId);
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
    providerConversationRevision?: number,
    forceFreshConversation = false,
  ): Promise<LLMTurnResult> {
    const handle = this.requireRunHandle(sessionId);
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
    let memorySupplementalContext = '';
    const notesEntries = Object.entries(settings.managerNotes ?? {}).filter(([, v]) => v?.trim());
    if (notesEntries.length > 0) {
      const notesSections = notesEntries
        .map(([group, text]) => `### ${group}\n${text.trim()}`)
        .join('\n\n');
      memorySupplementalContext += `\n\n## User Notes (standing guidance)\n${notesSections}`;
    }
    const agentContext = assembleAgentContext(promptRoot, settings);
    if (agentContext.preferences.trim()) {
      memorySupplementalContext += `\n\n## Durable user preferences\n${agentContext.preferences.trim()}`;
    }
    const memoryContext = assembleMemoryContext(promptRoot, sessionId);
    const automaticMemory = automaticMemoryPrompt(
      formatMemoryForContext(memoryContext),
      memoryContext.settings,
    );
    if (automaticMemory) memorySupplementalContext += `\n\n${automaticMemory}`;
    if (hasAnyVisibleNoteTools(promptRoot)) {
      const hint = buildNotesNetworkSystemHint(promptRoot);
      if (hint) memorySupplementalContext += `\n\n${hint}`;
      try {
        const { buildNotesNetworkPrompt } = await import('../memory/unified-memory');
        memorySupplementalContext += await buildNotesNetworkPrompt(2500, promptRoot);
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Notes DB may be unavailable — continuing without network context',
        );
      }
    }
    const researchSupplementalContext = settings.multiSourceResearch
      ? '\n\n• DEEP RESEARCH: When researching complex topics, do not rely on a single source. Use the web_search tool to find multiple perspectives and fetch/read at least 3-5 different pages to verify information and identify consensus or contradictions.'
      : '';
    const managerCompilation = compilePrompt({
      role: 'manager',
      mode: getModeManager().getMode(),
      provider: provider.name,
      model: modelId,
      occupiedContextTokenUpperBound:
        estimateOccupiedContextTokenUpperBound(messages) +
        textTokenUpperBound(memorySupplementalContext) +
        textTokenUpperBound(researchSupplementalContext),
      reservedOutputTokens: MANAGER_OUTPUT_TOKEN_LIMIT,
      requireVerifiedContextWindow: true,
      workingDirectory: promptRoot,
      taskContract: createTaskContract(taskGoal, {
        goalContext: this.goalContextBySession.get(sessionId),
      }),
      contextPaths: this.config.contextPaths,
      skillSelection: {
        collisionChoices: this.skillCollisionChoicesBySession.get(sessionId),
        ...(interactionMode === 'plan' ? { pins: ['plan-mode'] } : {}),
      },
    });
    if (managerCompilation.warnings?.length) {
      for (const w of managerCompilation.warnings) {
        this.emitWSMessage(sessionId, 'system.info', { message: w });
      }
    }
    let systemPrompt =
      managerCompilation.systemPrompt + memorySupplementalContext + researchSupplementalContext;
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
    // Chars contributed by injected memory/notes — tracked separately so the
    // context-usage bar can show memory as its own segment.
    const memoryChars = memorySupplementalContext.length;

    // Filter tools based on local web search setting
    let tools = filterToolDefsForNotesPermissions(
      this.tools.getToolDefsForRole('manager'),
      promptRoot,
    );
    if (settings.localWebSearch === 'off') {
      tools = tools.filter((t) => t.name !== 'web_search');
    }
    if (interactionMode === 'plan' || forceFreshConversation) {
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
        'get_note_properties',
        'query_note_base',
        'render_note',
        'fetch_context',
        'load_skill_detail',
      ]);
      tools = tools.filter((tool) => allowed.has(tool.name));
      systemPrompt += forceFreshConversation
        ? '\n\nRESPONSE-ONLY REGENERATION IS ENFORCED BY THE HOST. Produce another answer from retained evidence. You cannot edit project files, run shell commands, commit, create pull requests, delegate, or write Notes. If current workspace inspection would be required, say so instead of changing anything.'
        : '\n\nPLAN MODE IS ENFORCED BY THE HOST. You cannot edit project files, run shell commands, commit, create pull requests, delegate, or write arbitrary Notes. Koryphaios synchronizes the dedicated Plan note after each turn.';
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
    // (rendered neutrally as "Provider remainder" in the context bar).
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
    const permissionPolicy = resolveToolPermissionPolicy(
      settings,
      forceFreshConversation ? 'plan' : interactionMode,
    );

    const streamSignal = withTimeoutSignal(signal, AGENT.LLM_STREAM_TIMEOUT_MS);
    const stream = this.providers.executeWithRetry(
      {
        model: modelId,
        systemPrompt,
        messages: providerMessages,
        tools,
        maxTokens: MANAGER_OUTPUT_TOKEN_LIMIT,
        signal: streamSignal,
        ...(normalizedReasoning !== undefined && { reasoningLevel: normalizedReasoning }),
        ...(fastMode === true && { fastMode: true }),
        // Agentic CLI providers (claude-code) run + edit files in the session's project directory.
        workingDirectory: await this.resolveSessionWorkingDirectory(sessionId),
        sessionId,
        providerConversationRevision,
        ...(forceFreshConversation && { forceFreshConversation: true }),
        harnessRole: 'manager',
        permissionMode: permissionPolicy.mode as AgentSettings['permissionMode'],
        promptManifestHash: managerCompilation.manifest.hash,
        taskContractHash: managerCompilation.manifest.taskContractHash,
        promptCache: managerCompilation.promptCache,
        sandbox: SANDBOX_PRESETS.readonly,
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
    let cachedInputTokens = 0;
    let cacheWriteInputTokens = 0;
    let usageKnown = false;

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
            await this.runLifecycle.phase(handle, 'streaming', 'provider_content');
            this.setHeartbeatPhase(sessionId, 'streaming');
            this.emitWSMessage(sessionId, 'stream.delta', {
              agentId: KORY_IDENTITY.id,
              content: delta,
              model: modelId,
            });
          }
        } else if (event.type === 'thinking_delta') {
          if (event.thinking || typeof event.thinkingTokens === 'number') {
            await this.runLifecycle.phase(handle, 'thinking', 'provider_reasoning');
            this.setHeartbeatPhase(sessionId, 'thinking');
            this.emitWSMessage(sessionId, 'agent.status', {
              agentId: KORY_IDENTITY.id,
              status: 'thinking',
              detail: 'Provider reported reasoning activity',
            });
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
            // Archive a bounded, redacted edit preview for later identification.
            await getContextArchive()?.record(
              sessionId,
              'file_edit',
              `${event.fileOperation ?? 'edit'} ${event.filePath}`,
              event.fileContent ?? '',
            );
          }
        } else if (event.type === 'tool_executed') {
          observedNativeTool = true;
          await this.runLifecycle.phase(handle, 'tool_calling', 'provider_tool');
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
            } catch (err: unknown) {
              logBackgroundRegistrationFailure({
                cwd: ctx.workingDirectory,
                error: err,
                phase: 'input_invalid',
                sessionId,
                toolCallId: callId,
              });
            }
            void processSupervisor
              .registerExternal({
                name: `cli:${bgMatch[1]}`,
                command: bgCommand,
                sessionId,
                outputFile: bgMatch[2],
              })
              .catch((err: unknown) => {
                // Background process registration is fire-and-forget — the command
                // is already running; failure to track it doesn't affect the user.
                logBackgroundRegistrationFailure({
                  command: bgCommand,
                  cwd: ctx.workingDirectory,
                  error: err,
                  phase: 'registration_failed',
                  sessionId,
                  toolCallId: callId,
                });
              });
          }
          const agenticArchiveId = await getContextArchive()?.record(
            sessionId,
            'tool_result',
            `${event.toolName ?? 'tool'} ${(event.toolInput ?? '').slice(0, 140)}`,
            event.toolOutput ?? '',
            event.isError === true,
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
          this.setHeartbeatPhase(sessionId, 'tool_calling');
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
          if (typeof event.tokensCacheRead === 'number') {
            cachedInputTokens = Math.max(cachedInputTokens, event.tokensCacheRead);
          }
          if (typeof event.tokensCacheWrite === 'number') {
            cacheWriteInputTokens = Math.max(cacheWriteInputTokens, event.tokensCacheWrite);
          }
          usageKnown = true;
          this.emitUsageUpdate(
            sessionId,
            KORY_IDENTITY.id,
            modelId,
            provider.name,
            tokensIn,
            tokensOut,
            true,
            contextBreakdown,
            cachedInputTokens,
          );
        } else if (event.type === 'tool_use_start') {
          hasToolCalls = true;
          await this.runLifecycle.phase(handle, 'tool_calling', 'tool_requested');
          pendingToolCalls.set(event.toolCallId!, { name: event.toolName!, input: '' });
          this.setHeartbeatPhase(sessionId, 'tool_calling');
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
            } catch (err: unknown) {
              serverLog.debug(
                { err: err instanceof Error ? err.message : String(err) },
                'Malformed tool input JSON, defaults to {}',
              );
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
        usage: {
          tokensIn,
          tokensOut,
          usageKnown,
          ...(usageKnown
            ? { cachedInputTokens, cacheWriteInputTokens, breakdown: contextBreakdown }
            : {}),
        },
        completedToolCalls,
        observedNativeTool,
      };
    }
    return {
      success: assistantContent.length > 0,
      content: assistantContent,
      usage: {
        tokensIn,
        tokensOut,
        usageKnown,
        ...(usageKnown
          ? { cachedInputTokens, cacheWriteInputTokens, breakdown: contextBreakdown }
          : {}),
      },
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
    ctx: ToolContext,
  ): Promise<ToolCallOutput | null> {
    if (!isNoteToolName(tc.name)) return null;

    const check = checkNoteToolPermission(tc.name, ctx.workingDirectory, {
      yoloMode: ctx.permissionPolicy?.mode === 'yolo',
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

    // If the active preset already asks for this tool, let the central tool
    // gate issue the single approval prompt instead of double-prompting.
    const presetDecision = decideToolPermission(ctx.permissionPolicy, tc.name);
    if (check.requiresApproval && presetDecision.action !== 'ask') {
      const summary = formatNoteToolApprovalSummary(
        tc.name,
        (tc.input ?? {}) as Record<string, unknown>,
      );
      const selection = await this.waitForUserInputInternal(
        sessionId,
        `Allow agent to ${summary}?`,
        ['Allow', 'Reject'],
        { allowOther: false, allowKeepChatting: false },
      );
      if (
        selection === '__timeout__' ||
        selection.includes('Reject') ||
        selection.includes('Cancel')
      ) {
        return {
          callId: tc.id,
          name: tc.name,
          output:
            selection === '__timeout__'
              ? 'Note action rejected: timed out waiting for approval'
              : 'Note action rejected by user',
          isError: true,
          durationMs: 0,
        };
      }
    }

    return null;
  }

  /** Archive a bounded, redacted manager-tool preview for fetch_context. */
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
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Unstringifiable tool call input',
        );
      }
      return await archive.record(
        sessionId,
        tc.name === 'bash' || tc.name === 'shell_manage' ? 'terminal' : 'tool_result',
        `${tc.name} ${inputSummary}`,
        toolResult.output ?? '',
        toolResult.isError,
      );
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to record tool call in context archive',
      );
      return undefined;
    }
  }

  /**
   * Replace stale/hidden tool outputs in the in-flight message array with tiny
   * stubs pointing at the archive. The agent can later retrieve the bounded,
   * redacted durable preview via fetch_context.
   */
  private async applyContextPruning(
    sessionId: string,
    messages: InternalMessage[],
    currentTurn: number,
  ): Promise<void> {
    const archive = getContextArchive();
    if (!archive) return;
    const { loadAgentSettings } = await import('../agent-settings');
    const settings = loadAgentSettings(await this.resolveSessionWorkingDirectory(sessionId));
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
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Failed to parse message content as JSON, keeping empty shell',
        );
      }
      m.content = JSON.stringify({
        callId: original.callId ?? meta.tool_call_id,
        name: original.name,
        output: `[Output ${oversized ? 'was too large for the live context and was pruned' : 'pruned'} to save context: ${entry?.label ?? 'tool output'}${entry ? ` at ${new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}. Retrieve the bounded, redacted preview with fetch_context id=${meta.archiveId}]`,
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
      const selection = await this.waitForUserInputInternal(sessionId, question, options);
      return {
        callId: tc.id,
        name: tc.name,
        output: `User selected: ${selection}`,
        isError: false,
        durationMs: 0,
      };
    }
    const gated = await this.gateNoteToolCall(sessionId, tc, ctx);
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
  async executeWithProvider(
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
    let tokensIn = 0;
    let tokensOut = 0;
    let usageKnown = false;
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

    const goalContext = this.goalContextBySession.get(sessionId) ?? taskContract?.goalContext;
    const resolvedReasoningLevel =
      reasoningLevel === 'auto' ? determineAutoReasoningLevel(userMessage) : reasoningLevel;
    const ctx: ToolContext = {
      sessionId,
      agentId: workerId,
      activeProvider: provider.name,
      activeModel: modelId,
      reasoningLevel: resolvedReasoningLevel,
      goalId: goalContext?.goalId,
      goalItemId: goalContext?.itemId,
      workingDirectory: workerWorkingDirectory,
      signal: abort.signal,
      allowedPaths,
      approvedToolCallIds: new Set(),
      emitFileEdit: (e) =>
        this.emitWSMessage(sessionId, 'stream.file_delta', { agentId: workerId, ...e }),
      emitFileComplete: (e) =>
        this.emitWSMessage(sessionId, 'stream.file_complete', { agentId: workerId, ...e }),
      recordChange: (c) => this.state.recordChange(sessionId, c),
      waitForUserInput: (question, options, opts) =>
        this.waitForUserInputInternal(sessionId, question, options, opts),
    } as ToolContext;
    Object.defineProperties(ctx, {
      permissionPolicy: {
        get() {
          const s = loadAgentSettings(workerWorkingDirectory);
          return resolveSubAgentPermissionPolicy(s, s.subAgentApproval);
        },
        enumerable: true,
        configurable: true,
      },
      sandboxOptions: {
        get() {
          const s = loadAgentSettings(workerWorkingDirectory);
          return resolveSubAgentSandboxOptions(s, s.subAgentApproval, isSandboxed);
        },
        enumerable: true,
        configurable: true,
      },
      isSandboxed: {
        get() {
          const s = loadAgentSettings(workerWorkingDirectory);
          return resolveSubAgentSandboxOptions(s, s.subAgentApproval, isSandboxed).isSandboxed;
        },
        enumerable: true,
        configurable: true,
      },
    });
    const history = await this.loadHistory(sessionId);
    const messages: InternalMessage[] = [...history, { role: 'user', content: userMessage }];
    const workerSettings = loadAgentSettings(workerWorkingDirectory);
    let workerSupplementalContext = '';
    const workerGuidance = assembleAgentContext(workerWorkingDirectory, workerSettings);
    if (workerGuidance.preferences.trim()) {
      workerSupplementalContext += `\n\n## Durable user preferences\n${workerGuidance.preferences.trim()}`;
    }
    const workerMemory = assembleMemoryContext(workerWorkingDirectory, sessionId);
    const automaticWorkerMemory = automaticMemoryPrompt(
      formatMemoryForContext(workerMemory),
      workerMemory.settings,
    );
    if (automaticWorkerMemory) workerSupplementalContext += `\n\n${automaticWorkerMemory}`;
    if (hasAnyVisibleNoteTools(workerWorkingDirectory)) {
      const hint = buildNotesNetworkSystemHint(workerWorkingDirectory);
      if (hint) workerSupplementalContext += `\n\n${hint}`;
      try {
        const { buildNotesNetworkPrompt } = await import('../memory/unified-memory');
        workerSupplementalContext += await buildNotesNetworkPrompt(2500, workerWorkingDirectory);
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Notes DB may be unavailable for worker system prompt',
        );
      }
    }
    const workerCompilation = compilePrompt({
      role: 'worker',
      mode: getModeManager().getMode(),
      provider: provider.name,
      model: modelId,
      occupiedContextTokenUpperBound:
        estimateOccupiedContextTokenUpperBound(messages) +
        textTokenUpperBound(workerSupplementalContext),
      reservedOutputTokens: WORKER_OUTPUT_TOKEN_LIMIT,
      requireVerifiedContextWindow: true,
      workingDirectory: workerWorkingDirectory,
      taskContract: {
        ...(taskContract ??
          createTaskContract(userMessage, {
            scope: allowedPaths,
            constraints: isSandboxed ? ['Stay within the granted filesystem paths'] : [],
          })),
        goalContext,
      },
      contextPaths: this.config.contextPaths,
      skillSelection: {
        collisionChoices: this.skillCollisionChoicesBySession.get(sessionId),
      },
    });
    if (workerCompilation.warnings?.length) {
      for (const w of workerCompilation.warnings) {
        this.emitWSMessage(sessionId, 'system.info', { message: w });
      }
    }
    const workerSystemPrompt = workerCompilation.systemPrompt + workerSupplementalContext;

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
      promptCache: workerCompilation.promptCache,
      toolRole: 'worker',
      reasoningLevel: resolvedReasoningLevel,
      maxTurns: 25,
      maxTokens: WORKER_OUTPUT_TOKEN_LIMIT,
      messages,
      threadEntries: [],
      ctx,
      abort,
      busy: false,
      updatedAt: Date.now(),
    };
    this.agentThreads.set(workerId, thread);
    try {
      // Do not expose a worker until its active identity is on the durable
      // SessionRun. That gives restart recovery an exact terminal target.
      await this.recordAgentThreadRunMembership(thread, true);
    } catch (error) {
      this.agentThreads.delete(workerId);
      this.workers.removeWorker(workerId);
      return {
        success: false,
        error: `Could not durably start worker: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    this.events.emitAgentSpawned(sessionId, identity, userMessage);
    this.emitUsageUpdate(
      sessionId,
      workerId,
      modelId,
      provider.name,
      tokensIn,
      tokensOut,
      usageKnown,
    );
    this.appendAgentThreadEntry(thread, 'manager', userMessage);

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
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to build image content block',
      );
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
    const gated = await this.gateNoteToolCall(sessionId, tc, ctx);
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
      // The owner stack clears busy and emits its terminal state only after
      // provider/tool work acknowledges the signal. Clearing it here allowed
      // a second follow-up to overlap the still-running cancelled one.
    }
    this.workers.cancelWorker(agentId);
  }

  /** Read the authoritative context preview for a model the user just picked.
   *  Exact occupancy is reusable only when the last provider report came from
   *  this same route and exact conversation boundary. The caller applies the
   *  response for its current picker generation; this method never emits or
   *  persists preview state. */
  async previewModelContext(sessionId: string, modelId: string, providerName: ProviderName) {
    const imageAttachmentCountPromise = this.messages?.countContextImageAttachments
      ? this.messages.countContextImageAttachments(sessionId, 1000)
      : (this.messages?.getContextMessages(sessionId, 1000) ?? Promise.resolve([])).then(
          (contextMessages) =>
            contextMessages.reduce(
              (count, message) =>
                count +
                (message.role === 'user'
                  ? (message.attachments?.filter((attachment) => attachment.type === 'image')
                      .length ?? 0)
                  : 0),
              0,
            ),
        );
    const [last, boundary, imageAttachmentCount] = await Promise.all([
      getContextArchive()?.getLastUsage(sessionId),
      this.messages?.getActiveBoundary(sessionId),
      imageAttachmentCountPromise,
    ]);
    const context = resolveTrustedContextWindow(modelId, providerName);
    // Provider-reported token counts are only authoritative for the exact
    // routing identity and conversation boundary that produced them.
    // Different providers may tokenize the same transcript differently, and
    // any new message, rewind, or compaction changes the occupied context.
    // Reusing an old occupancy or breakdown would also retain a stale
    // "Provider remainder" segment. Legacy snapshots fail closed here too.
    const sameSnapshot =
      last?.model === modelId &&
      last?.provider === providerName &&
      usageSnapshotMatchesBoundary(last, boundary);
    const used = sameSnapshot ? last.used : 0;
    const breakdown = sameSnapshot ? last.breakdown : undefined;
    const cachedInputTokens = sameSnapshot ? last.cachedInputTokens : undefined;
    // Preview is intentionally response-only. The composer guards HTTP
    // responses with its current selection generation; an unsolicited usage
    // websocket event has no such request identity and could let a delayed
    // preview overwrite a newer provider/model choice. Real provider usage is
    // emitted live, then persisted only after the final assistant message has
    // established the completed conversation boundary.
    return {
      model: modelId,
      provider: providerName,
      used,
      contextWindow: context.contextWindow ?? 0,
      contextKnown: context.contextKnown,
      contextSource: context.contextSource,
      usageKnown: sameSnapshot,
      hasImageAttachments: imageAttachmentCount > 0,
      imageAttachmentCount,
      ...(typeof cachedInputTokens === 'number' ? { cachedInputTokens } : {}),
      ...(breakdown ? { breakdown } : {}),
    };
  }

  private tryBeginSessionRun(sessionId: string): boolean {
    if (
      this.erasedSessions.has(sessionId) ||
      this.sessionMutationBarriers.has(sessionId) ||
      this.sessionRunClaims.has(sessionId) ||
      this.managerAbortBySession.has(sessionId) ||
      this.compactingSessions.has(sessionId) ||
      this.workers.hasSessionWorkers(sessionId)
    ) {
      return false;
    }
    this.sessionRunClaims.add(sessionId);
    return true;
  }

  private endSessionRun(sessionId: string): void {
    this.sessionRunClaims.delete(sessionId);
    this.state.touchSession(sessionId);
    this.processCompletionCoordinator.notifySessionIdle(sessionId);
  }

  private requireRunHandle(sessionId: string): ManagerRunHandle {
    const handle = this.runContext.getStore();
    if (!handle || handle.sessionId !== sessionId) {
      throw new Error(`Session ${sessionId} has no generation-bound execution context`);
    }
    return handle;
  }

  private assertRunHandleActive(handle: ManagerRunHandle): void {
    const current = this.requireRunHandle(handle.sessionId);
    if (current.runId !== handle.runId) {
      throw new DOMException('A stale session callback lost execution ownership', 'AbortError');
    }
    const controller = this.runControllerByHandle.get(handle);
    if (!controller || this.managerAbortBySession.get(handle.sessionId) !== controller) {
      throw new DOMException('Session execution generation is no longer current', 'AbortError');
    }
    if (controller.signal.aborted) {
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new DOMException('Session run cancelled', 'AbortError');
    }
  }

  /** Atomically block new manager/worker/compaction intent while a coordinated
   * session recovery is in progress. The process-supervisor barrier is acquired
   * separately by the route, closing both lifecycle start races. */
  tryAcquireSessionMutationBarrier(sessionId: string): { release(): void } | null {
    if (
      this.erasedSessions.has(sessionId) ||
      this.sessionMutationBarriers.has(sessionId) ||
      this.sessionRunClaims.has(sessionId) ||
      this.managerAbortBySession.has(sessionId) ||
      this.compactingSessions.has(sessionId) ||
      this.titleGenerationBySession.has(sessionId) ||
      this.workers.hasSessionWorkers(sessionId) ||
      this.runLifecycle.isAuthoritativelyLive(sessionId)
    ) {
      return null;
    }
    this.sessionMutationBarriers.add(sessionId);
    let held = true;
    return {
      release: () => {
        if (!held) return;
        held = false;
        this.sessionMutationBarriers.delete(sessionId);
      },
    };
  }

  /** Install an erasure barrier before the first await, cancel existing work,
   * and wait until every in-memory producer has acknowledged cancellation. */
  tryBeginSessionErasure(sessionId: string): ManagerSessionErasureLease | null {
    if (this.erasedSessions.has(sessionId) || this.sessionMutationBarriers.has(sessionId)) {
      return null;
    }
    this.sessionMutationBarriers.add(sessionId);
    const cancellation = this.cancelSessionWorkers(sessionId);
    this.titleGenerationBySession
      .get(sessionId)
      ?.abort(new DOMException('Session is being deleted', 'AbortError'));
    let settled = false;
    const hasExecution = () =>
      this.sessionRunClaims.has(sessionId) ||
      this.managerAbortBySession.has(sessionId) ||
      this.compactingSessions.has(sessionId) ||
      this.titleGenerationBySession.has(sessionId) ||
      [...this.restartHandoffConsumers.values()].some(
        (consumer) => consumer.sessionId === sessionId,
      ) ||
      this.workers.hasSessionWorkers(sessionId);
    return {
      waitForIdle: async (timeoutMs = 10_000) => {
        await cancellation;
        const deadline = Date.now() + timeoutMs;
        while (hasExecution()) {
          if (Date.now() >= deadline) {
            throw new Error(
              'Session erasure timed out waiting for manager and worker cancellation to settle',
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      },
      complete: () => {
        if (settled) return;
        settled = true;
        this.cleanupSession(sessionId);
        this.sessionMutationBarriers.delete(sessionId);
        this.erasedSessions.add(sessionId);
      },
      rollback: () => {
        if (settled) return;
        settled = true;
        this.sessionMutationBarriers.delete(sessionId);
        this.titledSessions.delete(sessionId);
        this.processCompletionCoordinator.resumeSession(sessionId);
      },
    };
  }

  async cancelSessionWorkers(sessionId: string): Promise<void> {
    // Snapshot ownership before aborting. A process-local execution owner must
    // be the only writer that publishes its terminal transition: it may still
    // need to persist a partial assistant response and cleanup after observing
    // the AbortSignal. Durable waits have no such stack and can be terminalized
    // directly here.
    const locallyOwned =
      this.sessionRunClaims.has(sessionId) ||
      this.managerAbortBySession.has(sessionId) ||
      this.compactingSessions.has(sessionId);
    for (const consumer of this.restartHandoffConsumers.values()) {
      if (consumer.sessionId === sessionId) consumer.controller.abort();
    }
    this.runs?.cancelRestartHandoffsForSession(sessionId, 'cancelled_by_user');
    // Suppress queued wake work before aborting the manager or signalling
    // terminals, otherwise a kill event can immediately resurrect the session.
    this.processCompletionCoordinator.cancelSession(sessionId);
    this.state.resolveUserInput(sessionId, '__cancelled__');
    this.abortManagerRun(sessionId);
    this.abortCompaction(sessionId);
    this.workers.cancelSessionWorkers(sessionId);
    const cancellationWork: Promise<unknown>[] = [
      processSupervisor.cancelAgentBackgroundProcessesForSession(sessionId),
    ];
    if (!locallyOwned) {
      cancellationWork.push(
        this.runLifecycle.cancelCurrent(sessionId, 'cancelled_by_user'),
      );
    }
    const results = await Promise.allSettled(cancellationWork);
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `Session ${sessionId} cancellation did not settle cleanly`,
      );
    }
  }

  /** True if the session has an active manager run or any worker. */
  hasActiveSessionExecution(sessionId: string): boolean {
    if (this.sessionRunClaims.has(sessionId)) return true;
    if (this.managerAbortBySession.has(sessionId)) return true;
    if (this.compactingSessions.has(sessionId)) return true;
    return this.workers.hasSessionWorkers(sessionId);
  }

  /** Durable liveness includes restart-safe waits even when no local stack owns them. */
  hasDurableSessionRun(sessionId: string): boolean {
    return this.runLifecycle.isAuthoritativelyLive(sessionId);
  }

  /** Process-wait wakeups must ignore the durable wait they are resuming, but
   * still respect every process-local owner and mutation gate. */
  isLocallyBlockedForProcessWake(sessionId: string): boolean {
    return (
      this.sessionMutationBarriers.has(sessionId) || this.hasActiveSessionExecution(sessionId)
    );
  }

  /** Destructive/external callers need both local and durable lifecycle truth. */
  isSessionRunning(sessionId: string): boolean {
    return (
      this.sessionMutationBarriers.has(sessionId) ||
      this.hasActiveSessionExecution(sessionId) ||
      this.hasDurableSessionRun(sessionId)
    );
  }

  getStatus() {
    return this.workers.getStatus();
  }

  async cancel(): Promise<void> {
    const sessionIds = new Set(this.workers.cancelAll());
    for (const handoff of this.runs?.listRestartHandoffs(1_000) ?? []) {
      sessionIds.add(handoff.sessionId);
    }
    const locallyOwned = new Set<string>();
    for (const sid of this.sessionRunClaims) {
      sessionIds.add(sid);
      locallyOwned.add(sid);
    }
    this.managerAbortBySession.forEach((ac, sid) => {
      sessionIds.add(sid);
      locallyOwned.add(sid);
      ac.abort();
    });
    for (const sid of this.compactingSessions.keys()) {
      sessionIds.add(sid);
      locallyOwned.add(sid);
    }
    for (const controller of this.compactingSessions.values()) controller.abort();
    const cancellations: Promise<void>[] = [];
    for (const sid of sessionIds) {
      for (const consumer of this.restartHandoffConsumers.values()) {
        if (consumer.sessionId === sid) consumer.controller.abort();
      }
      this.runs?.cancelRestartHandoffsForSession(sid, 'global_cancel');
      this.processCompletionCoordinator.cancelSession(sid);
      this.state.resolveUserInput(sid, '__cancelled__');
      if (!locallyOwned.has(sid)) {
        this.stopHeartbeat(sid);
        this.emitWSMessage(sid, 'agent.status', {
          agentId: KORY_IDENTITY.id,
          status: 'done',
        });
        this.setHeartbeatPhase(sid, 'done');
      }
      cancellations.push(
        (async () => {
          const work: Promise<unknown>[] = [
            processSupervisor.cancelAgentBackgroundProcessesForSession(sid),
          ];
          if (!locallyOwned.has(sid)) {
            work.push(this.runLifecycle.cancelCurrent(sid, 'global_cancel'));
          }
          const results = await Promise.allSettled(work);
          for (const result of results) {
            if (result.status === 'rejected') {
              koryLog.error(
                { sessionId: sid, error: result.reason },
                'Global cancellation cleanup failed',
              );
            }
          }
        })(),
      );
    }
    this.isProcessing = false;
    koryLog.info('All workers cancelled via global cancel');
    await Promise.all(cancellations);
  }

  private async loadHistory(
    sessionId: string,
    boundaryMessageId?: string,
  ): Promise<InternalMessage[]> {
    return (
      (await (boundaryMessageId
        ? this.messages?.getContextMessagesAtBoundary(sessionId, boundaryMessageId, 1000)
        : this.messages?.getContextMessages(sessionId, 1000)))
        // System rows are UI markers (e.g. "Stopped by user.") — never part of
        // the conversation sent back to the model.
        ?.filter((m) => m.role !== 'system' || m.content.startsWith('[KORY_COMPACTION]'))
        .map((m) => {
          const images = m.attachments?.filter((attachment) => attachment.type === 'image') ?? [];
          // Only user-supplied images are valid future image inputs. A
          // generated assistant image is visible transcript history, but most
          // provider protocols do not accept an image block in assistant role;
          // reattaching it would silently flatten or reject the next turn.
          const shouldAttachImages = m.role === 'user' && images.length > 0;
          return {
            role: (m.role === 'system' ? 'user' : m.role) as InternalMessage['role'],
            content: shouldAttachImages
              ? [
                  { type: 'text' as const, text: m.content },
                  ...images.map((attachment) => ({
                    type: 'image' as const,
                    imageData: attachment.data,
                    imageMimeType: attachment.mimeType ?? 'image/png',
                  })),
                ]
              : m.content.replace(/^\[KORY_COMPACTION\]\n?/, 'Authoritative compacted context:\n'),
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
  ): Promise<{ runId: string }> {
    if (this.sessions && !(await this.getActiveSession(sessionId))) {
      throw new ConflictError('Recover this archived chat before messaging this agent.');
    }
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

    // A follow-up is a new provider/tool turn, not a UI mutation and not an
    // extension that may silently borrow whichever manager run happens to be
    // active. It therefore acquires its own durable, cancellable SessionRun.
    const admission = await this.reserveSessionTurn(sessionId, 'agent_followup_turn');
    if (!admission) {
      throw new ConflictError('Wait for chat lifecycle work to finish before messaging this agent.');
    }
    let dispatched = false;
    try {
      // Recheck after admission so a stale preflight cannot race another
      // cancellation control against the thread object.
      if (this.agentThreads.get(agentId) !== thread || thread.sessionId !== sessionId) {
        throw new Error('Agent thread is no longer available');
      }
      if (thread.busy) {
        throw new Error('Agent is already working');
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

      const ownerController = this.turnAdmissions.get(admission)?.controller;
      if (!ownerController) throw new Error('Agent follow-up lost its session admission');
      thread.abort = ownerController;
      thread.ctx = { ...thread.ctx, signal: ownerController.signal };
      // Publish busy before dispatching. A second message or individual cancel
      // must see ownership even while provider resolution is awaiting.
      thread.busy = true;
      thread.updatedAt = Date.now();
      thread.messages.push({ role: 'user', content: trimmed });
      this.appendAgentThreadEntry(thread, 'user', trimmed);

      const work = this.dispatchAdmittedWork(
        admission,
        async ({ signal, phase }) => {
          await phase('thinking', 'agent_followup_started');
          signal.throwIfAborted();
          await this.runAgentThread(agentId);
        },
        'agent_followup_completed',
      );
      dispatched = true;
      thread.activeRun = work;
      void work
        .catch((err) => {
          const cancelled =
            admission.signal.aborted || (err instanceof Error && err.name === 'AbortError');
          const detail = {
            agentId,
            sessionId,
            err: err instanceof Error ? err.message : String(err),
          };
          if (cancelled) koryLog.debug(detail, 'Direct agent message cancelled');
          else koryLog.error(detail, 'Direct agent message failed');
        })
        .finally(() => {
          if (thread.activeRun === work) thread.activeRun = undefined;
        });
      return { runId: admission.runId };
    } catch (error) {
      thread.busy = false;
      if (!dispatched && this.turnAdmissions.has(admission)) {
        await (admission.signal.aborted
          ? this.cancelSessionTurn(admission, 'agent_followup_cancelled_before_dispatch')
          : this.rejectSessionTurn(admission, 'agent_followup_dispatch_failed')
        ).catch((settleError) => {
          koryLog.error(
            { sessionId, agentId, settleError },
            'Failed to settle an undispatched agent follow-up',
          );
        });
      }
      throw error;
    }
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

  /**
   * Worker/critic/direct-agent UI state has an identity separate from the
   * manager. Persist it on the authoritative run before advertising activity
   * so restart recovery can close the exact card instead of leaving a replayed
   * "thinking" worker alive forever. Calls outside an admitted manager run
   * deliberately do nothing: they have no durable generation to mutate.
   */
  private async recordAgentThreadRunMembership(
    thread: AgentThreadState,
    active: boolean,
  ): Promise<void> {
    if (!this.runs) return;
    const handle = this.runContext.getStore();
    if (!handle || handle.sessionId !== thread.sessionId) return;
    const snapshot = this.runs.get(thread.sessionId);
    if (
      !snapshot ||
      snapshot.runId !== handle.runId ||
      snapshot.status !== 'active' ||
      !(
        snapshot.phase === 'analyzing' ||
        snapshot.phase === 'thinking' ||
        snapshot.phase === 'streaming' ||
        snapshot.phase === 'tool_calling' ||
        snapshot.phase === 'compacting'
      )
    ) {
      return;
    }
    const known = new Set(snapshot.activeAgentIds);
    if (active) known.add(thread.identity.id);
    else known.delete(thread.identity.id);
    const activeAgentIds = [...known].sort();
    if (
      activeAgentIds.length === snapshot.activeAgentIds.length &&
      activeAgentIds.every((agentId, index) => agentId === snapshot.activeAgentIds[index])
    ) {
      return;
    }
    await this.runLifecycle.phase(
      handle,
      snapshot.phase,
      active ? 'agent_thread_started' : 'agent_thread_settled',
      activeAgentIds,
    );
  }

  private async runAgentThread(agentId: string, providerOverride?: Provider): Promise<void> {
    const thread = this.agentThreads.get(agentId);
    if (!thread) throw new Error('Agent thread not found');
    thread.busy = true;
    thread.status = 'thinking';
    thread.updatedAt = Date.now();

    try {
      await this.recordAgentThreadRunMembership(thread, true);
      this.emitWSMessage(thread.sessionId, 'agent.status', {
        agentId: thread.identity.id,
        status: thread.status,
      });
      const provider =
        providerOverride ??
        (await this.providers.resolveProvider(thread.modelId, thread.providerName));
      if (!provider) throw new Error('Agent provider unavailable');
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
      const aborted =
        thread.abort?.signal.aborted || (err instanceof Error && err.name === 'AbortError');
      thread.status = aborted ? 'done' : 'error';
      thread.updatedAt = Date.now();
      if (!aborted) {
        this.emitWSMessage(thread.sessionId, 'agent.error', {
          agentId: thread.identity.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.emitWSMessage(thread.sessionId, 'agent.status', {
        agentId: thread.identity.id,
        status: thread.status,
      });
      throw err;
    } finally {
      thread.busy = false;
      try {
        // A terminal agent.status was emitted immediately before this finally
        // block. If the durable membership cleanup cannot be acknowledged, it
        // is safer to leave the id for restart recovery to terminalize again.
        await this.recordAgentThreadRunMembership(thread, false);
      } catch (error) {
        koryLog.warn(
          { error, sessionId: thread.sessionId, agentId: thread.identity.id },
          'Could not clear durable agent-thread run membership',
        );
      }
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
          thread.ctx.workingDirectory,
        ),
        maxTokens: thread.maxTokens,
        signal: streamSignal,
        workingDirectory: thread.ctx.workingDirectory,
        sessionId: thread.sessionId,
        sandbox: SANDBOX_PRESETS.readonly,
        harnessRole: thread.toolRole,
        permissionMode: (thread.toolRole === 'critic'
          ? 'plan'
          : thread.ctx.permissionPolicy?.mode) as AgentSettings['permissionMode'] | undefined,
        promptManifestHash: thread.promptManifestHash,
        taskContractHash: thread.taskContractHash,
        promptCache: thread.promptCache,
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
        assistantContent += event.content ?? '';
        thread.status = 'streaming';
        thread.updatedAt = Date.now();
        this.emitWSMessage(thread.sessionId, 'stream.delta', {
          agentId: thread.identity.id,
          content: event.content,
          model: thread.modelId,
        });
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
          } catch (err: unknown) {
            serverLog.debug(
              { err: err instanceof Error ? err.message : String(err) },
              'Malformed tool input JSON, defaults to {}',
            );
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
      occupiedContextTokenUpperBound: estimateOccupiedContextTokenUpperBound(messages),
      reservedOutputTokens: WORKER_OUTPUT_TOKEN_LIMIT,
      requireVerifiedContextWindow: true,
      workingDirectory: ctx.workingDirectory,
      taskContract: createTaskContract(workerGoal, {
        scope: ctx.allowedPaths ?? [],
        goalContext: this.goalContextBySession.get(sessionId),
      }),
      contextPaths: this.config.contextPaths,
      skillSelection: {
        collisionChoices: this.skillCollisionChoicesBySession.get(sessionId),
      },
    });
    if (fallbackCompilation.warnings?.length) {
      for (const w of fallbackCompilation.warnings) {
        this.emitWSMessage(sessionId, 'system.info', { message: w });
      }
    }
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
      promptCache: fallbackCompilation.promptCache,
      toolRole: 'worker',
      reasoningLevel,
      maxTurns: 1,
      maxTokens: WORKER_OUTPUT_TOKEN_LIMIT,
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
    this.processCompletionCoordinator.cancelSession(sessionId);
    void processSupervisor.cancelAgentBackgroundProcessesForSession(sessionId);
    // Cancel any active workers for this session
    this.workers.cancelSessionWorkers(sessionId);

    // Abort any ongoing manager run
    this.abortManagerRun(sessionId);
    this.abortCompaction(sessionId);
    for (const [handoffId, consumer] of this.restartHandoffConsumers) {
      if (consumer.sessionId !== sessionId) continue;
      consumer.controller.abort();
      const retry = this.restartHandoffRetryTimers.get(handoffId);
      if (retry) clearTimeout(retry);
      this.restartHandoffRetryTimers.delete(handoffId);
    }

    // Clear pending user inputs (reject with abort error)
    if (this.state.hasPendingInput(sessionId)) {
      this.state.resolveUserInput(sessionId, '');
    }

    // Clear session-specific data
    this.state.cleanupSession(sessionId);
    this.sessionRunClaims.delete(sessionId);
    this.managerRoutingBySession.delete(sessionId);
    this.managerAbortBySession.delete(sessionId);
    this.compactingSessions.delete(sessionId);
    this.runLifecycle.forget(sessionId);
    this.titledSessions.delete(sessionId);
    this.titleGenerationBySession.get(sessionId)?.abort();
    this.titleGenerationBySession.delete(sessionId);
    this.promptManifestHashBySession.delete(sessionId);
    this.skillCollisionChoicesBySession.delete(sessionId);
    this.goalContextBySession.delete(sessionId);
    this.sessionWorkingDirs.delete(sessionId);
    this.stopHeartbeat(sessionId);
    this.heartbeatPhaseBySession.delete(sessionId);
    for (const timer of this.usageRetryTimersBySession.get(sessionId) ?? []) clearTimeout(timer);
    this.usageRetryTimersBySession.delete(sessionId);
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
      const lastActivityAt = this.state.getLastActivityAt(sessionId);
      const isLive =
        activeSessionIds.has(sessionId) ||
        this.sessionRunClaims.has(sessionId) ||
        this.managerAbortBySession.has(sessionId) ||
        this.compactingSessions.has(sessionId) ||
        this.state.hasPendingInput(sessionId) ||
        this.runLifecycle.isAuthoritativelyLive(sessionId);
      if (isLive || lastActivityAt === null || now - lastActivityAt < maxSessionAgeMs) continue;
      this.cleanupSession(sessionId);
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

  /**
   * Prune stale git-managed resources: orphaned worktree refs and old checkpoints.
   * Called periodically by BackgroundCleanupService to prevent unbounded accumulation.
   */
  async pruneResources(checkpointRetentionDays = 30): Promise<void> {
    const tasks: Promise<void>[] = [];

    if (this.workspaceManager) {
      tasks.push(
        this.workspaceManager.prune().then((r) => {
          if (!r.success) koryLog.warn({ msg: r.message }, 'Worktree prune failed');
        }),
      );
    }

    if (this.timeTravel) {
      tasks.push(
        this.timeTravel.prune(checkpointRetentionDays).then((r) => {
          if (!r.success) koryLog.warn({ msg: r.message }, 'Checkpoint prune failed');
        }),
      );
    }

    await Promise.allSettled(tasks);
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
  shutdown(): Promise<void> {
    if (!this.shutdownPromise) this.shutdownPromise = this.shutdownInternal();
    return this.shutdownPromise;
  }

  private async shutdownInternal(): Promise<void> {
    koryLog.info('Shutting down KoryManager');

    const activeAgentFollowups = [...this.agentThreads.values()]
      .map((thread) => thread.activeRun)
      .filter((run): run is Promise<void> => run !== undefined);

    // Detach lifecycle writes before aborting stacks. Waiting continuations
    // are restart-safe and must not be terminalized by their local AbortError;
    // active rows are reconciled explicitly by the server after this returns.
    this.runLifecycle.detach();

    this.unsubscribeProcessLifecycle?.();
    this.unsubscribeProcessLifecycle = undefined;

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
    for (const controller of this.compactingSessions.values()) controller.abort();
    this.compactingSessions.clear();
    for (const controller of this.titleGenerationBySession.values()) controller.abort();
    this.titleGenerationBySession.clear();
    for (const consumer of this.restartHandoffConsumers.values()) consumer.controller.abort();
    for (const timer of this.restartHandoffRetryTimers.values()) clearTimeout(timer);
    this.restartHandoffRetryTimers.clear();
    // Handoff runners own ordinary manager abort controllers. Let those stacks
    // observe the abort and release/requeue their durable command leases before
    // the database is closed by the server.
    await Promise.allSettled([...this.restartHandoffTasks.values()]);
    // Direct agent follow-ups own provider/tool stacks outside WorkerLifecycle.
    // Do not clear their thread/context state until those stacks acknowledge
    // the shared SessionRun abort signal.
    await Promise.allSettled(activeAgentFollowups);
    // A runner can schedule a bounded retry while observing shutdown abort.
    // Clear again after every runner has settled so no timer can outlive the
    // manager and touch a closing database.
    for (const timer of this.restartHandoffRetryTimers.values()) clearTimeout(timer);
    this.restartHandoffRetryTimers.clear();
    for (const timers of this.usageRetryTimersBySession.values()) {
      for (const timer of timers) clearTimeout(timer);
    }
    this.usageRetryTimersBySession.clear();
    this.turnAdmissions.clear();
    this.sessionRunClaims.clear();
    this.sessionMutationBarriers.clear();
    this.erasedSessions.clear();
    this.sessionWorkingDirs.clear();

    // Clear all session state
    this.state.cleanupAll();
    this.agentThreads.clear();

    // Drain active worktrees before the server closes the database/process.
    if (this.workspaceManager) {
      await this.workspaceManager.shutdown();
    }

    koryLog.info('KoryManager shutdown complete');
  }

  emitThought(sessionId: string, phase: string, thought: string) {
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
      if (wd) {
        const requested = resolve(wd);
        if (!existsSync(requested) || !statSync(requested).isDirectory()) {
          throw new Error(`Session project directory is unavailable: ${requested}`);
        }
        resolved = realpathSync(requested);
      }
    } catch (err: unknown) {
      serverLog.warn(
        { sessionId, err: err instanceof Error ? err.message : String(err) },
        'Failed to resolve the session project directory',
      );
      throw err;
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
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to build goal context prompt',
      );
      return '';
    }
  }

  /** Allow a CLI harness turn to end. This is a lifecycle/cancellation
   *  boundary, not a Goal verifier verdict; Goal completion is adjudicated
   *  independently. */
  async cliHarnessMayEndTurn(_sessionId: string): Promise<boolean> {
    return true;
  }

  /** Record a file change from a CLI tool execution. Called by the MCP bridge
   *  execute endpoint so changes made via kory__ tools are tracked. */
  recordChange(sessionId: string, change: ChangeSummary): void {
    try {
      this.state.recordChange(sessionId, change);
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'Best effort recordChange failed — state may not exist for CLI-only sessions',
      );
    }
  }

  /** Session-owned file evidence used by coordinated periodic checkpoints. */
  getRecordedSessionChanges(sessionId: string): ChangeSummary[] {
    return this.state.getChanges(sessionId);
  }

  /** Truncate tool input/output previews for checkpoint metadata. */
  private truncateToolPreview(value: string | undefined, maxLen = 200): string | undefined {
    if (value === undefined) return undefined;
    return value.length > maxLen ? value.slice(0, maxLen - 1) + '…' : value;
  }

  private async persistCompletedManagerUsage(
    sessionId: string,
    expectedActiveMessageId: string,
    model: string,
    provider: ProviderName,
    tokensIn: number,
    tokensOut: number,
    breakdown?: ContextBreakdown,
    cachedInputTokens?: number,
  ): Promise<boolean> {
    const archive = getContextArchive();
    if (!archive || !this.messages || this.erasedSessions.has(sessionId)) return false;
    try {
      const boundary = await this.messages.getActiveBoundary(sessionId);
      // A new message can race the completed assistant write. Never stamp the
      // previous turn's usage onto that newer conversation boundary.
      if (boundary.messageId !== expectedActiveMessageId) {
        serverLog.debug(
          { sessionId, expectedActiveMessageId, activeMessageId: boundary.messageId },
          'Skipped context usage snapshot because the conversation advanced',
        );
        return false;
      }
      const win = resolveTrustedContextWindow(model, provider);
      await archive.recordUsage(sessionId, {
        used: tokensIn + tokensOut,
        max: win.contextWindow ?? 0,
        contextKnown: win.contextKnown,
        model,
        provider,
        activeMessageId: boundary.messageId,
        contextRevision: boundary.contextRevision,
        ...(typeof cachedInputTokens === 'number' ? { cachedInputTokens } : {}),
        ...(breakdown ? { breakdown } : {}),
        ts: Date.now(),
      });
      return true;
    } catch (error) {
      if (!this.erasedSessions.has(sessionId)) {
        serverLog.debug(
          { sessionId, error: error instanceof Error ? error.message : String(error) },
          'Context usage snapshot could not be persisted',
        );
      }
      return false;
    }
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
    cachedInputTokens?: number,
  ) {
    if (this.erasedSessions.has(sessionId)) return;
    this.events.emitUsageUpdate(
      sessionId,
      agentId,
      model,
      provider,
      tokensIn,
      tokensOut,
      usageKnown,
      breakdown,
      cachedInputTokens,
    );
    // Live provider usage is response-only until the final assistant message
    // establishes an exact conversation boundary. Stream-time archive writes
    // could race that completed snapshot and make stale occupancy durable.
    if (agentId === KORY_IDENTITY.id && usageKnown) {
      const win = resolveTrustedContextWindow(model, provider);
      // Window resolution can lose the startup race (provider model lists
      // refresh in the background). Retry once shortly after — if the window
      // is known by then, re-emit so the bar stops saying "unknown".
      if (!win.contextKnown) {
        const t = setTimeout(() => {
          const timers = this.usageRetryTimersBySession.get(sessionId);
          timers?.delete(t);
          if (timers?.size === 0) this.usageRetryTimersBySession.delete(sessionId);
          if (this.erasedSessions.has(sessionId)) return;
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
              cachedInputTokens,
            );
          }
        }, 6_000);
        t.unref?.();
        const timers = this.usageRetryTimersBySession.get(sessionId) ?? new Set();
        timers.add(t);
        this.usageRetryTimersBySession.set(sessionId, timers);
      }
    }
  }
  private emitWSMessage(sessionId: string, type: string, payload: WSMessage['payload']) {
    this.events.emit(sessionId, type, payload);
  }

  /** Update the phase reported by the next heartbeat for this session.
   *  Called at every manager status transition. */
  private setHeartbeatPhase(sessionId: string, phase: AgentStatus): void {
    this.heartbeatPhaseBySession.set(sessionId, phase);
  }

  /** Start emitting agent.heartbeat every 5s for this session. The client
   *  watchdog resets on each heartbeat, so a quiet-but-alive run (e.g. a
   *  long bash tool) won't be falsely declared dead.
   *
   *  Jitter: ±500ms so concurrent sessions don't thunder-herd on the same
   *  tick. unref(): the timer doesn't keep the Node process alive. */
  private startHeartbeat(sessionId: string): void {
    this.stopHeartbeat(sessionId);
    const interval = 5_000 + (Math.random() * 1_000 - 500);
    const timer = setInterval(() => {
      const phase = this.heartbeatPhaseBySession.get(sessionId) ?? 'streaming';
      this.emitWSMessage(sessionId, 'agent.heartbeat', {
        agentId: KORY_IDENTITY.id,
        sessionId,
        phase,
      });
    }, interval);
    timer.unref?.();
    this.heartbeatBySession.set(sessionId, timer);
  }

  /** Stop the heartbeat for a session. Called when the run terminates. */
  private stopHeartbeat(sessionId: string): void {
    const timer = this.heartbeatBySession.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatBySession.delete(sessionId);
    }
    this.heartbeatPhaseBySession.delete(sessionId);
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
