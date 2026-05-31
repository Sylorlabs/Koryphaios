/**
 * WorkerOrchestrationService
 * Manages worker agent lifecycle and task assignment
 */

import { routingLog } from '../../logger';

export interface Worker {
  id: string;
  type: string;
  status: 'idle' | 'busy' | 'error' | 'offline';
  currentTask?: string;
  capabilities: string[];
  lastHeartbeat: number;
}

export interface TaskAssignment {
  taskId: string;
  workerId: string;
  priority: number;
  deadline?: number;
}

export class WorkerOrchestrationService {
  private workers = new Map<string, Worker>();
  private assignments = new Map<string, TaskAssignment>();

  /**
   * Register a new worker
   */
  registerWorker(worker: Omit<Worker, 'lastHeartbeat'>): Worker {
    const fullWorker: Worker = {
      ...worker,
      lastHeartbeat: Date.now(),
    };
    this.workers.set(worker.id, fullWorker);
    routingLog.info({ workerId: worker.id, type: worker.type }, 'Worker registered');
    return fullWorker;
  }

  /**
   * Get an available worker for a task
   */
  getAvailableWorker(capabilities: string[]): Worker | null {
    for (const worker of this.workers.values()) {
      if (worker.status === 'idle' && capabilities.every((c) => worker.capabilities.includes(c))) {
        return worker;
      }
    }
    return null;
  }

  /**
   * Assign a task to a worker
   */
  assignTask(taskId: string, workerId: string, priority = 0): boolean {
    const worker = this.workers.get(workerId);
    if (!worker || worker.status !== 'idle') {
      return false;
    }

    worker.status = 'busy';
    worker.currentTask = taskId;
    this.assignments.set(taskId, { taskId, workerId, priority });
    routingLog.info({ taskId, workerId }, 'Task assigned to worker');
    return true;
  }

  /**
   * Complete a task and free the worker
   */
  completeTask(taskId: string): void {
    const assignment = this.assignments.get(taskId);
    if (assignment) {
      const worker = this.workers.get(assignment.workerId);
      if (worker) {
        worker.status = 'idle';
        worker.currentTask = undefined;
      }
      this.assignments.delete(taskId);
      routingLog.info({ taskId, workerId: assignment.workerId }, 'Task completed');
    }
  }

  /**
   * Update worker heartbeat
   */
  heartbeat(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.lastHeartbeat = Date.now();
    }
  }

  /**
   * Get all active workers
   */
  getActiveWorkers(): Worker[] {
    return Array.from(this.workers.values()).filter((w) => w.status !== 'offline');
  }

  /**
   * Clean up stale workers
   */
  cleanupStaleWorkers(maxAgeMs = 60000): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, worker] of this.workers) {
      if (now - worker.lastHeartbeat > maxAgeMs) {
        worker.status = 'offline';
        removed++;
      }
    }
    return removed;
  }
}

export const workerOrchestrationService = new WorkerOrchestrationService();
