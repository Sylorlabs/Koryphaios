/**
 * Active Workers Registry
 * Tracks running worker processes with persistence support.
 */

import type { WorkerTask } from '@koryphaios/shared';
import { db, activeWorkers as activeWorkersTable } from '../db';
import { serverLog } from '../logger';
import { eq, or } from 'drizzle-orm';

export interface ActiveWorker {
  sessionId: string;
  taskId: string;
  task: WorkerTask;
  startTime: number;
  status: 'running' | 'paused' | 'completed' | 'failed';
}

export class ActiveWorkersRegistry {
  private workers = new Map<string, ActiveWorker>();
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      // Load persisted workers
      const rows = await db
        .select()
        .from(activeWorkersTable)
        .where(
          or(eq(activeWorkersTable.status, 'running'), eq(activeWorkersTable.status, 'paused')),
        );

      for (const row of rows) {
        try {
          const task = JSON.parse(row.taskData) as WorkerTask;
          this.workers.set(row.taskId, {
            sessionId: row.sessionId,
            taskId: row.taskId,
            task,
            startTime: row.startTime.getTime(),
            status: row.status as ActiveWorker['status'],
          });
        } catch (e) {
          serverLog.error({ error: e, taskId: row.taskId }, 'Failed to restore worker');
        }
      }

      this.initialized = true;
    } catch (error) {
      serverLog.error({ error }, 'Failed to initialize workers registry');
      // Continue anyway - state will be transient
      this.initialized = true;
    }
  }

  register(sessionId: string, taskId: string, task: WorkerTask): void {
    const worker: ActiveWorker = {
      sessionId,
      taskId,
      task,
      startTime: Date.now(),
      status: 'running',
    };

    this.workers.set(taskId, worker);
    this.persistWorker(worker).catch((error) => {
      serverLog.error({ error, taskId }, 'Failed to persist registered worker');
    });
  }

  unregister(taskId: string): void {
    this.workers.delete(taskId);
    this.removePersistedWorker(taskId).catch((error) => {
      serverLog.error({ error, taskId }, 'Failed to remove persisted worker');
    });
  }

  get(taskId: string): ActiveWorker | undefined {
    return this.workers.get(taskId);
  }

  getAll(): ActiveWorker[] {
    return Array.from(this.workers.values());
  }

  getBySession(sessionId: string): ActiveWorker[] {
    return Array.from(this.workers.values()).filter((w) => w.sessionId === sessionId);
  }

  async persistWorker(worker: ActiveWorker): Promise<void> {
    try {
      await db
        .insert(activeWorkersTable)
        .values({
          sessionId: worker.sessionId,
          taskId: worker.taskId,
          taskData: JSON.stringify(worker.task),
          startTime: new Date(worker.startTime),
          status: worker.status,
        })
        .onConflictDoUpdate({
          target: activeWorkersTable.taskId,
          set: {
            status: worker.status,
            taskData: JSON.stringify(worker.task),
          },
        });
    } catch (error) {
      serverLog.error({ error, taskId: worker.taskId }, 'Failed to persist worker');
    }
  }

  async removePersistedWorker(taskId: string): Promise<void> {
    try {
      await db.delete(activeWorkersTable).where(eq(activeWorkersTable.taskId, taskId));
    } catch (error) {
      serverLog.error({ error, taskId }, 'Failed to remove persisted worker');
    }
  }

  async updateStatus(taskId: string, status: ActiveWorker['status']): Promise<void> {
    const worker = this.workers.get(taskId);
    if (!worker) return;

    worker.status = status;
    await this.persistWorker(worker);
  }

  clear(): void {
    this.workers.clear();
  }
}

export const activeWorkers = new ActiveWorkersRegistry();
