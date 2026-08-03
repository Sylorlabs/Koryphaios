import { db, sessions } from '../../db';
import { eq } from 'drizzle-orm';
import type { SessionRuntimeState } from '@koryphaios/shared';
import { koryLog } from '../../logger';

/**
 * Per-session runtime state machine. This is the single source of truth for
 * what a session is doing right now, replacing the scattered in-memory Sets
 * and Maps (compactingSessions, compactionCompleted, isProcessing).
 *
 * States:
 *   idle       — No active work
 *   processing — Manager/worker actively running a turn
 *   compacting — History compaction in progress
 *   waiting    — Waiting for user input or a background process
 *   error      — Error state, needs recovery
 *   paused     — Paused by spend cap or user
 *
 * Valid transitions:
 *   idle       → processing | compacting
 *   processing → idle | waiting | error | compacting
 *   compacting → idle | error
 *   waiting    → processing | idle
 *   error      → idle | processing
 *   paused     → idle | processing
 */

const VALID_TRANSITIONS: Record<SessionRuntimeState, SessionRuntimeState[]> = {
  idle: ['processing', 'compacting'],
  processing: ['idle', 'waiting', 'error', 'compacting'],
  compacting: ['idle', 'error'],
  waiting: ['processing', 'idle'],
  error: ['idle', 'processing'],
  paused: ['idle', 'processing'],
};

export class SessionRuntimeStateService {
  /** In-memory cache of the current state per session. Avoids a DB round-trip
   *  on every isProcessing/isCompacting check (hot path during streaming). */
  private stateCache = new Map<string, SessionRuntimeState>();

  /** Get the current runtime state for a session. Falls back to 'idle' if the
   *  session doesn't exist or hasn't been initialized. */
  getState(sessionId: string): SessionRuntimeState {
    const cached = this.stateCache.get(sessionId);
    if (cached) return cached;
    return 'idle';
  }

  /** Synchronously check if the session is actively processing a turn. */
  isProcessing(sessionId: string): boolean {
    const state = this.getState(sessionId);
    return state === 'processing' || state === 'compacting';
  }

  /** Synchronously check if the session is compacting. */
  isCompacting(sessionId: string): boolean {
    return this.getState(sessionId) === 'compacting';
  }

  /** Synchronously check if the session is running (processing, compacting,
   *  or waiting on a background process). */
  isRunning(sessionId: string): boolean {
    const state = this.getState(sessionId);
    return state === 'processing' || state === 'compacting' || state === 'waiting';
  }

  /** Transition a session to a new state. Validates the transition and
   *  persists to the DB. Logs a warning on invalid transitions but does not
   *  throw — the caller's flow continues regardless. */
  async transition(
    sessionId: string,
    newState: SessionRuntimeState,
  ): Promise<void> {
    const current = this.getState(sessionId);
    if (current === newState) return;

    const allowed = VALID_TRANSITIONS[current];
    if (!allowed.includes(newState)) {
      koryLog.warn(
        { sessionId, current, newState },
        'Invalid session state transition — allowing anyway',
      );
    }

    this.stateCache.set(sessionId, newState);
    try {
      await db
        .update(sessions)
        .set({ workflowState: newState, updatedAt: new Date() })
        .where(eq(sessions.id, sessionId));
    } catch (err) {
      koryLog.warn({ err, sessionId, newState }, 'Failed to persist session state');
    }
  }

  /** Force-set the state without transition validation. Used for recovery
   *  (e.g., resetting a stuck session to idle on startup). */
  async forceState(sessionId: string, newState: SessionRuntimeState): Promise<void> {
    this.stateCache.set(sessionId, newState);
    try {
      await db
        .update(sessions)
        .set({ workflowState: newState, updatedAt: new Date() })
        .where(eq(sessions.id, sessionId));
    } catch (err) {
      koryLog.warn({ err, sessionId, newState }, 'Failed to force session state');
    }
  }

  /** Clear the in-memory cache for a session. Called on cleanup. */
  clear(sessionId: string): void {
    this.stateCache.delete(sessionId);
  }
}

/** Singleton instance shared across the manager and route handlers. */
let instance: SessionRuntimeStateService | undefined;

export function getSessionRuntimeStateService(): SessionRuntimeStateService {
  if (!instance) instance = new SessionRuntimeStateService();
  return instance;
}
