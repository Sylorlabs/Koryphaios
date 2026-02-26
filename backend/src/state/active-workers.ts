/**
 * Active Workers Registry
 * Tracks running worker processes with persistence support.
 */

import type { WorkerTask } from "@koryphaios/shared";
import { initDb } from "../db/sqlite";

export interface ActiveWorker {
  sessionId: string;
  taskId: string;
  task: WorkerTask;
  startTime: number;
  status: "running" | "paused" | "completed" | "failed";
}

export class ActiveWorkersRegistry {
  private workers = new Map<string, ActiveWorker>();
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      const db = await initDb();
      
      // Load persisted workers
      const rows = db.query(`
        SELECT session_id, task_id, task_data, start_time, status
        FROM active_workers
        WHERE status IN ('running', 'paused')
      `).all() as any[];

      for (const row of rows) {
        try {
          const task = JSON.parse(row.task_data) as WorkerTask;
          this.workers.set(row.task_id, {
            sessionId: row.session_id,
            taskId: row.task_id,
            task,
            startTime: row.start_time,
            status: row.status,
          });
        } catch (e) {
          console.error("Failed to restore worker:", row.task_id, e);
        }
      }

      this.initialized = true;
    } catch (error) {
      console.error("Failed to initialize workers registry:", error);
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
      status: "running",
    };

    this.workers.set(taskId, worker);
    this.persistWorker(worker).catch(console.error);
  }

  unregister(taskId: string): void {
    this.workers.delete(taskId);
    this.removePersistedWorker(taskId).catch(console.error);
  }

  get(taskId: string): ActiveWorker | undefined {
    return this.workers.get(taskId);
  }

  getAll(): ActiveWorker[] {
    return Array.from(this.workers.values());
  }

  getBySession(sessionId: string): ActiveWorker[] {
    return Array.from(this.workers.values()).filter(w => w.sessionId === sessionId);
  }

  async persistWorker(worker: ActiveWorker): Promise<void> {
    try {
      const db = await initDb();
      db.query(`
        INSERT OR REPLACE INTO active_workers 
        (session_id, task_id, task_data, start_time, status)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        worker.sessionId,
        worker.taskId,
        JSON.stringify(worker.task),
        worker.startTime,
        worker.status,
      );
    } catch (error) {
      console.error("Failed to persist worker:", error);
    }
  }

  async removePersistedWorker(taskId: string): Promise<void> {
    try {
      const db = await initDb();
      db.query("DELETE FROM active_workers WHERE task_id = ?").run(taskId);
    } catch (error) {
      console.error("Failed to remove persisted worker:", error);
    }
  }

  async updateStatus(taskId: string, status: ActiveWorker["status"]): Promise<void> {
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
