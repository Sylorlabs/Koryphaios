// Run-state store — the single source of truth for "is this session running?"
//
// One `$state<Map<sessionId, SessionRunState>>`, written by one reducer
// (`applyEvent`), read by the composer button and every busy indicator.
//
// This replaces the old five-signal mess:
//   busySessions Set + userStoppedSessions Set + managerStatusBySession Map
//   + shared kory-manager.status + agentStore.isSessionRunning()
// Each of those was updated on a different code path and they routinely
// disagreed — the button flipped between Stop and Send as one signal cleared
// and another didn't. Now there is one store, one writer, one read.
//
// The agentStore keeps content/thinking/usage accumulation (per-agent text),
// but it is no longer consulted for run-phase decisions.

import type { WSMessage } from '@koryphaios/shared';
import type { AgentStatus } from '@koryphaios/shared';

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

interface SessionRunState {
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

/** Phases that count as "alive" — the button shows Stop. */
function isActivePhase(phase: RunPhase): boolean {
  return (
    phase === 'thinking' ||
    phase === 'streaming' ||
    phase === 'tool_calling'
  );
}

/** Phases that mean the session is parked, not running. */
function isWaitingPhase(phase: RunPhase): boolean {
  return phase === 'waiting_terminal' || phase === 'waiting_user';
}

/** Agent statuses that count as "active" (the run is alive). */
const ACTIVE_AGENT_STATUSES = new Set<AgentStatus>([
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
const WAITING_AGENT_STATUSES = new Set<AgentStatus>(['waiting', 'waiting_user']);

/** Agent statuses that are terminal. */
const TERMINAL_AGENT_STATUSES = new Set<AgentStatus>(['done', 'idle', 'error']);

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

// ─── Watchdog ───────────────────────────────────────────────────────────────
//
// If a session is active but goes SILENT (no events) for this long, a
// terminal event was dropped — force the phase to done so the button
// doesn't lie. ANY event for the session resets the timer, including
// agent.status changes (the old watchdog only reset on stream.*, which
// meant a long tool_calling phase with no stream events would trip it
// mid-execution).
//
// 45s for now; Stage 4 adds a backend heartbeat and drops this to 15s.
const BUSY_WATCHDOG_MS = 45_000;
const watchdogs = new Map<string, ReturnType<typeof setTimeout>>();

function kickWatchdog(sessionId: string, state: SessionRunState): void {
  const existing = watchdogs.get(sessionId);
  if (existing) clearTimeout(existing);
  if (!isActivePhase(state.phase)) return;
  watchdogs.set(
    sessionId,
    setTimeout(() => {
      watchdogs.delete(sessionId);
      // Silent too long — the run ended without a terminal event reaching us.
      const current = states.get(sessionId);
      if (!current || !isActivePhase(current.phase)) return;
      current.phase = 'done';
      current.activeAgents.clear();
      commit();
    }, BUSY_WATCHDOG_MS),
  );
}

function stopWatchdog(sessionId: string): void {
  const t = watchdogs.get(sessionId);
  if (t) {
    clearTimeout(t);
    watchdogs.delete(sessionId);
  }
}

// ─── State ──────────────────────────────────────────────────────────────────

let states = $state<Map<string, SessionRunState>>(new Map());

function commit(): void {
  states = new Map(states);
}

function ensureState(sessionId: string): SessionRunState {
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
  if (isActivePhase(phase)) kickWatchdog(sessionId, s);
  else stopWatchdog(sessionId);
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
  const s = states.get(sessionId);
  if (!s || !s.activeAgents.has(agentId)) return;
  s.activeAgents.delete(agentId);
  // If no agents are left active, the run is over.
  if (s.activeAgents.size === 0 && isActivePhase(s.phase)) {
    s.phase = 'done';
    s.waitingReason = '';
    stopWatchdog(sessionId);
  }
  commit();
}

// ─── Reducer ────────────────────────────────────────────────────────────────
//
// applyEvent is the ONLY function that mutates run-phase state. Every WS
// handler delegates here. This is what makes the state machine coherent:
// one place to reason about transitions, one place to audit.

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

export function applyEvent(msg: WSMessage): void {
  const sid = msg.sessionId;
  if (!sid) return;
  const s = states.get(sid);

  // Suppression: after user stop, drop buffered non-terminal events.
  if (s?.stoppedByUser && SUPPRESSED_WHEN_STOPPED.has(msg.type)) return;

  // Any event for an active session is evidence of life — reset the watchdog.
  if (s && isActivePhase(s.phase)) {
    s.lastActivityAt = Date.now();
    kickWatchdog(sid, s);
  }

  switch (msg.type) {
    // ── User sends a message → run starts ──
    // (Handled by startRun(), not an event — but stream.delta etc. below
    //  will keep it alive.)

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
      // If activeAgents is now empty, removeActiveAgent already set phase=done.
      // If others are still running, stay in the current active phase.
      break;
    }

    case 'agent.status': {
      const p = msg.payload as { agentId: string; status: AgentStatus };
      if (s?.stoppedByUser && isSuppressedStatus(p.status)) return;

      if (TERMINAL_AGENT_STATUSES.has(p.status)) {
        removeActiveAgent(sid, p.agentId);
        // If that was the last agent, phase is already done/idle.
        // If others remain, don't change phase.
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
        // Other active sub-statuses (reading, writing, etc.) keep the
        // current phase — the button only cares that *something* is running.
      }
      break;
    }

    case 'agent.error': {
      const p = msg.payload as { agentId?: string };
      if (p.agentId) removeActiveAgent(sid, p.agentId);
      const current = states.get(sid);
      if (!current || current.activeAgents.size === 0) {
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
      // "Session cancelled" confirmation from the backend.
      const info = msg.payload as { message?: string };
      if (info?.message === 'Session cancelled') {
        markUserStopped(sid);
      }
      break;
    }

    default:
      // Unhandled event types don't affect run phase.
      break;
  }
}

// ─── Imperative actions (called by the websocket store / UI) ────────────────

/** User sent a message — start a new run optimistically. */
export function startRun(sessionId: string): void {
  const s = ensureState(sessionId);
  s.stoppedByUser = false;
  s.activeAgents.add('kory-manager');
  s.phase = 'streaming';
  s.waitingReason = '';
  s.lastActivityAt = Date.now();
  kickWatchdog(sessionId, s);
  commit();
}

/** User clicked Stop — optimistic: mark done, suppress late events. */
export function markUserStopped(sessionId: string): void {
  stopWatchdog(sessionId);
  const s = ensureState(sessionId);
  s.stoppedByUser = true;
  s.activeAgents.clear();
  s.phase = 'done';
  s.waitingReason = '';
  commit();
}

/** Cancel a single agent (agent-rail selected worker). */
export function markAgentStopped(sessionId: string, agentId: string): void {
  removeActiveAgent(sessionId, agentId);
}

/** Clear the user-stop suppression so real events can correct the state
 *  (used when a cancel API call fails and we need to reconcile). */
export function clearUserStopped(sessionId: string): void {
  const s = states.get(sessionId);
  if (s && s.stoppedByUser) {
    s.stoppedByUser = false;
    commit();
  }
}

/** Reset a session to idle (e.g. on session switch / reload). */
export function resetSession(sessionId: string): void {
  stopWatchdog(sessionId);
  const next = new Map(states);
  next.delete(sessionId);
  states = next;
}

/** Clear all sessions (e.g. on disconnect). */
export function clearAll(): void {
  for (const sid of watchdogs.keys()) stopWatchdog(sid);
  states = new Map();
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export function getPhase(sessionId: string | null | undefined): RunPhase {
  if (!sessionId) return 'idle';
  return states.get(sessionId)?.phase ?? 'idle';
}

export function isRunning(sessionId: string | null | undefined): boolean {
  return isActivePhase(getPhase(sessionId));
}

export function isWaiting(sessionId: string | null | undefined): boolean {
  return isWaitingPhase(getPhase(sessionId));
}

export function isBusy(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  const phase = getPhase(sessionId);
  return isActivePhase(phase) || isWaitingPhase(phase);
}

export function getWaitingReason(sessionId: string | null | undefined): string {
  if (!sessionId) return '';
  return states.get(sessionId)?.waitingReason ?? '';
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

export function getButtonState(
  sessionId: string | null | undefined,
  canSend: boolean,
): ButtonState {
  const phase = getPhase(sessionId);
  const reason = getWaitingReason(sessionId);
  return deriveButtonState(phase, canSend, reason);
}

// ─── Store facade ───────────────────────────────────────────────────────────

export const runStateStore = {
  // Writes
  applyEvent,
  startRun,
  markUserStopped,
  markAgentStopped,
  clearUserStopped,
  resetSession,
  clearAll,

  // Reads
  getPhase,
  isRunning,
  isWaiting,
  isBusy,
  getWaitingReason,
  getButtonState,
  deriveButtonState,
  phaseToAgentStatus,
  /** AgentStatus for a session — for AnimatedStatusIcon / sidebar indicators
   *  that still expect the old status vocabulary. */
  getAgentStatusForSession(sessionId: string | null | undefined): AgentStatus {
    return phaseToAgentStatus(getPhase(sessionId));
  },

  // Introspection (for tests / debugging)
  get states() {
    return states;
  },
};
