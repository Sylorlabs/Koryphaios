/**
 * SessionStateService
 *
 * Manages per-session state: pending user inputs, change tracking, git checkpoints,
 * abort controllers, and snapshots.
 * Extracted from KoryManager to reduce its line count.
 */

import type { ChangeSummary } from '@koryphaios/shared';
import { serverLog } from '../../logger';

/** Lightweight record of a tool call during a turn (previews only). */
export interface ToolCallRecord {
  name: string;
  inputPreview?: string;
  resultPreview?: string;
  durationMs?: number;
  isError?: boolean;
}

/** Lightweight record of a shell command during a turn. */
export interface CommandRecord {
  command: string;
  exitCode?: number | null;
  durationMs?: number;
}

export interface SessionState {
  abortController: AbortController;
  /** Last manager-owned activity used only for bounded idle cleanup. */
  lastActivityAt: number;
  pendingInputResolver?: (selection: string) => void;
  changes: ChangeSummary[];
  lastKnownGoodHash?: string;
  /** Tool calls recorded during the current turn. Cleared at turn end. */
  toolCalls: ToolCallRecord[];
  /** Shell commands recorded during the current turn. Cleared at turn end. */
  commands: CommandRecord[];
}

export interface SessionStateServiceConfig {
  // No external dependencies needed
}

/**
 * Manages per-session state.
 */
export class SessionStateService {
  private sessions = new Map<string, SessionState>();

  // ─── Session Management ──────────────────────────────────────────────────────

  ensureSession(sessionId: string): SessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        abortController: new AbortController(),
        lastActivityAt: Date.now(),
        changes: [],
        toolCalls: [],
        commands: [],
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  touchSession(sessionId: string, now = Date.now()): void {
    this.ensureSession(sessionId).lastActivityAt = now;
  }

  getLastActivityAt(sessionId: string): number | null {
    return this.sessions.get(sessionId)?.lastActivityAt ?? null;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  removeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.abortController.abort();
      return this.sessions.delete(sessionId);
    }
    return false;
  }

  getSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  // ─── Abort Control ───────────────────────────────────────────────────────────

  getAbortController(sessionId: string): AbortController {
    return this.ensureSession(sessionId).abortController;
  }

  isAborted(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.abortController.signal.aborted ?? false;
  }

  abort(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session && !session.abortController.signal.aborted) {
      session.abortController.abort();
      return true;
    }
    return false;
  }

  resetAbortController(sessionId: string): AbortController {
    const session = this.ensureSession(sessionId);
    session.abortController = new AbortController();
    return session.abortController;
  }

  // ─── User Input ──────────────────────────────────────────────────────────────

  private pendingInputTimers = new Map<string, ReturnType<typeof setTimeout>>();

  requestUserInput(sessionId: string, timeoutMs = 300_000): Promise<string> {
    const session = this.ensureSession(sessionId);

    // Cancel any existing pending input and its timer
    if (session.pendingInputResolver) {
      session.pendingInputResolver('__cancelled__');
    }
    const existingTimer = this.pendingInputTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.pendingInputTimers.delete(sessionId);
    }

    return new Promise<string>((resolve) => {
      let settled = false;

      const settle = (selection: string) => {
        if (settled) return;
        settled = true;
        session.pendingInputResolver = undefined;
        const timer = this.pendingInputTimers.get(sessionId);
        if (timer) {
          clearTimeout(timer);
          this.pendingInputTimers.delete(sessionId);
        }
        resolve(selection);
      };

      session.pendingInputResolver = settle;

      // Auto-resolve after timeout to prevent indefinite hangs
      if (timeoutMs > 0) {
        const timer = setTimeout(() => {
          settle('__timeout__');
        }, timeoutMs);
        this.pendingInputTimers.set(sessionId, timer);
      }
    });
  }

  resolveUserInput(sessionId: string, selection: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session?.pendingInputResolver) {
      session.pendingInputResolver(selection);
      return true;
    }
    return false;
  }

  hasPendingInput(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session?.pendingInputResolver;
  }

  // ─── Change Tracking ─────────────────────────────────────────────────────────

  recordChange(sessionId: string, change: ChangeSummary): void {
    this.ensureSession(sessionId).changes.push(change);
  }

  getChanges(sessionId: string): ChangeSummary[] {
    return [...(this.sessions.get(sessionId)?.changes ?? [])];
  }

  clearChanges(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.changes = [];
    }
  }

  // ─── Tool Call / Command Tracking ──────────────────────────────────────────

  recordToolCall(sessionId: string, record: ToolCallRecord): void {
    this.ensureSession(sessionId).toolCalls.push(record);
  }

  getToolCalls(sessionId: string): ToolCallRecord[] {
    return [...(this.sessions.get(sessionId)?.toolCalls ?? [])];
  }

  recordCommand(sessionId: string, record: CommandRecord): void {
    this.ensureSession(sessionId).commands.push(record);
  }

  getCommands(sessionId: string): CommandRecord[] {
    return [...(this.sessions.get(sessionId)?.commands ?? [])];
  }

  /** Clear turn-scoped instrumentation (tool calls + commands). Called at turn end. */
  clearTurnInstrumentation(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.toolCalls = [];
      session.commands = [];
    }
  }

  getChangeCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.changes.length ?? 0;
  }

  // ─── Git Checkpoints ─────────────────────────────────────────────────────────

  saveCheckpoint(sessionId: string, hash: string): void {
    this.ensureSession(sessionId).lastKnownGoodHash = hash;
  }

  getCheckpoint(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.lastKnownGoodHash;
  }

  clearCheckpoint(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastKnownGoodHash = undefined;
    }
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────────────

  cleanupSession(sessionId: string): void {
    // Clear any pending input timer
    const timer = this.pendingInputTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.pendingInputTimers.delete(sessionId);
    }
    const session = this.sessions.get(sessionId);
    if (session) {
      if (!session.abortController.signal.aborted) {
        session.abortController.abort();
      }
      this.sessions.delete(sessionId);
    }
  }

  cleanupAll(): void {
    // Clear all pending input timers
    for (const timer of this.pendingInputTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingInputTimers.clear();
    for (const session of this.sessions.values()) {
      try {
        if (!session.abortController.signal.aborted) {
          session.abortController.abort();
        }
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Ignoring abort errors during cleanup',
        );
      }
    }
    this.sessions.clear();
  }

  getMemoryStats(): { sessions: number; totalChanges: number } {
    let totalChanges = 0;
    for (const session of this.sessions.values()) {
      totalChanges += session.changes.length;
    }
    return {
      sessions: this.sessions.size,
      totalChanges,
    };
  }
}
