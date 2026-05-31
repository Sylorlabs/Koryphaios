/**
 * Abort Controllers Registry
 * Tracks abort signals for operations with persistence.
 */

import { db, abortControllers as abortControllersTable } from '../db';
import { serverLog } from '../logger';
import { eq, lt } from 'drizzle-orm';

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
      // Clear any stale entries from previous runs
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await db.delete(abortControllersTable).where(lt(abortControllersTable.createdAt, cutoff));

      this.initialized = true;
    } catch (error) {
      serverLog.error({ error }, 'Failed to initialize abort controllers registry');
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

    this.persistEntry(id).catch((error) => {
      serverLog.error({ error, id, sessionId }, 'Failed to persist abort controller entry');
    });

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
    this.removePersistedEntry(id).catch((error) => {
      serverLog.error({ error, id }, 'Failed to remove abort controller entry');
    });
  }

  getBySession(sessionId: string): AbortControllerEntry[] {
    return Array.from(this.entries.values()).filter((e) => e.sessionId === sessionId);
  }

  async persistEntry(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;

    try {
      await db
        .insert(abortControllersTable)
        .values({
          id: entry.id,
          sessionId: entry.sessionId,
          reason: entry.reason ?? null,
          createdAt: new Date(entry.createdAt),
        })
        .onConflictDoUpdate({
          target: abortControllersTable.id,
          set: {
            reason: entry.reason ?? null,
          },
        });
    } catch (error) {
      serverLog.error({ error, id }, 'Failed to persist abort controller');
    }
  }

  async removePersistedEntry(id: string): Promise<void> {
    try {
      await db.delete(abortControllersTable).where(eq(abortControllersTable.id, id));
    } catch (error) {
      serverLog.error({ error, id }, 'Failed to remove persisted abort controller');
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
