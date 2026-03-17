// SessionStateService - Handles session state management and persistence
// Extracted from KoryManager to separate concerns

import { getDb } from "../../db/sqlite";
import type { ISessionStore, IMessageStore } from "../../stores";
import type { ChangeSummary } from "@koryphaios/shared";
import { SnapshotManager } from "../snapshot-manager";
import { GitManager } from "../git-manager";
import { koryLog } from "../../logger";

export interface SessionContext {
  sessionId: string;
  workingDirectory: string;
}

export interface SessionActivity {
  lastActivity: number;
  lastChangeRecorded: number;
}

export class SessionStateService {
  private sessionChanges = new Map<string, ChangeSummary[]>();
  private lastKnownGoodHash = new Map<string, string>();
  private snapshotManager: SnapshotManager;
  private memoryDir: string;
  
  // Activity tracking with comprehensive cleanup
  private activity = new Map<string, SessionActivity>();
  private readonly SESSION_INACTIVE_MS = 30 * 60 * 1000; // 30 minutes
  private cleanupInterval: Timer | null = null;
  private readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    private workingDirectory: string,
    private sessions?: ISessionStore,
    private messages?: IMessageStore
  ) {
    this.memoryDir = `${workingDirectory}/.koryphaios/memory`;
    this.snapshotManager = new SnapshotManager(workingDirectory);
    this.startCleanupInterval();
  }

  /**
   * Update workflow state in database
   */
  updateWorkflowState(sessionId: string, state: string): void {
    this.touchActivity(sessionId);
    try {
      getDb().run("UPDATE sessions SET workflow_state = ? WHERE id = ?", [state, sessionId]);
    } catch (err) {
      koryLog.debug({ error: err instanceof Error ? err.message : String(err), sessionId, state }, "Failed to update workflow state");
    }
  }

  /**
   * Record a change for a session
   */
  recordChange(sessionId: string, change: ChangeSummary): void {
    const arr = this.sessionChanges.get(sessionId) || [];
    arr.push(change);
    this.sessionChanges.set(sessionId, arr);
    this.touchActivity(sessionId);
    this.activity.get(sessionId)!.lastChangeRecorded = Date.now();
  }

  /**
   * Get recorded changes for a session
   * FIX: Now updates activity timestamp since this is an active operation
   */
  getChanges(sessionId: string): ChangeSummary[] {
    this.touchActivity(sessionId);
    return this.sessionChanges.get(sessionId) || [];
  }

  /**
   * Clear changes for a session
   */
  clearChanges(sessionId: string): void {
    this.sessionChanges.delete(sessionId);
    this.touchActivity(sessionId);
  }

  /**
   * Save checkpoint hash for rollback
   */
  saveCheckpoint(sessionId: string, hash: string): void {
    this.lastKnownGoodHash.set(sessionId, hash);
    this.touchActivity(sessionId);
  }

  /**
   * Get checkpoint hash for rollback
   * FIX: Now updates activity timestamp
   */
  getCheckpoint(sessionId: string): string | undefined {
    this.touchActivity(sessionId);
    return this.lastKnownGoodHash.get(sessionId);
  }

  /**
   * Clear checkpoint after use
   */
  clearCheckpoint(sessionId: string): void {
    this.lastKnownGoodHash.delete(sessionId);
  }

  /**
   * Create snapshot for non-git rollback
   */
  async createSnapshot(sessionId: string, paths: string[]): Promise<boolean> {
    this.touchActivity(sessionId);
    try {
      await this.snapshotManager.createSnapshot(sessionId, "latest", paths, this.workingDirectory);
      return true;
    } catch (err) {
      koryLog.error({ error: err instanceof Error ? err.message : String(err), sessionId }, "Failed to create snapshot");
      return false;
    }
  }

  /**
   * Restore from snapshot
   */
  async restoreSnapshot(sessionId: string): Promise<boolean> {
    this.touchActivity(sessionId);
    try {
      await this.snapshotManager.restoreSnapshot(sessionId, "latest", this.workingDirectory);
      return true;
    } catch (err) {
      koryLog.error({ error: err instanceof Error ? err.message : String(err), sessionId }, "Failed to restore snapshot");
      return false;
    }
  }

  /**
   * Persist message to store
   */
  async persistMessage(
    sessionId: string,
    role: "user" | "assistant" | "system",
    content: string,
    model?: string,
    provider?: string
  ): Promise<void> {
    this.touchActivity(sessionId);
    if (!this.messages) return;
    
    try {
      const { nanoid } = await import("nanoid");
      this.messages.add(sessionId, {
        id: nanoid(12),
        sessionId,
        role,
        content,
        model,
        provider,
        createdAt: Date.now(),
      });
    } catch (err) {
      koryLog.error({ error: err instanceof Error ? err.message : String(err), sessionId }, "Failed to persist message");
    }
  }

  /**
   * Cleanup session state
   */
  cleanupSession(sessionId: string): void {
    this.sessionChanges.delete(sessionId);
    this.lastKnownGoodHash.delete(sessionId);
    this.activity.delete(sessionId);
  }

  /**
   * Clean up inactive sessions to prevent memory leaks.
   * FIX: Properly deduplicates cleanup and handles edge cases.
   */
  cleanupInactiveSessions(): void {
    const now = Date.now();
    const toRemove = new Set<string>();
    
    // Find sessions that haven't had activity
    for (const [sessionId, activity] of this.activity) {
      if (now - activity.lastActivity > this.SESSION_INACTIVE_MS) {
        toRemove.add(sessionId);
      }
    }
    
    // Also find orphaned entries (in changes or checkpoints but not in activity)
    for (const sessionId of this.sessionChanges.keys()) {
      if (!this.activity.has(sessionId)) {
        toRemove.add(sessionId);
      }
    }
    
    for (const sessionId of this.lastKnownGoodHash.keys()) {
      if (!this.activity.has(sessionId)) {
        toRemove.add(sessionId);
      }
    }
    
    // Clean up all identified sessions
    for (const sessionId of toRemove) {
      koryLog.debug({ sessionId }, "Cleaning up inactive session state");
      this.cleanupSession(sessionId);
    }
    
    if (toRemove.size > 0) {
      koryLog.info({ count: toRemove.size }, "Cleaned up inactive sessions");
    }
  }

  /**
   * Get approximate memory usage of session state
   */
  getMemoryStats(): { 
    sessionCount: number; 
    changesCount: number; 
    checkpointCount: number;
    trackedActivity: number;
  } {
    return {
      sessionCount: this.activity.size,
      changesCount: Array.from(this.sessionChanges.values()).reduce((sum, arr) => sum + arr.length, 0),
      checkpointCount: this.lastKnownGoodHash.size,
      trackedActivity: this.activity.size,
    };
  }

  /**
   * Stop cleanup interval (for graceful shutdown)
   */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      koryLog.debug("SessionStateService cleanup stopped");
    }
  }

  // ─── Private Methods ─────────────────────────────────────────────────────────

  /**
   * Update activity timestamp for a session
   */
  private touchActivity(sessionId: string): void {
    const existing = this.activity.get(sessionId);
    if (existing) {
      existing.lastActivity = Date.now();
    } else {
      this.activity.set(sessionId, {
        lastActivity: Date.now(),
        lastChangeRecorded: 0,
      });
    }
  }

  /**
   * Start automatic cleanup interval
   * FIX: Properly wired up to run periodically
   */
  private startCleanupInterval(): void {
    if (this.cleanupInterval) return;
    
    this.cleanupInterval = setInterval(() => {
      try {
        this.cleanupInactiveSessions();
        
        const stats = this.getMemoryStats();
        if (stats.changesCount > 1000) {
          koryLog.warn({ stats }, "High memory usage: many session changes stored");
        }
      } catch (err) {
        koryLog.error({ error: err instanceof Error ? err.message : String(err) }, "SessionStateService cleanup error");
      }
    }, this.CLEANUP_INTERVAL_MS);
    
    // Don't let cleanup timer keep process alive
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
    
    koryLog.debug({ intervalMs: this.CLEANUP_INTERVAL_MS }, "SessionStateService cleanup started");
  }
}
