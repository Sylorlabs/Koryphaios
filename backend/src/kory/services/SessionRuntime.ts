// Per-session server state for KoryManager.
//
// Every manager field keyed by sessionId lives as a typed property on one
// SessionRuntime. Deleting or erasing a session disposes the whole runtime in
// one call, so a field cannot be missed by the cleanup path.
// See docs/architecture/transcript-integrity.md Invariant 5.

import type { AgentFallbackStep, AgentStatus, ProviderName } from '@koryphaios/shared';
import type { Provider } from '../../providers/types';
import type { TaskContract } from '../prompts';
import { AsyncChildLedger, CompareGroupLedger } from '../async-children';
import type { FallbackStickyState, FallbackTurnState } from '../fallback-chain';
import type { TerminalSession } from '../../terminal/terminal-session';

export type SkillCollisionChoices = Record<string, 'personal' | 'project'>;

export interface SessionRuntimeRouting {
  model: string;
  provider: ProviderName | undefined;
}

export interface SessionRuntimeWorkerUsage {
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

export interface SessionRuntimeProviderPreflight {
  routing: SessionRuntimeRouting;
  provider: Provider;
}

/** Manager routing changes are per chat and remain in effect until changed. */
export interface SessionRuntimeManagerControl {
  model: string;
  provider?: ProviderName;
  reasoningLevel?: string;
  fallbacks: AgentFallbackStep[];
}

export class SessionRuntime {
  /** Per-chat mirror of the composer's YOLO pill. Nothing enforces from it;
   *  approval comes from the durable per-chat preset (see getIsYoloMode). */
  yoloModeMirror?: boolean;

  /** AbortController for the current manager run (so cancelSessionWorkers can abort the manager too). */
  abort?: AbortController;

  /** Fallback-chain hop state for the manager turn in flight. Set at turn start. */
  fallbackTurn?: FallbackTurnState;
  /** Where a `never` or `after_reset` chain left the manager, carried across turns. */
  fallbackSticky?: FallbackStickyState;

  /** Synchronous intent claim covering provider resolution, intent interviews
   *  and every other pre-controller await. */
  runClaimed = false;
  /** Wall-clock install time of the run claim, used to tell a hung owner that
   *  stopped making durable progress from a healthy long-running turn. */
  runClaimedAt?: number;

  /** True once a full session.updated was broadcast during this turn. */
  updatedDuringTurn = false;

  /** Repeated stop clicks share one cancellation transaction. Owned by the cancel
   *  call that installs it; dispose() does not clear it. */
  cancellation?: Promise<void>;

  /** Time Travel and erasure barrier. A new manager turn cannot start between
   *  the busy check and the workspace transaction. Owned by the operation that
   *  installs it; dispose() does not clear it. */
  mutationBarrier = false;

  /** Workers started through runWorkerPipeline. CLI managers delegate via the
   *  MCP bridge, so enforcement compares this against a turn-start baseline. */
  workerStartCount?: number;

  /** Worker token spend accumulated during the current manager turn, folded
   *  into the assistant message cost. */
  pendingWorkerUsage?: SessionRuntimeWorkerUsage;

  /** Heartbeat timer: emits agent.heartbeat every 5s while a run is active. */
  heartbeat?: ReturnType<typeof setInterval>;
  /** Latest manager phase, used to populate agent.heartbeat. */
  heartbeatPhase?: AgentStatus;

  /** In-flight naming operation; completed titles live in the DB. */
  titlePromise?: Promise<void>;
  titleAbort?: AbortController;

  /** Serializes concurrent waitForUserInput calls (parallel CLI tool calls can
   *  issue two questions or a question plus an approval at once): each wait
   *  chains behind the previous one so a second park cannot clobber the first
   *  resolver. Resolves when the current wait finishes; never rejects. */
  questionQueue: Promise<void> = Promise.resolve();

  /** Host-recorded MCP-bridge tool executions for the session's current run.
   *  Managed CLIs call Kory tools through a dispatcher their transcript shows
   *  only as `execute`/`mcp_call_tool`, so this ledger is the authoritative
   *  list critics can verify against. Replaced when the leased run changes;
   *  capped at 200 entries. */
  bridgeToolLedger: {
    runId: string;
    entries: Array<{ name: string; input: string; output: string; isError: boolean; at: number }>;
  } | null = null;

  /** Steering drain in flight per agent. Removed by the drain that created it. */
  steeringDrains = new Map<string, Promise<{ runId: string } | null>>();

  /** User sends parked behind the live run for checkpoint steering, keyed by
   *  their durable agent_steering_commands row id. A non-empty map is what
   *  tells the manager turn loop to yield at the next safe boundary instead
   *  of finishing the turn — see docs/architecture/transcript-integrity.md.
   *  The durable row is the restart-surviving receipt; this map only carries
   *  full input fidelity (attachments, model parameters) the row cannot. */
  pendingSteerInputs = new Map<string, import('../manager').SessionTurnCommandInput>();

  /** Worker agents started with wait:false in this chat, and their delivery
   *  state. Results reach the manager as host-authored continuations. */
  asyncChildren = new AsyncChildLedger();
  /** Attempts recorded under each compare group id in this chat. */
  compareGroups = new CompareGroupLedger();
  /** Set by Stop: finished async results are held and not auto-delivered until
   *  the user sends again or wait_for_agents claims them. */
  asyncDeliveryHeld = false;
  /** Compare group the manager asked the end-of-turn critic to rank. */
  pendingCompareReview?: string;

  /** Pending usage-retry timers. */
  usageRetryTimers = new Set<ReturnType<typeof setTimeout>>();

  /** Last visible prompt manifest hash; prevents repeated disclosure on tool-loop turns. */
  promptManifestHash?: string;

  /** Collision choices persist per project and are reused by task workers/critics. */
  skillCollisionChoices?: SkillCollisionChoices;

  /** Skills whose full instructions this chat's agent already holds in its
   *  live context (load_skill_detail results not yet compacted, pruned, or
   *  shrunk away). The feeder feeds these as minimal pointers only. */
  skillDetailInContext = new Set<string>();

  /** Skills this chat's agent blocked via manage_skill_feeding. The feeder
   *  stops injecting them until unblocked or the chat is disposed. Mirrored
   *  durably in the session's agentOverrides.blockedSkillFeeds and rehydrated
   *  from there when a fresh runtime replaces a disposed one (idle reaper,
   *  app restart), so a block outlives the process that made it. */
  skillFeedBlocked = new Set<string>();
  /** Whether skillFeedBlocked has been seeded from the durable override this
   *  runtime lifetime. One-shot: later durable changes flow through the tool. */
  skillFeedBlocksHydrated = false;

  /** Signature of the last emitted kory.skill feed set; the feeder emits a
   *  feed row only when the fed skill set actually changes, not every turn. */
  emittedSkillSetKey?: string;
  /** Skill names fed on the most recent turn, for manage_skill_feeding report. */
  lastFedSkills?: string[];

  /** User-selected manager identity, used only to enforce role independence. */
  managerRouting?: SessionRuntimeRouting;

  /** Critic routes (`${provider}:${model}`) that recently failed to run, with
   *  the failure time and message. Entries expire after a TTL at read time so
   *  a transiently broken route becomes eligible again without bookkeeping. */
  failedCriticRoutes = new Map<string, { failedAt: number; error: string }>();

  /** Explicit manager controls keyed by manager agent id. A control applies to
   *  manager turns until changed, except when the user pins a model on the
   *  request. Keys are manager identities, not the chat, so peer-manager records
   *  do not collide with the primary manager. */
  managerControls = new Map<string, SessionRuntimeManagerControl>();

  /** True once this runtime has copied the durable agent override blob. */
  agentOverridesHydrated = false;

  /** Client-side session context budget (tokens) from the composer. Budgeting only. */
  contextWindowOverride?: number;

  /** Last successful shrink level per provider+model. Keyed by `${provider} ${model}`. */
  contextShrinkHints = new Map<string, number>();

  cachePrewarm?: { key: string; at: number };

  /** Automatic or manual compaction in progress. */
  compacting?: AbortController;

  /** Provider preflight shared with handleDirectly so a turn does not resolve twice. */
  providerPreflight?: SessionRuntimeProviderPreflight;

  /** Last automatic-compaction failure; cooldown prevents a crash loop. */
  lastAutoCompactFailureAt?: number;

  /** Tool-context modes this chat's agent chose for itself. Wins over the
   *  user's project-wide `toolContextPolicies`. */
  toolContextOverrides = new Map<string, import('../../tool-context-policy').ToolContextMode>();

  /** Agent-authored or auxiliary-model summaries keyed by archive id. Applied
   *  when a tool result is assembled into the agent's context. */
  toolSummaries = new Map<
    string,
    { summary: string; toolName: string; ts: number; source: 'agent' | 'model' }
  >();

  /** The agent asked to compact before the configured pressure threshold. */
  compactionRequested?: { at: number; reason: string };

  /** Goal state is immutable task context, not a conversational suggestion. */
  goalContext?: NonNullable<TaskContract['goalContext']>;

  /** Guard: at most one automatic 25-turn-cap continuation per session run chain. */
  autoContinuationIssued = false;

  /** Unverified-context warnings, emitted once per provider/model. */
  warnedUnverifiedContextWindows = new Set<string>();
  /** Other compilation warnings, emitted once per dedupe key. */
  warnedCompilationMessages = new Set<string>();

  /** Per-session project folder: a chat created with a project open runs there. */
  workingDir?: string;
  /** Workspace preparation in flight. Owned by its operation; dispose() does not clear it. */
  workspacePreparation?: Promise<string>;
  /** Bumped whenever the session's workspace binding changes (isolate_chat /
   *  merge_chat_back). A workingDir prepared under an older epoch is never
   *  cached, so the next resolution re-reads the new binding. */
  workspaceEpoch = 0;
  /** Set when the chat's workspace binding changed earlier in the current turn
   *  (isolate_chat or merge_chat_back). While set, workspace-mutating tools are
   *  denied — the manager's ToolContext still points at the pre-change root.
   *  `resume` marks the isolate case: after this turn the host schedules one
   *  automatic continuation in the new workspace. Cleared at the next run claim. */
  workspaceRebindPending?: { resume: boolean; note: string };
  /** A workspace-mutating tool (write/patch/delete/bash/git) ran successfully
   *  earlier this turn while the chat ran in place. isolate_chat refuses then:
   *  uncommitted in-place edits cannot move to the copy. Reset at run claim. */
  mutatedInPlaceThisTurn = false;

  /** This chat's integrated terminals (PTY shells), keyed by terminal id.
   *  Scoped to the chat by construction; dispose() kills them. */
  terminals = new Map<string, TerminalSession>();

  /** Clears timers and drops per-session state. Aborts nothing: aborts belong
   *  to the operation that owns the controller (the manager clears the title
   *  run before calling dispose). */
  dispose(): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.heartbeatPhase = undefined;
    for (const timer of this.usageRetryTimers) clearTimeout(timer);
    this.usageRetryTimers.clear();
    this.steeringDrains.clear();
    this.questionQueue = Promise.resolve();
    this.bridgeToolLedger = null;
    this.pendingSteerInputs.clear();
    this.asyncChildren.dispose();
    this.compareGroups.dispose();
    this.asyncDeliveryHeld = false;
    this.pendingCompareReview = undefined;
    this.abort = undefined;
    this.runClaimed = false;
    this.runClaimedAt = undefined;
    this.yoloModeMirror = undefined;
    this.updatedDuringTurn = false;
    this.workerStartCount = undefined;
    this.pendingWorkerUsage = undefined;
    this.titlePromise = undefined;
    this.titleAbort = undefined;
    this.promptManifestHash = undefined;
    this.skillCollisionChoices = undefined;
    this.skillDetailInContext.clear();
    this.skillFeedBlocked.clear();
    this.emittedSkillSetKey = undefined;
    this.lastFedSkills = undefined;
    this.managerRouting = undefined;
    this.failedCriticRoutes.clear();
    this.managerControls.clear();
    this.agentOverridesHydrated = false;
    this.contextWindowOverride = undefined;
    this.contextShrinkHints.clear();
    this.cachePrewarm = undefined;
    this.compacting = undefined;
    this.providerPreflight = undefined;
    this.lastAutoCompactFailureAt = undefined;
    this.toolContextOverrides.clear();
    this.toolSummaries.clear();
    this.compactionRequested = undefined;
    this.goalContext = undefined;
    this.autoContinuationIssued = false;
    this.warnedUnverifiedContextWindows.clear();
    this.warnedCompilationMessages.clear();
    this.workingDir = undefined;
    this.workspaceEpoch += 1;
    this.workspaceRebindPending = undefined;
    this.mutatedInPlaceThisTurn = false;
    for (const terminal of this.terminals.values()) terminal.dispose();
    this.terminals.clear();
  }
}

export class SessionRuntimeRegistry {
  private readonly byId = new Map<string, SessionRuntime>();

  /** Writers only: creates the runtime if absent. */
  get(sessionId: string): SessionRuntime {
    let runtime = this.byId.get(sessionId);
    if (!runtime) {
      runtime = new SessionRuntime();
      this.byId.set(sessionId, runtime);
    }
    return runtime;
  }

  /** Readers and checks: never creates. A read that creates a runtime for a
   *  deleted or erased session is a bug. */
  peek(sessionId: string): SessionRuntime | undefined {
    return this.byId.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.byId.has(sessionId);
  }

  /** Disposes the session's runtime and removes it from the registry. */
  dispose(sessionId: string): void {
    const runtime = this.byId.get(sessionId);
    if (!runtime) return;
    runtime.dispose();
    this.byId.delete(sessionId);
  }

  sessionIds(): string[] {
    return [...this.byId.keys()];
  }
}
