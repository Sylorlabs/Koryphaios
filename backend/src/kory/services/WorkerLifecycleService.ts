/**
 * WorkerLifecycleService
 *
 * Manages worker agent lifecycle: registration, tracking, cancellation, usage stats.
 * Extracted from KoryManager to reduce its line count.
 */

import type { AgentIdentity, AgentStatus, WorkerDomain, ProviderName } from '@koryphaios/shared';
import type { EventEmitterService } from './EventEmitterService';

export interface KoryTask {
  id: string;
  description: string;
  domain: WorkerDomain;
  assignedModel: string;
  assignedProvider: ProviderName;
  status: 'pending' | 'active' | 'done' | 'failed';
  result?: string;
  error?: string;
}

export interface WorkerState {
  agent: AgentIdentity;
  status: AgentStatus;
  task: KoryTask;
  abort: AbortController;
  sessionId: string;
}

export interface WorkerUsage {
  tokensIn: number;
  tokensOut: number;
  usageKnown: boolean;
}

export interface WorkerStatus {
  agent: AgentIdentity;
  status: AgentStatus;
  task: string;
  sessionId: string;
}

export interface WorkerLifecycleServiceConfig {
  events: EventEmitterService;
}

/**
 * Manages worker agent lifecycle.
 */
export class WorkerLifecycleService {
  private activeWorkers = new Map<string, WorkerState>();
  private workerUsage = new Map<string, WorkerUsage>();
  private events: EventEmitterService;

  constructor(config: WorkerLifecycleServiceConfig) {
    this.events = config.events;
  }

  // ─── Registration ────────────────────────────────────────────────────────────

  registerWorker(
    workerId: string,
    agent: AgentIdentity,
    task: KoryTask,
    abort: AbortController,
    sessionId: string,
  ): void {
    this.activeWorkers.set(workerId, { agent, status: 'thinking', task, abort, sessionId });
    this.workerUsage.set(workerId, { tokensIn: 0, tokensOut: 0, usageKnown: false });
    this.events.debug('Worker registered', { workerId, sessionId });
  }

  removeWorker(workerId: string): boolean {
    this.workerUsage.delete(workerId);
    return this.activeWorkers.delete(workerId);
  }

  getWorker(workerId: string): WorkerState | undefined {
    return this.activeWorkers.get(workerId);
  }

  hasWorker(workerId: string): boolean {
    return this.activeWorkers.has(workerId);
  }

  // ─── Cancellation ────────────────────────────────────────────────────────────

  cancelWorker(workerId: string): boolean {
    const worker = this.activeWorkers.get(workerId);
    if (worker) {
      this.events.emitAgentStatus(worker.sessionId, workerId, 'done');
      worker.abort.abort();
      this.activeWorkers.delete(workerId);
      this.events.debug('Worker cancelled', { workerId });
      return true;
    }
    return false;
  }

  cancelSessionWorkers(sessionId: string): number {
    let count = 0;
    for (const [id, worker] of this.activeWorkers.entries()) {
      if (worker.sessionId === sessionId) {
        this.events.emitAgentStatus(sessionId, id, 'done');
        worker.abort.abort();
        this.activeWorkers.delete(id);
        count++;
      }
    }
    return count;
  }

  cancelAll(): string[] {
    const sessionIds = new Set<string>();
    for (const worker of this.activeWorkers.values()) {
      sessionIds.add(worker.sessionId);
      this.events.emitAgentStatus(worker.sessionId, worker.agent.id, 'done');
      worker.abort.abort();
    }
    this.activeWorkers.clear();
    return Array.from(sessionIds);
  }

  // ─── Queries ─────────────────────────────────────────────────────────────────

  getAllWorkers(): WorkerState[] {
    return Array.from(this.activeWorkers.values());
  }

  getSessionWorkers(sessionId: string): WorkerState[] {
    return Array.from(this.activeWorkers.values()).filter((w) => w.sessionId === sessionId);
  }

  hasSessionWorkers(sessionId: string): boolean {
    for (const worker of this.activeWorkers.values()) {
      if (worker.sessionId === sessionId) return true;
    }
    return false;
  }

  getActiveCount(): number {
    return this.activeWorkers.size;
  }

  getActiveSessionIds(): string[] {
    const sessionIds = new Set<string>();
    for (const worker of this.activeWorkers.values()) {
      sessionIds.add(worker.sessionId);
    }
    return Array.from(sessionIds);
  }

  // ─── Status & Usage ──────────────────────────────────────────────────────────

  getStatus(): WorkerStatus[] {
    return Array.from(this.activeWorkers.values()).map((w) => ({
      agent: w.agent,
      status: w.status,
      task: w.task.description,
      sessionId: w.sessionId,
    }));
  }

  updateWorkerStatus(workerId: string, status: AgentStatus): void {
    const worker = this.activeWorkers.get(workerId);
    if (worker) {
      worker.status = status;
    }
  }

  updateUsage(workerId: string, tokensIn: number, tokensOut: number): void {
    const usage = this.workerUsage.get(workerId);
    if (usage) {
      usage.tokensIn = Math.max(usage.tokensIn, tokensIn);
      usage.tokensOut = Math.max(usage.tokensOut, tokensOut);
      if (tokensIn > 0 || tokensOut > 0) usage.usageKnown = true;
    }
  }

  getUsage(workerId: string): WorkerUsage | undefined {
    return this.workerUsage.get(workerId);
  }

  initUsage(workerId: string): void {
    if (!this.workerUsage.has(workerId)) {
      this.workerUsage.set(workerId, { tokensIn: 0, tokensOut: 0, usageKnown: false });
    }
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────────────

  cleanupStaleWorkers(): number {
    const activeWorkerIds = new Set(this.activeWorkers.keys());
    let removed = 0;
    for (const [id] of this.workerUsage) {
      if (!activeWorkerIds.has(id)) {
        this.workerUsage.delete(id);
        removed++;
      }
    }
    return removed;
  }

  shutdown(): void {
    for (const worker of this.activeWorkers.values()) {
      try {
        worker.abort.abort();
      } catch {
        // Ignore abort errors during shutdown
      }
    }
    this.activeWorkers.clear();
    this.workerUsage.clear();
  }
}
