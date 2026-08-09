// Run-state core — the pure state machine, extracted from run-state.svelte.ts
// so it can be unit-tested without the Svelte 5 rune compiler.
//
// The .svelte.ts wrapper owns the reactive $state<Map> and delegates every
// transition to `createRunStateEngine`, which holds the actual logic:
//   - applyEvent (the single reducer)
//   - startRun / markUserStopped / markAgentStopped / clearUserStopped
//   - phase predicates and status sets
//   - deriveButtonState / phaseToAgentStatus
//
// The engine operates on a plain Map<string, SessionRunState> passed in by
// the caller. The caller is responsible for reactivity (calling its
// `commit()` after any mutation) and for timer lifecycle (watchdog, done-
// linger). The engine reports timer requests via callbacks so the reactive
// layer can wire them to real setTimeout / clearTimeout.

import type { WSMessage, AgentStatus, AgentHeartbeatPayload } from '@koryphaios/shared';

export type RunPhase =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'tool_calling'
  | 'waiting_terminal' // parked on a background shell
  | 'waiting_user' // asked the user a question
  | 'done'
  | 'error';

export interface ButtonState {
  /** The single mode the composer button should render. */
  mode: 'stop' | 'waiting' | 'send' | 'disabled';
  /** Real, event-derived reason for a waiting state — never hardcoded. */
  waitingReason: string;
  /** Underlying phase for status icons / sidebar indicators. */
  phase: RunPhase;
}

export interface SessionRunState {
  phase: RunPhase;
  waitingReason: string;
  /** True after the user clicks Stop — suppresses late buffered events
   *  from resurrecting a dead run. Cleared on the next user message. */
  stoppedByUser: boolean;
  /** Timestamp of the last evidence-of-life event. The watchdog fires when
   *  now - lastActivityAt > BUSY_WATCHDOG_MS. */
  lastActivityAt: number;
  /** Agent IDs currently in a non-terminal, non-waiting status for this
   *  session. When this empties, the run is over. */
  activeAgents: Set<string>;
}

// ─── Phase predicates ───────────────────────────────────────────────────────

/** Phases that count as "alive" — the button shows Stop. */
export function isActivePhase(phase: RunPhase): boolean {
  return (
    phase === 'thinking' ||
    phase === 'streaming' ||
    phase === 'tool_calling'
  );
}

/** Phases that mean the session is parked, not running. */
export function isWaitingPhase(phase: RunPhase): boolean {
  return phase === 'waiting_terminal' || phase === 'waiting_user';
}

/** Terminal phases — a real terminal event was received. Stale events
 *  arriving after these must NOT resurrect the run. The done-linger timer
 *  auto-reverts done → idle after DONE_LINGER_MS; idle is NOT terminal (a
 *  stream event after idle means the watchdog was a false positive and the
 *  run is actually still alive). */
export function isTerminalPhase(phase: RunPhase): boolean {
  return phase === 'done' || phase === 'error';
}

/** Event types that carry active content and could resurrect a dead run if
 *  they arrive stale (from coalescer flush, provider trailing chunks, or WS
 *  replay). Terminal agent.status payloads (done/idle/error) are NOT
 *  resurrecting — they're already terminal.
 *
 *  compaction.* is intentionally excluded: compaction is a post-turn
 *  operation that legitimately starts AFTER agent.status: done (the backend
 *  emits done, then starts compaction in a setTimeout). Suppressing it would
 *  break the real compaction flow. */
const RESURRECTING_EVENT_TYPES = new Set([
  'stream.delta',
  'stream.thinking',
  'stream.tool_call',
  'stream.tool_result',
  'stream.file_delta',
  'stream.file_complete',
  'stream.clear_content',
  'stream.usage',
  'kory.thought',
  'kory.routing',
  'kory.ask_user',
]);

/** Check if a message would resurrect a dead run. Stream/kory/compaction
 *  events are always resurrecting. For agent.status, only active or waiting
 *  statuses count — terminal statuses (done/idle/error) are already terminal
 *  and pass through. */
function isResurrectingEvent(msg: WSMessage): boolean {
  if (RESURRECTING_EVENT_TYPES.has(msg.type)) return true;
  if (msg.type === 'agent.status') {
    const p = msg.payload as { status?: AgentStatus };
    return (
      !!p.status &&
      (ACTIVE_AGENT_STATUSES.has(p.status) || WAITING_AGENT_STATUSES.has(p.status))
    );
  }
  return false;
}

// ─── Status sets ────────────────────────────────────────────────────────────

/** Agent statuses that count as "active" (the run is alive). */
export const ACTIVE_AGENT_STATUSES = new Set<AgentStatus>([
  'thinking',
  'analyzing',
  'tool_calling',
  'streaming',
  'verifying',
  'compacting',
  'reading',
  'writing',
  'searching',
  'criticizing',
]);

/** Agent statuses that mean "parked" (waiting, not done). */
export const WAITING_AGENT_STATUSES = new Set<AgentStatus>(['waiting', 'waiting_user']);

/** Agent statuses that are terminal. */
export const TERMINAL_AGENT_STATUSES = new Set<AgentStatus>(['done', 'idle', 'error']);

// ─── Pure mappings ──────────────────────────────────────────────────────────

/** Map a RunPhase back to an AgentStatus for status-icon consumers
 *  (AnimatedStatusIcon, sidebar indicators) that still expect the old
 *  status vocabulary. */
export function phaseToAgentStatus(phase: RunPhase): AgentStatus {
  switch (phase) {
    case 'thinking':
      return 'thinking';
    case 'streaming':
      return 'streaming';
    case 'tool_calling':
      return 'tool_calling';
    case 'waiting_terminal':
      return 'waiting';
    case 'waiting_user':
      return 'waiting_user';
    case 'done':
      return 'done';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

/**
 * Collapse a phase + send-ability into the single button mode the composer
 * renders. One derivation, used by every attribute (onclick, disabled,
 * class, aria-label) — they can no longer drift apart.
 *
 *   stop     — a run is alive; click cancels it.
 *   waiting  — parked on something external AND the composer is empty;
 *              click cancels the wait. If the user typed text, we flip to
 *              send so they can steer while Kory is parked.
 *   send     — nothing running, message ready to go.
 *   disabled — nothing running and nothing to send.
 */
export function deriveButtonState(
  phase: RunPhase,
  canSend: boolean,
  waitingReason = '',
): ButtonState {
  if (isActivePhase(phase)) return { mode: 'stop', waitingReason: '', phase };
  if (isWaitingPhase(phase)) {
    return canSend
      ? { mode: 'send', waitingReason, phase }
      : { mode: 'waiting', waitingReason, phase };
  }
  return canSend
    ? { mode: 'send', waitingReason: '', phase }
    : { mode: 'disabled', waitingReason: '', phase };
}

// ─── Suppression ────────────────────────────────────────────────────────────

/** Events that are suppressed when the user has stopped the session —
 *  late buffered junk from the backend that must not resurrect a dead run. */
const SUPPRESSED_WHEN_STOPPED = new Set([
  'stream.delta',
  'stream.thinking',
  'stream.tool_call',
  'stream.tool_result',
  'stream.file_delta',
  'stream.file_complete',
  'stream.usage',
  'stream.clear_content',
  'kory.thought',
  'kory.routing',
  'kory.ask_user',
]);

/** Agent statuses that are suppressed when stopped (active ones from a
 *  still-running backend we asked to cancel). Terminal statuses pass. */
function isSuppressedStatus(status: AgentStatus): boolean {
  return !TERMINAL_AGENT_STATUSES.has(status) && !WAITING_AGENT_STATUSES.has(status);
}

// ─── Engine ─────────────────────────────────────────────────────────────────

export interface RunStateTimers {
  /** Arm the watchdog. Called when the phase becomes active (and is not
   *  tool_calling, which suspends the watchdog). The caller wires this to
   *  a real setTimeout. */
  armWatchdog: (sessionId: string) => void;
  /** Clear the watchdog timer for a session. */
  clearWatchdog: (sessionId: string) => void;
  /** Arm the done-linger timer (auto-revert done/error → idle after a
   *  short delay so the sidebar icon doesn't stick on the terminal icon). */
  armDoneLinger: (sessionId: string) => void;
  /** Clear the done-linger timer for a session. */
  clearDoneLinger: (sessionId: string) => void;
}

export interface RunStateEngine {
  applyEvent: (msg: WSMessage) => void;
  startRun: (sessionId: string) => void;
  markUserStopped: (sessionId: string) => void;
  markAgentStopped: (sessionId: string, agentId: string) => void;
  clearUserStopped: (sessionId: string) => void;
  resetSession: (sessionId: string) => void;
  clearAll: () => void;
  getPhase: (sessionId: string | null | undefined) => RunPhase;
  isRunning: (sessionId: string | null | undefined) => boolean;
  isWaiting: (sessionId: string | null | undefined) => boolean;
  isBusy: (sessionId: string | null | undefined) => boolean;
  getWaitingReason: (sessionId: string | null | undefined) => string;
  getButtonState: (sessionId: string | null | undefined, canSend: boolean) => ButtonState;
  deriveButtonState: (phase: RunPhase, canSend: boolean, waitingReason?: string) => ButtonState;
  /** Direct access to the states Map (for assertions in tests). */
  readonly states: Map<string, SessionRunState>;
}

/** Create a run-state engine that operates on the states Map returned by
 *  `getStates`. The caller owns the Map and the `commit` callback (which,
 *  in the reactive wrapper, publishes a new $state reference so Svelte
 *  tracks the change). The engine owns all the logic.
 *
 *  Using a getter instead of a direct Map reference ensures the engine
 *  always sees the latest Map — critical for the reactive wrapper, where
 *  `commit()` replaces the Map reference to trigger Svelte's change
 *  detection. */
export function createRunStateEngine(
  getStates: () => Map<string, SessionRunState>,
  commit: () => void,
  timers: RunStateTimers,
): RunStateEngine {
  function ensureState(sessionId: string): SessionRunState {
    const states = getStates();
    let s = states.get(sessionId);
    if (!s) {
      s = {
        phase: 'idle',
        waitingReason: '',
        stoppedByUser: false,
        lastActivityAt: Date.now(),
        activeAgents: new Set(),
      };
      states.set(sessionId, s);
      commit();
    }
    return s;
  }

  function setPhase(sessionId: string, phase: RunPhase, reason = ''): void {
    const s = ensureState(sessionId);
    if (s.phase === phase && s.waitingReason === reason) return;
    s.phase = phase;
    s.waitingReason = reason;
    s.lastActivityAt = Date.now();
    if (isActivePhase(phase)) {
      timers.armWatchdog(sessionId);
    } else {
      timers.clearWatchdog(sessionId);
    }
    // When the run completes (done/error), briefly show the terminal icon
    // (checkmark / alert) then auto-revert to idle so the sidebar icon
    // doesn't linger on "done" forever.
    timers.clearDoneLinger(sessionId);
    if (phase === 'done' || phase === 'error') {
      timers.armDoneLinger(sessionId);
    }
    commit();
  }

  function addActiveAgent(sessionId: string, agentId: string): void {
    const s = ensureState(sessionId);
    if (!s.activeAgents.has(agentId)) {
      s.activeAgents.add(agentId);
      commit();
    }
  }

  function removeActiveAgent(sessionId: string, agentId: string): void {
    const states = getStates();
    const s = states.get(sessionId);
    if (!s || !s.activeAgents.has(agentId)) return;
    s.activeAgents.delete(agentId);
    // If no agents are left active, the run is over. Route through setPhase
    // so the done-linger timer fires and the sidebar icon auto-reverts to
    // idle — direct mutation would bypass it.
    if (s.activeAgents.size === 0 && isActivePhase(s.phase)) {
      setPhase(sessionId, 'done');
      return; // setPhase already calls commit()
    }
    commit();
  }

  function applyEvent(msg: WSMessage): void {
    const sid = msg.sessionId;
    if (!sid) return;
    const states = getStates();
    const s = states.get(sid);

    // Suppression: after user stop, drop buffered non-terminal events.
    if (s?.stoppedByUser && SUPPRESSED_WHEN_STOPPED.has(msg.type)) return;

    // Terminal-phase guard: stale resurrecting events after done/error must
    // not resurrect the run. idle (after done-linger) can still be resurrected.
    if (s && isTerminalPhase(s.phase) && isResurrectingEvent(msg)) return;

    // Any event for an active session is evidence of life — reset the watchdog.
    if (s && isActivePhase(s.phase)) {
      s.lastActivityAt = Date.now();
      timers.armWatchdog(sid);
    }

    switch (msg.type) {
      case 'agent.heartbeat': {
        if (!s || s.stoppedByUser) return;
        // A heartbeat while done/error is stale — the terminal event was
        // already received. Drop it; do NOT resurrect. A heartbeat while
        // idle means the done-linger fired but the run is still alive.
        if (isTerminalPhase(s.phase)) return;
        const p = msg.payload as AgentHeartbeatPayload;
        addActiveAgent(sid, p.agentId);
        if (s.phase === 'idle') {
          setPhase(sid, 'streaming');
        }
        break;
      }

      case 'stream.delta':
      case 'stream.file_delta':
      case 'stream.file_complete': {
        if (!s || s.stoppedByUser) return;
        addActiveAgent(sid, (msg.payload as { agentId: string }).agentId);
        setPhase(sid, 'streaming');
        break;
      }

      case 'stream.thinking': {
        if (!s || s.stoppedByUser) return;
        addActiveAgent(sid, (msg.payload as { agentId: string }).agentId);
        setPhase(sid, 'thinking');
        break;
      }

      case 'stream.tool_call': {
        if (!s || s.stoppedByUser) return;
        addActiveAgent(sid, (msg.payload as { agentId: string }).agentId);
        setPhase(sid, 'tool_calling');
        break;
      }

      case 'stream.tool_result': {
        if (!s || s.stoppedByUser) return;
        // Tool returned — back to streaming (the agent is composing the next
        // chunk). Keep the agent active; just advance the phase.
        setPhase(sid, 'streaming');
        break;
      }

      case 'stream.clear_content':
      case 'stream.usage': {
        // No phase change, but the watchdog was already kicked above.
        break;
      }

      case 'stream.complete':
      case 'agent.completed': {
        const agentId = (msg.payload as { agentId: string }).agentId;
        removeActiveAgent(sid, agentId);
        break;
      }

      case 'agent.status': {
        const p = msg.payload as { agentId: string; status: AgentStatus };
        if (s?.stoppedByUser && isSuppressedStatus(p.status)) return;

        if (TERMINAL_AGENT_STATUSES.has(p.status)) {
          removeActiveAgent(sid, p.agentId);
        } else if (WAITING_AGENT_STATUSES.has(p.status)) {
          removeActiveAgent(sid, p.agentId);
          setPhase(
            sid,
            p.status === 'waiting_user' ? 'waiting_user' : 'waiting_terminal',
            p.status === 'waiting_user' ? 'your answer' : 'background terminal',
          );
        } else if (ACTIVE_AGENT_STATUSES.has(p.status)) {
          addActiveAgent(sid, p.agentId);
          if (p.status === 'thinking') setPhase(sid, 'thinking');
          else if (p.status === 'tool_calling') setPhase(sid, 'tool_calling');
          else if (p.status === 'streaming') setPhase(sid, 'streaming');
        }
        break;
      }

      case 'agent.error':
      case 'system.error': {
        // system.error is emitted by the manager when handleDirectly throws
        // (e.g. provider crash). Without this, the button stays on "Stop"
        // until the 15s watchdog fires — the exact "stuck streaming" bug.
        // A system error means the whole run failed, not just one agent —
        // clear all active agents and force the error phase.
        const p = msg.payload as { agentId?: string };
        if (p.agentId) removeActiveAgent(sid, p.agentId);
        const current = getStates().get(sid);
        if (msg.type === 'system.error') {
          // System errors are fatal — clear everything and transition.
          if (current) current.activeAgents.clear();
          setPhase(sid, 'error');
        } else if (!current || current.activeAgents.size === 0) {
          setPhase(sid, 'error');
        }
        break;
      }

      case 'kory.ask_user': {
        if (!s || s.stoppedByUser) return;
        setPhase(sid, 'waiting_user', 'your answer');
        break;
      }

      case 'compaction.started':
      case 'compaction.progress': {
        const p = msg.payload as { sessionId: string };
        addActiveAgent(sid, `compaction:${p.sessionId}`);
        setPhase(sid, 'streaming');
        break;
      }

      case 'compaction.completed':
      case 'compaction.failed': {
        const p = msg.payload as { sessionId: string };
        removeActiveAgent(sid, `compaction:${p.sessionId}`);
        break;
      }

      case 'system.info': {
        const info = msg.payload as { message?: string };
        if (info?.message === 'Session cancelled') {
          markUserStopped(sid);
        }
        break;
      }

      default:
        break;
    }
  }

  function startRun(sessionId: string): void {
    const s = ensureState(sessionId);
    s.stoppedByUser = false;
    s.activeAgents.add('kory-manager');
    s.phase = 'streaming';
    s.waitingReason = '';
    s.lastActivityAt = Date.now();
    timers.armWatchdog(sessionId);
    commit();
  }

  function markUserStopped(sessionId: string): void {
    timers.clearWatchdog(sessionId);
    const s = ensureState(sessionId);
    s.stoppedByUser = true;
    s.activeAgents.clear();
    s.phase = 'done';
    s.waitingReason = '';
    commit();
  }

  function markAgentStopped(sessionId: string, agentId: string): void {
    removeActiveAgent(sessionId, agentId);
  }

  function clearUserStopped(sessionId: string): void {
    const s = getStates().get(sessionId);
    if (s && s.stoppedByUser) {
      s.stoppedByUser = false;
      commit();
    }
  }

  function resetSession(sessionId: string): void {
    timers.clearWatchdog(sessionId);
    timers.clearDoneLinger(sessionId);
    getStates().delete(sessionId);
    commit();
  }

  function clearAll(): void {
    const states = getStates();
    for (const sid of [...states.keys()]) {
      timers.clearWatchdog(sid);
      timers.clearDoneLinger(sid);
    }
    states.clear();
    commit();
  }

  function getPhase(sessionId: string | null | undefined): RunPhase {
    if (!sessionId) return 'idle';
    return getStates().get(sessionId)?.phase ?? 'idle';
  }

  function isRunning(sessionId: string | null | undefined): boolean {
    return isActivePhase(getPhase(sessionId));
  }

  function isWaiting(sessionId: string | null | undefined): boolean {
    return isWaitingPhase(getPhase(sessionId));
  }

  function isBusy(sessionId: string | null | undefined): boolean {
    if (!sessionId) return false;
    const phase = getPhase(sessionId);
    return isActivePhase(phase) || isWaitingPhase(phase);
  }

  function getWaitingReason(sessionId: string | null | undefined): string {
    if (!sessionId) return '';
    return getStates().get(sessionId)?.waitingReason ?? '';
  }

  function getButtonState(
    sessionId: string | null | undefined,
    canSend: boolean,
  ): ButtonState {
    const phase = getPhase(sessionId);
    const reason = getWaitingReason(sessionId);
    return deriveButtonState(phase, canSend, reason);
  }

  return {
    applyEvent,
    startRun,
    markUserStopped,
    markAgentStopped,
    clearUserStopped,
    resetSession,
    clearAll,
    getPhase,
    isRunning,
    isWaiting,
    isBusy,
    getWaitingReason,
    getButtonState,
    deriveButtonState,
    get states() {
      return getStates();
    },
  };
}
