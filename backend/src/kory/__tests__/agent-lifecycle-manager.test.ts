// Agent Lifecycle Manager Tests
// Domain: Unit tests for worker agent tracking and lifecycle management

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { AgentLifecycleManager, type KoryTask, type WorkerState } from "../agent-lifecycle-manager";
import type { AgentIdentity, AgentStatus } from "@koryphaios/shared";

// Mock wsBroker module
import { wsBroker } from "../../pubsub";

describe("AgentLifecycleManager", () => {
  let lifecycleManager: AgentLifecycleManager;
  let mockAgent: AgentIdentity;
  let mockTask: KoryTask;
  let publishSpy: any;

  beforeEach(() => {
    // Clear any previous state by creating a fresh instance
    lifecycleManager = new AgentLifecycleManager({
      managerAgentId: "kory-manager"
    });

    // Spy on wsBroker.publish
    publishSpy = mock(() => {});
    // @ts-ignore - replace publish method for testing
    wsBroker.publish = publishSpy;

    mockAgent = {
      id: "worker-123",
      name: "Code Assistant",
      role: "coder",
      model: "gpt-4.1",
      provider: "openai",
      domain: "backend",
      glowColor: "rgba(0,255,255,0.5)"
    };

    mockTask = {
      id: "task-456",
      description: "Implement user authentication",
      domain: "backend",
      assignedModel: "gpt-4.1",
      assignedProvider: "openai",
      status: "pending"
    };
  });

  describe("registerWorker", () => {
    it("should register a new worker and return abort controller", () => {
      const abort = lifecycleManager.registerWorker(
        "worker-123",
        mockAgent,
        mockTask,
        "session-1"
      );

      expect(abort).toBeDefined();
      expect(abort).toBeInstanceOf(AbortController);

      const worker = lifecycleManager.getWorker("worker-123");
      expect(worker).toBeDefined();
      expect(worker?.agent.id).toBe("worker-123");
      expect(worker?.status).toBe("thinking");
      expect(worker?.sessionId).toBe("session-1");
    });

    it("should emit agent status on registration", () => {
      lifecycleManager.registerWorker(
        "worker-123",
        mockAgent,
        mockTask,
        "session-1"
      );

      expect(publishSpy).toHaveBeenCalledWith(
        "custom",
        expect.objectContaining({
          type: "agent.status",
          payload: { agentId: "worker-123", status: "thinking" },
          sessionId: "session-1"
        })
      );
    });

    it("should allow multiple workers for different sessions", () => {
      lifecycleManager.registerWorker("worker-1", mockAgent, mockTask, "session-1");
      lifecycleManager.registerWorker("worker-2", mockAgent, mockTask, "session-2");

      expect(lifecycleManager.getActiveWorkerCount()).toBe(2);
    });
  });

  describe("cancelWorker", () => {
    it("should cancel a specific worker by ID", () => {
      lifecycleManager.registerWorker("worker-123", mockAgent, mockTask, "session-1");

      lifecycleManager.cancelWorker("worker-123");

      expect(lifecycleManager.getWorker("worker-123")).toBeUndefined();
      expect(publishSpy).toHaveBeenCalledWith(
        "custom",
        expect.objectContaining({
          payload: { agentId: "worker-123", status: "done" }
        })
      );
    });

    it("should abort the worker's abort controller", () => {
      const abort = lifecycleManager.registerWorker("worker-123", mockAgent, mockTask, "session-1");
      const abortSpy = mock(() => {});
      abort.abort = abortSpy;

      lifecycleManager.cancelWorker("worker-123");

      expect(abortSpy).toHaveBeenCalled();
    });

    it("should handle cancelling non-existent worker gracefully", () => {
      expect(() => lifecycleManager.cancelWorker("nonexistent")).not.toThrow();
    });
  });

  describe("cancelSessionWorkers", () => {
    it("should cancel all workers for a specific session", () => {
      lifecycleManager.registerWorker("worker-1", mockAgent, mockTask, "session-1");
      lifecycleManager.registerWorker("worker-2", mockAgent, mockTask, "session-1");
      lifecycleManager.registerWorker("worker-3", mockAgent, mockTask, "session-2");

      lifecycleManager.cancelSessionWorkers("session-1");

      expect(lifecycleManager.getSessionWorkers("session-1")).toHaveLength(0);
      expect(lifecycleManager.getSessionWorkers("session-2")).toHaveLength(1);
      expect(lifecycleManager.getWorker("worker-3")).toBeDefined();
    });

    it("should emit done status for each cancelled worker", () => {
      lifecycleManager.registerWorker("worker-1", mockAgent, mockTask, "session-1");
      lifecycleManager.registerWorker("worker-2", mockAgent, mockTask, "session-1");

      lifecycleManager.cancelSessionWorkers("session-1");

      expect(publishSpy).toHaveBeenCalledTimes(4); // 2 for register, 2 for cancel
    });
  });

  describe("hasActiveWorkersForSession", () => {
    it("should return true when session has active workers", () => {
      lifecycleManager.registerWorker("worker-1", mockAgent, mockTask, "session-1");

      expect(lifecycleManager.hasActiveWorkersForSession("session-1")).toBe(true);
    });

    it("should return false when session has no workers", () => {
      expect(lifecycleManager.hasActiveWorkersForSession("session-1")).toBe(false);
    });

    it("should return false after workers are cancelled", () => {
      lifecycleManager.registerWorker("worker-1", mockAgent, mockTask, "session-1");
      lifecycleManager.cancelWorker("worker-1");

      expect(lifecycleManager.hasActiveWorkersForSession("session-1")).toBe(false);
    });
  });

  describe("updateWorkerStatus", () => {
    it("should update worker status and emit event", () => {
      lifecycleManager.registerWorker("worker-123", mockAgent, mockTask, "session-1");

      lifecycleManager.updateWorkerStatus("worker-123", "done");

      const worker = lifecycleManager.getWorker("worker-123");
      expect(worker?.status).toBe("done");

      expect(publishSpy).toHaveBeenCalledWith(
        "custom",
        expect.objectContaining({
          payload: { agentId: "worker-123", status: "done" }
        })
      );
    });

    it("should handle updating non-existent worker gracefully", () => {
      expect(() => lifecycleManager.updateWorkerStatus("nonexistent", "done")).not.toThrow();
    });
  });

  describe("updateWorkerResult", () => {
    it("should update task result and mark as done", () => {
      lifecycleManager.registerWorker("worker-123", mockAgent, mockTask, "session-1");

      lifecycleManager.updateWorkerResult("worker-123", "Task completed successfully");

      const worker = lifecycleManager.getWorker("worker-123");
      expect(worker?.task.result).toBe("Task completed successfully");
      expect(worker?.task.status).toBe("done");
    });
  });

  describe("updateWorkerError", () => {
    it("should update task error and mark as failed", () => {
      lifecycleManager.registerWorker("worker-123", mockAgent, mockTask, "session-1");

      lifecycleManager.updateWorkerError("worker-123", "Network timeout");

      const worker = lifecycleManager.getWorker("worker-123");
      expect(worker?.task.error).toBe("Network timeout");
      expect(worker?.task.status).toBe("failed");
    });
  });

  describe("getWorker", () => {
    it("should return worker by ID", () => {
      lifecycleManager.registerWorker("worker-123", mockAgent, mockTask, "session-1");

      const worker = lifecycleManager.getWorker("worker-123");

      expect(worker).toBeDefined();
      expect(worker?.agent.id).toBe("worker-123");
    });

    it("should return undefined for non-existent worker", () => {
      const worker = lifecycleManager.getWorker("nonexistent");
      expect(worker).toBeUndefined();
    });
  });

  describe("getAllWorkers", () => {
    it("should return all active workers", () => {
      const agent1 = { ...mockAgent, id: "worker-1" };
      const agent2 = { ...mockAgent, id: "worker-2" };

      lifecycleManager.registerWorker("worker-1", agent1, mockTask, "session-1");
      lifecycleManager.registerWorker("worker-2", agent2, mockTask, "session-2");

      const workers = lifecycleManager.getAllWorkers();

      expect(workers).toHaveLength(2);
      const workerIds = workers.map(w => w.agent.id).sort();
      expect(workerIds).toEqual(["worker-1", "worker-2"]);
    });

    it("should return empty array when no workers", () => {
      const workers = lifecycleManager.getAllWorkers();
      expect(workers).toEqual([]);
    });
  });

  describe("getSessionWorkers", () => {
    it("should return workers for specific session", () => {
      lifecycleManager.registerWorker("worker-1", mockAgent, mockTask, "session-1");
      lifecycleManager.registerWorker("worker-2", mockAgent, mockTask, "session-1");
      lifecycleManager.registerWorker("worker-3", mockAgent, mockTask, "session-2");

      const sessionWorkers = lifecycleManager.getSessionWorkers("session-1");

      expect(sessionWorkers).toHaveLength(2);
      expect(sessionWorkers.every(w => w.sessionId === "session-1")).toBe(true);
    });

    it("should return empty array for session with no workers", () => {
      const workers = lifecycleManager.getSessionWorkers("nonexistent");
      expect(workers).toEqual([]);
    });
  });

  describe("getStatus", () => {
    it("should return status for all workers", () => {
      lifecycleManager.registerWorker("worker-1", mockAgent, mockTask, "session-1");
      lifecycleManager.registerWorker("worker-2", mockAgent, mockTask, "session-2");

      const status = lifecycleManager.getStatus();

      expect(status).toHaveLength(2);
      expect(status[0]).toMatchObject({
        agent: mockAgent,
        status: "thinking",
        task: mockTask,
        sessionId: "session-1"
      });
    });

    it("should not include abort controller in status", () => {
      lifecycleManager.registerWorker("worker-123", mockAgent, mockTask, "session-1");

      const status = lifecycleManager.getStatus();

      expect(status[0]).not.toHaveProperty("abort");
    });
  });

  describe("recordUsage", () => {
    it("should record initial usage for worker", () => {
      lifecycleManager.recordUsage("worker-123", 1000, 500, true);

      const usage = lifecycleManager.getUsage("worker-123");

      expect(usage).toEqual({
        tokensIn: 1000,
        tokensOut: 500,
        usageKnown: true
      });
    });

    it("should accumulate usage across multiple records", () => {
      lifecycleManager.recordUsage("worker-123", 1000, 500, true);
      lifecycleManager.recordUsage("worker-123", 500, 250, true);

      const usage = lifecycleManager.getUsage("worker-123");

      expect(usage?.tokensIn).toBe(1500);
      expect(usage?.tokensOut).toBe(750);
    });

    it("should update usageKnown to true if any record has known usage", () => {
      lifecycleManager.recordUsage("worker-123", 0, 0, false);
      lifecycleManager.recordUsage("worker-123", 1000, 500, true);

      const usage = lifecycleManager.getUsage("worker-123");

      expect(usage?.usageKnown).toBe(true);
    });

    it("should return undefined for worker with no usage", () => {
      const usage = lifecycleManager.getUsage("worker-123");
      expect(usage).toBeUndefined();
    });
  });

  describe("cancelAll", () => {
    it("should cancel all workers across all sessions", () => {
      lifecycleManager.registerWorker("worker-1", mockAgent, mockTask, "session-1");
      lifecycleManager.registerWorker("worker-2", mockAgent, mockTask, "session-2");
      lifecycleManager.registerWorker("worker-3", mockAgent, mockTask, "session-1");

      lifecycleManager.cancelAll();

      expect(lifecycleManager.getActiveWorkerCount()).toBe(0);
      expect(lifecycleManager.getWorker("worker-1")).toBeUndefined();
      expect(lifecycleManager.getWorker("worker-2")).toBeUndefined();
      expect(lifecycleManager.getWorker("worker-3")).toBeUndefined();
    });

    it("should emit done status for all cancelled workers", () => {
      lifecycleManager.registerWorker("worker-1", mockAgent, mockTask, "session-1");
      lifecycleManager.registerWorker("worker-2", mockAgent, mockTask, "session-2");

      publishSpy.mockClear(); // Clear registration calls
      lifecycleManager.cancelAll();

      // Should emit 2 done events (one for each worker)
      expect(publishSpy).toHaveBeenCalledTimes(2);
      // Verify each was a done status
      const calls = publishSpy.mock.calls;
      expect(calls[0]?.[1]?.payload?.status).toBe("done");
      expect(calls[1]?.[1]?.payload?.status).toBe("done");
    });
  });

  describe("getActiveWorkerCount", () => {
    it("should return correct count of active workers", () => {
      expect(lifecycleManager.getActiveWorkerCount()).toBe(0);

      lifecycleManager.registerWorker("worker-1", mockAgent, mockTask, "session-1");
      expect(lifecycleManager.getActiveWorkerCount()).toBe(1);

      lifecycleManager.registerWorker("worker-2", mockAgent, mockTask, "session-2");
      expect(lifecycleManager.getActiveWorkerCount()).toBe(2);

      lifecycleManager.cancelWorker("worker-1");
      expect(lifecycleManager.getActiveWorkerCount()).toBe(1);
    });
  });

  describe("getAbortController", () => {
    it("should return abort controller for worker", () => {
      const abort = lifecycleManager.registerWorker("worker-123", mockAgent, mockTask, "session-1");

      const retrieved = lifecycleManager.getAbortController("worker-123");

      expect(retrieved).toBe(abort);
    });

    it("should return undefined for non-existent worker", () => {
      const retrieved = lifecycleManager.getAbortController("nonexistent");
      expect(retrieved).toBeUndefined();
    });
  });

  describe("removeWorker", () => {
    it("should remove worker from tracking", () => {
      lifecycleManager.registerWorker("worker-123", mockAgent, mockTask, "session-1");

      lifecycleManager.removeWorker("worker-123");

      expect(lifecycleManager.getWorker("worker-123")).toBeUndefined();
    });

    it("should not emit status when removing worker", () => {
      lifecycleManager.registerWorker("worker-123", mockAgent, mockTask, "session-1");
      publishSpy.mockClear();

      lifecycleManager.removeWorker("worker-123");

      expect(publishSpy).not.toHaveBeenCalled();
    });
  });

  describe("clear", () => {
    it("should clear all workers and usage data", () => {
      lifecycleManager.registerWorker("worker-1", mockAgent, mockTask, "session-1");
      lifecycleManager.recordUsage("worker-1", 1000, 500, true);

      lifecycleManager.clear();

      expect(lifecycleManager.getActiveWorkerCount()).toBe(0);
      expect(lifecycleManager.getUsage("worker-1")).toBeUndefined();
    });
  });
});

describe("AgentLifecycleManager Edge Cases", () => {
  it("should handle rapid registration and cancellation", () => {
    const lifecycleManager = new AgentLifecycleManager({ managerAgentId: "kory" });
    const agent = { id: "w", name: "W", role: "coder" as const, model: "gpt-4", provider: "openai" as const, domain: "general" as const, glowColor: "#fff" };
    const task = { id: "t", description: "T", domain: "general" as const, assignedModel: "gpt-4", assignedProvider: "openai" as const, status: "pending" as const };

    for (let i = 0; i < 100; i++) {
      lifecycleManager.registerWorker(`worker-${i}`, agent, task, `session-${i % 5}`);
    }

    expect(lifecycleManager.getActiveWorkerCount()).toBe(100);

    lifecycleManager.clear();
    expect(lifecycleManager.getActiveWorkerCount()).toBe(0);
  });

  it("should handle empty session ID", () => {
    const lifecycleManager = new AgentLifecycleManager({ managerAgentId: "kory" });
    const agent = { id: "w", name: "W", role: "coder" as const, model: "gpt-4", provider: "openai" as const, domain: "general" as const, glowColor: "#fff" };
    const task = { id: "t", description: "T", domain: "general" as const, assignedModel: "gpt-4", assignedProvider: "openai" as const, status: "pending" as const };

    lifecycleManager.registerWorker("worker-1", agent, task, "");

    expect(lifecycleManager.hasActiveWorkersForSession("")).toBe(true);
  });

  it("should handle very long task descriptions", () => {
    const lifecycleManager = new AgentLifecycleManager({ managerAgentId: "kory" });
    const agent = { id: "w", name: "W", role: "coder" as const, model: "gpt-4", provider: "openai" as const, domain: "general" as const, glowColor: "#fff" };
    const task = {
      id: "t",
      description: "A".repeat(10000),
      domain: "general" as const,
      assignedModel: "gpt-4",
      assignedProvider: "openai" as const,
      status: "pending" as const
    };

    expect(() => lifecycleManager.registerWorker("worker-1", agent, task, "session-1")).not.toThrow();
  });

  it("should handle zero token usage", () => {
    const lifecycleManager = new AgentLifecycleManager({ managerAgentId: "kory" });

    lifecycleManager.recordUsage("worker-1", 0, 0, false);

    const usage = lifecycleManager.getUsage("worker-1");
    expect(usage).toEqual({ tokensIn: 0, tokensOut: 0, usageKnown: false });
  });

  it("should handle concurrent status updates", () => {
    const lifecycleManager = new AgentLifecycleManager({ managerAgentId: "kory" });
    const agent = { id: "w", name: "W", role: "coder" as const, model: "gpt-4", provider: "openai" as const, domain: "general" as const, glowColor: "#fff" };
    const task = { id: "t", description: "T", domain: "general" as const, assignedModel: "gpt-4", assignedProvider: "openai" as const, status: "pending" as const };

    lifecycleManager.registerWorker("worker-1", agent, task, "session-1");

    const statuses: AgentStatus[] = ["thinking", "idle", "done", "error", "thinking"];
    statuses.forEach(status => {
      lifecycleManager.updateWorkerStatus("worker-1", status);
    });

    const worker = lifecycleManager.getWorker("worker-1");
    expect(worker?.status).toBe("thinking");
  });
});

describe("AgentLifecycleManager Backward Compatibility", () => {
  it("should export KoryTask type", () => {
    const task: KoryTask = {
      id: "task-1",
      description: "Test task",
      domain: "general",
      assignedModel: "gpt-4",
      assignedProvider: "openai",
      status: "pending"
    };
    expect(task).toBeDefined();
  });

  it("should export WorkerState type", () => {
    const state: WorkerState = {
      agent: {
        id: "worker-1",
        name: "Test",
        role: "coder",
        model: "gpt-4",
        provider: "openai",
        domain: "general",
        glowColor: "#fff"
      },
      status: "thinking",
      task: {
        id: "task-1",
        description: "Test",
        domain: "general",
        assignedModel: "gpt-4",
        assignedProvider: "openai",
        status: "pending"
      },
      abort: new AbortController(),
      sessionId: "session-1"
    };
    expect(state).toBeDefined();
  });
});
