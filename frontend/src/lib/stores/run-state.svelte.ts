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
//
// ─── Architecture ───────────────────────────────────────────────────────────
// The pure state machine lives in run-state-core.ts (createRunStateEngine),
// which is unit-tested without the Svelte 5 rune compiler. This file is the
// thin reactive wrapper: it owns the $state<Map>, the real setTimeout-based
// watchdog and done-linger timers, and the store facade. ALL logic — the
// reducer, phase transitions, suppression, terminal-phase guard — is in the
// core. There is no duplicate logic here.

import type { WSMessage, AgentStatus } from '@koryphaios/shared';
import {
  createRunStateEngine,
  type RunPhase,
  type ButtonState,
  type SessionRunState,
  type RunStateTimers,
} from './run-state-core';

export type { RunPhase, ButtonState };

// ─── Watchdog ───────────────────────────────────────────────────────────────
//
// If a session is active but goes SILENT (no events) for this long, a
// terminal event was dropped — force the phase to done so the button
// doesn't lie. ANY event for the session resets the timer, including
// agent.heartbeat (emitted every 5s by the backend while a run is alive).
//
// 15s = 3 missed heartbeats. The old 45s watchdog was a confession that
// terminal events get dropped; with the heartbeat, 15s is enough to declare
// a run dead without lying to the user for 3/4 of a minute.
//
// SUSPENSION: while any agent for the session is in tool_calling, the
// watchdog is suspended — a long bash command may emit no stream events for
// minutes, and the heartbeat proves the backend is still alive. The watchdog
// resumes when the tool returns (stream.tool_result) or the phase changes.
const BUSY_WATCHDOG_MS = 15_000;
const DONE_LINGER_MS = 1500;

const watchdogs = new Map<string, ReturnType<typeof setTimeout>>();
const doneTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ─── Reactive state ─────────────────────────────────────────────────────────

let states = $state<Map<string, SessionRunState>>(new Map());

function commit(): void {
  states = new Map(states);
}

// ─── Real timer wiring ──────────────────────────────────────────────────────

const timers: RunStateTimers = {
  armWatchdog(sessionId: string): void {
    const existing = watchdogs.get(sessionId);
    if (existing) clearTimeout(existing);
    const s = states.get(sessionId);
    if (!s) return;
    // Suspend the watchdog during tool_calling — a long bash command may emit
    // no stream events for minutes. The backend heartbeat (every 5s) still
    // resets the watchdog via applyEvent, but we don't arm a new timeout while
    // in tool_calling. The watchdog resumes when the phase changes away from
    // tool_calling (stream.tool_result → streaming, or a terminal event).
    if (s.phase === 'tool_calling') return;
    watchdogs.set(
      sessionId,
      setTimeout(() => {
        watchdogs.delete(sessionId);
        // Silent too long — the run ended without a terminal event reaching us.
        const current = states.get(sessionId);
        if (!current) return;
        if (current.phase !== 'thinking' && current.phase !== 'streaming') return;
        current.phase = 'done';
        current.activeAgents.clear();
        commit();
      }, BUSY_WATCHDOG_MS),
    );
  },
  clearWatchdog(sessionId: string): void {
    const t = watchdogs.get(sessionId);
    if (t) {
      clearTimeout(t);
      watchdogs.delete(sessionId);
    }
  },
  armDoneLinger(sessionId: string): void {
    const existing = doneTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    doneTimers.set(
      sessionId,
      setTimeout(() => {
        doneTimers.delete(sessionId);
        const cur = states.get(sessionId);
        if (cur && (cur.phase === 'done' || cur.phase === 'error')) {
          cur.phase = 'idle';
          cur.waitingReason = '';
          commit();
        }
      }, DONE_LINGER_MS),
    );
  },
  clearDoneLinger(sessionId: string): void {
    const t = doneTimers.get(sessionId);
    if (t) {
      clearTimeout(t);
      doneTimers.delete(sessionId);
    }
  },
};

// ─── Engine ─────────────────────────────────────────────────────────────────

const engine = createRunStateEngine(() => states, commit, timers);

// Re-export the imperative actions and reads for direct callers.
// The store facade below also delegates to these.
export const applyEvent = engine.applyEvent;
export const startRun = engine.startRun;
export const markUserStopped = engine.markUserStopped;
export const markAgentStopped = engine.markAgentStopped;
export const clearUserStopped = engine.clearUserStopped;
export const resetSession = engine.resetSession;
export const clearAll = engine.clearAll;
export const getPhase = engine.getPhase;
export const isRunning = engine.isRunning;
export const isWaiting = engine.isWaiting;
export const isBusy = engine.isBusy;
export const getWaitingReason = engine.getWaitingReason;
export const getButtonState = engine.getButtonState;
export const deriveButtonState = engine.deriveButtonState;

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
