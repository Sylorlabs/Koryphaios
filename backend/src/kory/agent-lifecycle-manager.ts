// Agent Lifecycle Manager
// Domain: Worker agent creation, tracking, and cleanup
// Extracted from manager.ts lines 143-220, 926-985

import type { AgentIdentity, AgentStatus, ProviderName, WorkerDomain, WSMessage } from "@koryphaios/shared";
import { koryLog } from "../logger";
import { wsBroker } from "../pubsub";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface KoryTask {
  id: string;
  description: string;
  domain: WorkerDomain;
  assignedModel: string;
  assignedProvider: ProviderName;
  status: "pending" | "active" | "done" | "failed";
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

export interface AgentLifecycleManagerDependencies {
  managerAgentId: string;
}

// ─── AgentLifecycleManager Class ────────────────────────────────────────────────

export class AgentLifecycleManager {
  private activeWorkers = new Map<string, WorkerState>();
  private workerUsage = new Map<string, WorkerUsage>();
  private managerAgentId: string;

  constructor(deps: AgentLifecycleManagerDependencies) {
    this.managerAgentId = deps.managerAgentId;
  }

  /**
   * Register a new worker agent.
   *
   * @param agentId - Unique agent identifier
   * @param agent - Agent identity information
   * @param task - Task assignment
   * @param sessionId - Parent session ID
   * @returns AbortController for cancellation
   */
  registerWorker(agentId: string, agent: AgentIdentity, task: KoryTask, sessionId: string): AbortController {
    const abort = new AbortController();

    this.activeWorkers.set(agentId, {
      agent,
      status: "thinking",
      task,
      abort,
      sessionId,
    });

    this.emitAgentStatus(sessionId, agentId, "thinking");
    koryLog.info({ agentId, sessionId, task: task.description }, "Worker registered");

    return abort;
  }

  /**
   * Cancel a specific worker by ID.
   *
   * @param agentId - Worker agent ID to cancel
   */
  cancelWorker(agentId: string): void {
    const worker = this.activeWorkers.get(agentId);
    if (worker) {
      this.emitAgentStatus(worker.sessionId, agentId, "done");
      worker.abort.abort();
      this.activeWorkers.delete(agentId);
      koryLog.info({ agentId }, "Worker cancelled");
    }
  }

  /**
   * Cancel all workers for a specific session.
   *
   * @param sessionId - Session ID
   */
  cancelSessionWorkers(sessionId: string): void {
    for (const [id, worker] of this.activeWorkers.entries()) {
      if (worker.sessionId === sessionId) {
        this.emitAgentStatus(sessionId, id, "done");
        worker.abort.abort();
        this.activeWorkers.delete(id);
        koryLog.info({ agentId: id, sessionId }, "Session worker cancelled");
      }
    }
  }

  /**
   * Check if a session has any active workers.
   *
   * @param sessionId - Session ID to check
   * @returns true if session has active workers
   */
  hasActiveWorkersForSession(sessionId: string): boolean {
    for (const worker of this.activeWorkers.values()) {
      if (worker.sessionId === sessionId) return true;
    }
    return false;
  }

  /**
   * Update a worker's status.
   *
   * @param agentId - Worker agent ID
   * @param status - New status
   */
  updateWorkerStatus(agentId: string, status: AgentStatus): void {
    const worker = this.activeWorkers.get(agentId);
    if (worker) {
      worker.status = status;
      this.emitAgentStatus(worker.sessionId, agentId, status);
    }
  }

  /**
   * Update a worker's task result.
   *
   * @param agentId - Worker agent ID
   * @param result - Task result
   */
  updateWorkerResult(agentId: string, result: string): void {
    const worker = this.activeWorkers.get(agentId);
    if (worker) {
      worker.task.result = result;
      worker.task.status = "done";
    }
  }

  /**
   * Update a worker's task error.
   *
   * @param agentId - Worker agent ID
   * @param error - Error message
   */
  updateWorkerError(agentId: string, error: string): void {
    const worker = this.activeWorkers.get(agentId);
    if (worker) {
      worker.task.error = error;
      worker.task.status = "failed";
    }
  }

  /**
   * Get a worker by ID.
   *
   * @param agentId - Worker agent ID
   * @returns Worker state or undefined
   */
  getWorker(agentId: string): WorkerState | undefined {
    return this.activeWorkers.get(agentId);
  }

  /**
   * Get all active workers.
   *
   * @returns Array of all active worker states
   */
  getAllWorkers(): WorkerState[] {
    return Array.from(this.activeWorkers.values());
  }

  /**
   * Get workers for a specific session.
   *
   * @param sessionId - Session ID
   * @returns Array of workers for the session
   */
  getSessionWorkers(sessionId: string): WorkerState[] {
    return Array.from(this.activeWorkers.values()).filter(
      (w) => w.sessionId === sessionId
    );
  }

  /**
   * Get status information for all workers.
   *
   * @returns Array of worker status objects
   */
  getStatus(): Array<{
    agent: AgentIdentity;
    status: AgentStatus;
    task: KoryTask;
    sessionId: string;
  }> {
    return Array.from(this.activeWorkers.values()).map((w) => ({
      agent: w.agent,
      status: w.status,
      task: w.task,
      sessionId: w.sessionId,
    }));
  }

  /**
   * Record token usage for a worker.
   *
   * @param agentId - Worker agent ID
   * @param tokensIn - Input tokens consumed
   * @param tokensOut - Output tokens generated
   * @param usageKnown - Whether usage counters are reliable
   */
  recordUsage(agentId: string, tokensIn: number, tokensOut: number, usageKnown: boolean): void {
    const existing = this.workerUsage.get(agentId) ?? { tokensIn: 0, tokensOut: 0, usageKnown: false };
    this.workerUsage.set(agentId, {
      tokensIn: existing.tokensIn + tokensIn,
      tokensOut: existing.tokensOut + tokensOut,
      usageKnown: existing.usageKnown || usageKnown,
    });
  }

  /**
   * Get usage information for a worker.
   *
   * @param agentId - Worker agent ID
   * @returns Usage information or undefined
   */
  getUsage(agentId: string): WorkerUsage | undefined {
    return this.workerUsage.get(agentId);
  }

  /**
   * Cancel all active workers across all sessions.
   */
  cancelAll(): void {
    const sessionIds = new Set<string>();

    for (const worker of this.activeWorkers.values()) {
      sessionIds.add(worker.sessionId);
      this.emitAgentStatus(worker.sessionId, worker.agent.id, "done");
      worker.abort.abort();
    }

    this.activeWorkers.clear();
    koryLog.info({ totalWorkers: sessionIds.size }, "All workers cancelled");
  }

  /**
   * Get the total number of active workers.
   *
   * @returns Count of active workers
   */
  getActiveWorkerCount(): number {
    return this.activeWorkers.size;
  }

  /**
   * Get abort controller for a worker.
   *
   * @param agentId - Worker agent ID
   * @returns AbortController or undefined
   */
  getAbortController(agentId: string): AbortController | undefined {
    return this.activeWorkers.get(agentId)?.abort;
  }

  /**
   * Remove a worker from tracking (after completion/cancellation).
   *
   * @param agentId - Worker agent ID
   */
  removeWorker(agentId: string): void {
    const worker = this.activeWorkers.get(agentId);
    if (worker) {
      this.activeWorkers.delete(agentId);
      koryLog.info({ agentId }, "Worker removed from tracking");
    }
  }

  /**
   * Clear all worker tracking state.
   */
  clear(): void {
    this.activeWorkers.clear();
    this.workerUsage.clear();
  }

  // ─── Private Methods ───────────────────────────────────────────────────────────

  private emitAgentStatus(sessionId: string, agentId: string, status: AgentStatus): void {
    wsBroker.publish("custom", {
      type: "agent.status" as WSMessage["type"],
      payload: { agentId, status },
      timestamp: Date.now(),
      sessionId,
      agentId: this.managerAgentId,
    });
  }
}
