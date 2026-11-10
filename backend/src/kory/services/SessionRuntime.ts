// Per-session server state for KoryManager.
//
// Every manager field keyed by sessionId lives as a typed property on one
// SessionRuntime. Deleting or erasing a session disposes the whole runtime in
// one call, so a field cannot be missed by the cleanup path.
// See docs/architecture/transcript-integrity.md Invariant 5.

import type { AgentStatus, ProviderName } from '@koryphaios/shared';
import type { Provider } from '../../providers/types';
import type { TaskContract } from '../prompts';

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

export class SessionRuntime {
  /** Per-chat mirror of the composer's YOLO pill. Nothing enforces from it;
   *  approval comes from the durable per-chat preset (see getIsYoloMode). */
  yoloModeMirror?: boolean;

  /** AbortController for the current manager run (so cancelSessionWorkers can abort the manager too). */
  abort?: AbortController;

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

  /** Steering drain in flight per agent. Removed by the drain that created it. */
  steeringDrains = new Map<string, Promise<{ runId: string } | null>>();

  /** Pending usage-retry timers. */
  usageRetryTimers = new Set<ReturnType<typeof setTimeout>>();

  /** Last visible prompt manifest hash; prevents repeated disclosure on tool-loop turns. */
  promptManifestHash?: string;

  /** Collision choices persist per project and are reused by task workers/critics. */
  skillCollisionChoices?: SkillCollisionChoices;

  /** User-selected manager identity, used only to enforce role independence. */
  managerRouting?: SessionRuntimeRouting;

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
    this.managerRouting = undefined;
    this.contextWindowOverride = undefined;
    this.contextShrinkHints.clear();
    this.cachePrewarm = undefined;
    this.compacting = undefined;
    this.providerPreflight = undefined;
    this.lastAutoCompactFailureAt = undefined;
    this.goalContext = undefined;
    this.autoContinuationIssued = false;
    this.warnedUnverifiedContextWindows.clear();
    this.warnedCompilationMessages.clear();
    this.workingDir = undefined;
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
