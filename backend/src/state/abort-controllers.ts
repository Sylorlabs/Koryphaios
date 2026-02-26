/**
 * Abort Controllers Registry
 * Tracks abort signals for operations with persistence.
 */

import { initDb } from "../db/sqlite";

export interface AbortControllerEntry {
  id: string;
  sessionId: string;
  reason?: string;
  createdAt: number;
}

export class AbortControllersRegistry {
  private controllers = new Map<string, AbortController>();
  private entries = new Map<string, AbortControllerEntry>();
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      const db = await initDb();
      
      // Clear any stale entries from previous runs
      db.query("DELETE FROM abort_controllers WHERE created_at < ?").run(
        Date.now() - 24 * 60 * 60 * 1000, // 24 hours old
      );

      this.initialized = true;
    } catch (error) {
      console.error("Failed to initialize abort controllers registry:", error);
      this.initialized = true;
    }
  }

  create(sessionId: string, reason?: string): { id: string; controller: AbortController } {
    const id = `abort-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const controller = new AbortController();

    this.controllers.set(id, controller);
    this.entries.set(id, {
      id,
      sessionId,
      reason,
      createdAt: Date.now(),
    });

    this.persistEntry(id).catch(console.error);

    return { id, controller };
  }

  get(id: string): AbortController | undefined {
    return this.controllers.get(id);
  }

  getEntry(id: string): AbortControllerEntry | undefined {
    return this.entries.get(id);
  }

  abort(id: string): boolean {
    const controller = this.controllers.get(id);
    if (controller) {
      controller.abort();
      this.remove(id);
      return true;
    }
    return false;
  }

  abortBySession(sessionId: string, reason?: string): number {
    let count = 0;
    for (const [id, entry] of this.entries.entries()) {
      if (entry.sessionId === sessionId) {
        this.abort(id);
        count++;
      }
    }
    return count;
  }

  remove(id: string): void {
    this.controllers.delete(id);
    this.entries.delete(id);
    this.removePersistedEntry(id).catch(console.error);
  }

  getBySession(sessionId: string): AbortControllerEntry[] {
    return Array.from(this.entries.values()).filter(e => e.sessionId === sessionId);
  }

  async persistEntry(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;

    try {
      const db = await initDb();
      db.query(`
        INSERT OR REPLACE INTO abort_controllers 
        (id, session_id, reason, created_at)
        VALUES (?, ?, ?, ?)
      `).run(
        entry.id,
        entry.sessionId,
        entry.reason ?? null,
        entry.createdAt,
      );
    } catch (error) {
      console.error("Failed to persist abort controller:", error);
    }
  }

  async removePersistedEntry(id: string): Promise<void> {
    try {
      const db = await initDb();
      db.query("DELETE FROM abort_controllers WHERE id = ?").run(id);
    } catch (error) {
      console.error("Failed to remove persisted abort controller:", error);
    }
  }

  clear(): void {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
    this.entries.clear();
  }

  cleanupStale(maxAge = 30 * 60 * 1000): void {
    const now = Date.now();
    for (const [id, entry] of this.entries.entries()) {
      if (now - entry.createdAt > maxAge) {
        this.abort(id);
      }
    }
  }
}

export const abortControllers = new AbortControllersRegistry();
