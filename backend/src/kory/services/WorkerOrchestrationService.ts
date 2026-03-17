// WorkerOrchestrationService - Handles worker spawning and lifecycle management
// Extracted from KoryManager to separate concerns

import { nanoid } from "nanoid";
// AbortController is available globally in Bun/Node 18+
import type { ProviderRegistry } from "../../providers";
import type { ToolRegistry, ToolContext } from "../../tools";
import type { WorkspaceManager } from "../workspace-manager";
import type { WorkerDomain, ProviderName, AgentIdentity, AgentStatus, InternalMessage, CompletedToolCall } from "@koryphaios/shared";
import { withTimeoutSignal, type Provider, type ProviderEvent } from "../../providers";
import { normalizeReasoningLevel } from "@koryphaios/shared";
import { RoutingService } from "./RoutingService";
import { UserInteractionService } from "./UserInteractionService";
import { SessionStateService } from "../services/SessionStateService";
import { CriticReviewService } from "./CriticReviewService";
import { TaskPlanningService, type SubTask, type TaskPlan } from "./TaskPlanningService";
import { toProviderMessages } from "../utils/message-formatter";
import { AGENT, DOMAIN } from "../../constants";
import { koryLog } from "../../logger";

interface WorkerResult {
  success: boolean;
  error?: string;
  workerMessages?: InternalMessage[];
}

interface PipelineResult {
  success: boolean;
  workerTranscript?: string;
  criticFeedback?: string;
}

interface SubTaskResult {
  subtask: SubTask;
  success: boolean;
  output: string;
  error?: string;
}

export class WorkerOrchestrationService {
  private activeWorkers = new Map<string, {
    agent: AgentIdentity;
    status: AgentStatus;
    abort: globalThis.AbortController;
    sessionId: string;
  }>();
  private taskPlanningService: TaskPlanningService;

  constructor(
    private providers: ProviderRegistry,
    private tools: ToolRegistry,
    private workingDirectory: string,
    private config: { fallbacks?: Record<string, string[]> },
    private routingService: RoutingService,
    private userInteraction: UserInteractionService,
    private sessionState: SessionStateService,
    private criticService: CriticReviewService,
    private workspaceManager: WorkspaceManager | null
  ) {
    this.taskPlanningService = new TaskPlanningService(providers, { fallbacks: config.fallbacks });
  }

  /**
   * Run the full worker pipeline with confirmation and critic review
   * For complex tasks, automatically decomposes into parallel subtasks
   */
  async runWorkerPipeline(
    sessionId: string,
    task: string,
    preferredModel?: string,
    reasoningLevel?: string,
    domainHint?: string,
    isYoloMode = false,
    enableParallelExecution = true
  ): Promise<PipelineResult> {
    // Check if this is a complex task that benefits from parallelization
    const shouldPlan = enableParallelExecution && this.taskPlanningService.shouldPlanTask(task);
    
    if (shouldPlan && this.workspaceManager) {
      // Try to create an execution plan
      const routing = this.routingService.resolveRouting(preferredModel, "general");
      const provider = this.providers.getAvailable().find((p) => p.name === routing.provider);
      
      if (provider) {
        try {
          const plan = await this.taskPlanningService.createExecutionPlan(
            sessionId, task, provider, routing.model
          );
          
          if (plan.canParallelize && plan.subtasks.length > 1) {
            koryLog.info({ 
              sessionId, 
              subtaskCount: plan.subtasks.length,
              reasoning: plan.reasoning 
            }, "Executing parallel worker pipeline");
            
            return this.runParallelWorkerPipeline(
              sessionId, plan, preferredModel, reasoningLevel, isYoloMode
            );
          }
        } catch (err) {
          koryLog.warn({ sessionId, error: String(err) }, "Parallel planning failed, using single worker");
        }
      }
    }

    // Fall back to single worker execution
    return this.runSingleWorkerPipeline(
      sessionId, task, preferredModel, reasoningLevel, domainHint, isYoloMode
    );
  }

  /**
   * Execute subtasks in parallel where possible
   */
  private async runParallelWorkerPipeline(
    sessionId: string,
    plan: TaskPlan,
    preferredModel?: string,
    reasoningLevel?: string,
    isYoloMode = false
  ): Promise<PipelineResult> {
    // Get user confirmation unless in YOLO mode
    if (!isYoloMode) {
      const subtaskSummary = plan.subtasks.map(st => `• [${st.domain}] ${st.description}`).join("\n");
      const selection = await this.userInteraction.requestInput(
        sessionId,
        `This task will be split into ${plan.subtasks.length} parallel subtasks:\n${subtaskSummary}\n\nProceed?`,
        ["Yes, proceed", "Cancel", "Run as single task"]
      );
      
      if (selection.includes("Cancel")) {
        return { success: false, workerTranscript: "Cancelled by user." };
      }
      
      if (selection.includes("single task")) {
        // User wants to run as single task - combine subtasks
        const combinedTask = plan.subtasks.map(st => st.description).join("\n\n");
        return this.runSingleWorkerPipeline(
          sessionId, combinedTask, preferredModel, reasoningLevel, "general", isYoloMode
        );
      }
    }

    this.userInteraction.emitThought(
      sessionId, 
      "planning", 
      `Executing ${plan.subtasks.length} parallel subtasks...`
    );

    // Group subtasks by execution level (dependencies)
    const executionLevels = this.taskPlanningService.groupByExecutionLevel(plan.subtasks);
    const allResults: SubTaskResult[] = [];

    for (let levelIndex = 0; levelIndex < executionLevels.length; levelIndex++) {
      const level = executionLevels[levelIndex];
      
      this.userInteraction.emitThought(
        sessionId,
        "executing",
        `Running batch ${levelIndex + 1}/${executionLevels.length}: ${level.length} subtask(s) in parallel...`
      );

      // Execute all subtasks in this level in parallel
      const levelPromises = level.map(subtask => 
        this.executeSubTask(
          sessionId, 
          subtask, 
          preferredModel, 
          reasoningLevel, 
          isYoloMode,
          allResults // Pass previous results for context
        )
      );

      const levelResults = await Promise.all(levelPromises);
      allResults.push(...levelResults);

      // Check if any subtask failed
      const failures = levelResults.filter(r => !r.success);
      if (failures.length > 0) {
        const failureSummary = failures.map(f => `• ${f.subtask.description}: ${f.error}`).join("\n");
        return { 
          success: false, 
          workerTranscript: `Some subtasks failed:\n${failureSummary}` 
        };
      }
    }

    // All subtasks completed - aggregate results
    const successfulResults = allResults.filter(r => r.success);
    const aggregatedOutput = successfulResults
      .map(r => `[${r.subtask.domain}] ${r.subtask.description}:\n${r.output}`)
      .join("\n\n---\n\n");

    // Run critic on combined output
    const criticResult = await this.criticService.runCriticGate(
      sessionId, 
      [{ role: "assistant", content: aggregatedOutput }],
      preferredModel
    );

    return {
      success: true,
      workerTranscript: `Completed ${successfulResults.length}/${plan.subtasks.length} subtasks.\n\n${aggregatedOutput}`,
      criticFeedback: criticResult.feedback,
    };
  }

  /**
   * Execute a single subtask in isolation
   */
  private async executeSubTask(
    sessionId: string,
    subtask: SubTask,
    preferredModel?: string,
    reasoningLevel?: string,
    isYoloMode = false,
    previousResults?: SubTaskResult[]
  ): Promise<SubTaskResult> {
    const taskId = `subtask-${subtask.id}-${nanoid(6)}`;
    
    // Setup worktree for this subtask
    let workerDir = this.workingDirectory;
    let worktreeSpawned = false;
    
    if (this.workspaceManager) {
      try {
        const worktree = await this.workspaceManager.spawn(taskId, subtask.description.slice(0, 60));
        if (worktree) {
          workerDir = worktree.path;
          worktreeSpawned = true;
        }
      } catch (err) {
        koryLog.warn({ taskId, error: String(err) }, "Subtask worktree spawn failed");
      }
    }

    // Build context from previous results if there are dependencies
    let taskWithContext = subtask.description;
    if (previousResults && subtask.dependencies.length > 0) {
      const dependencyOutputs = previousResults
        .filter(r => subtask.dependencies.includes(r.subtask.id))
        .map(r => `[${r.subtask.domain}] ${r.subtask.description}:\n${r.output}`)
        .join("\n\n");
      
      if (dependencyOutputs) {
        taskWithContext = `Previous work completed:\n${dependencyOutputs}\n\nYour task:\n${subtask.description}`;
      }
    }

    try {
      const result = await this.executeWorker(
        sessionId,
        taskWithContext,
        preferredModel,
        reasoningLevel,
        subtask.domain,
        workerDir
      );

      // Cleanup worktree
      if (worktreeSpawned && this.workspaceManager) {
        await this.cleanupWorktree(taskId, result.success);
      }

      return {
        subtask,
        success: result.success,
        output: result.workerTranscript ?? "No output",
        error: result.success ? undefined : result.workerTranscript
      };
    } catch (err) {
      if (worktreeSpawned && this.workspaceManager) {
        await this.workspaceManager.cleanup(taskId);
      }
      
      return {
        subtask,
        success: false,
        output: "",
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  /**
   * Run single worker pipeline (original behavior)
   */
  private async runSingleWorkerPipeline(
    sessionId: string,
    task: string,
    preferredModel?: string,
    reasoningLevel?: string,
    domainHint?: string,
    isYoloMode = false
  ): Promise<PipelineResult> {
    // Get user confirmation unless in YOLO mode
    if (!isYoloMode) {
      const selection = await this.userInteraction.requestInput(
        sessionId,
        "Ready to proceed with the delegated task?",
        ["Yes, proceed", "Cancel"]
      );
      if (selection.includes("Cancel")) {
        return { success: false, workerTranscript: "Cancelled by user." };
      }
    } else {
      this.userInteraction.emitThought(sessionId, "executing", "YOLO mode: Proceeding with delegated task.");
    }

    const domain = this.resolveDomain(task, domainHint);
    const taskId = nanoid(12);
    
    // Setup worktree if available
    let workerDir = this.workingDirectory;
    let worktreeSpawned = false;
    
    if (this.workspaceManager) {
      try {
        const worktree = await this.workspaceManager.spawn(taskId, task.slice(0, 60));
        if (worktree) {
          workerDir = worktree.path;
          worktreeSpawned = true;
          koryLog.info({ taskId, path: workerDir }, "Worker running in isolated worktree");
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        koryLog.warn({ err: message }, "Worktree spawn failed — using main directory");
      }
    }

    // Execute worker
    const result = await this.executeWorker(
      sessionId,
      task,
      preferredModel,
      reasoningLevel,
      domain,
      workerDir
    );

    // Cleanup worktree
    if (worktreeSpawned && this.workspaceManager) {
      await this.cleanupWorktree(taskId, result.success);
    }

    return result;
  }

  /**
   * Execute worker task
   */
  private async executeWorker(
    sessionId: string,
    task: string,
    preferredModel: string | undefined,
    reasoningLevel: string | undefined,
    domain: WorkerDomain,
    workerDir: string
  ): Promise<PipelineResult> {
    const routing = this.routingService.resolveRouting(preferredModel, domain);
    const isSandboxed = !this.routingService.requiresSystemAccess(task);

    let workerTask = task;
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      attempts++;
      
      this.userInteraction.emitThought(sessionId, "delegating", `Delegating to ${domain} worker...`);
      
      const provider = this.providers.getAvailable().find((p) => p.name === routing.provider);
      
      if (!provider) {
        const alt = this.providers.getAvailable()[0];
        if (!alt) {
          return { success: false, workerTranscript: "No provider available." };
        }
        
        const result = await this.runWorkerWithProvider(
          sessionId,
          alt,
          routing.model,
          workerTask,
          domain,
          reasoningLevel,
          workerDir,
          isSandboxed
        );
        
        if (result.success) {
          const criticResult = await this.criticService.runCriticGate(sessionId, result.workerMessages, preferredModel);
          if (criticResult.passed) {
            return {
              success: true,
              workerTranscript: this.formatTranscript(result.workerMessages),
              criticFeedback: criticResult.feedback,
            };
          }
          workerTask = `QUALITY FAILURE. Fix these:\n${criticResult.feedback}`;
        } else {
          return { success: false, workerTranscript: result.error };
        }
        continue;
      }

      const result = await this.runWorkerWithProvider(
        sessionId,
        provider,
        routing.model,
        workerTask,
        domain,
        reasoningLevel,
        workerDir,
        isSandboxed
      );

      if (result.success) {
        const criticResult = await this.criticService.runCriticGate(sessionId, result.workerMessages, preferredModel);
        if (criticResult.passed) {
          return {
            success: true,
            workerTranscript: this.formatTranscript(result.workerMessages),
            criticFeedback: criticResult.feedback,
          };
        }
        workerTask = `QUALITY FAILURE. Fix these:\n${criticResult.feedback}`;
      } else if (!this.providers.isQuotaError(result.error)) {
        return { success: false, workerTranscript: result.error };
      }
    }

    return { success: false, workerTranscript: "Max retry attempts exceeded." };
  }

  /**
   * Run worker with a specific provider
   */
  private async runWorkerWithProvider(
    sessionId: string,
    provider: Provider,
    modelId: string,
    userMessage: string,
    domain: WorkerDomain,
    reasoningLevel: string | undefined,
    workerDir: string,
    isSandboxed: boolean
  ): Promise<WorkerResult> {
    const workerId = `worker-${nanoid(8)}`;
    const abort = new globalThis.AbortController();
    
    const identity: AgentIdentity = {
      id: workerId,
      name: `${domain} Worker`,
      role: "coder",
      model: modelId,
      provider: provider.name as ProviderName,
      domain,
      glowColor: DOMAIN.GLOW_COLORS[domain],
    };

    this.userInteraction.emitAgentSpawned(sessionId, identity, userMessage);
    this.userInteraction.emitAgentStatus(sessionId, workerId, "thinking");
    this.userInteraction.emitUsage(sessionId, workerId, modelId, provider.name, 0, 0, false);

    this.activeWorkers.set(workerId, { agent: identity, status: "thinking", abort, sessionId });

    const ctx: ToolContext = {
      sessionId,
      workingDirectory: workerDir,
      signal: abort.signal,
      allowedPaths: [workerDir],
      isSandboxed,
      emitFileEdit: (e) => this.userInteraction.emitFileDelta(sessionId, workerId, e),
      emitFileComplete: (e) => this.userInteraction.emitFileComplete(sessionId, workerId, e),
      recordChange: (c) => this.sessionState.recordChange(sessionId, c),
    };

    const messages: InternalMessage[] = [{ role: "user", content: userMessage }];
    const resolvedReasoningLevel = reasoningLevel === "auto"
      ? this.routingService.classifyDomain(userMessage)
      : reasoningLevel;

    try {
      let turnCount = 0;
      const maxTurns = 25;

      while (turnCount < maxTurns) {
        turnCount++;
        const success = await this.processWorkerTurn(
          sessionId,
          workerId,
          modelId,
          provider,
          messages,
          ctx,
          resolvedReasoningLevel
        );
        
        if (!success) break;
      }

      this.activeWorkers.delete(workerId);
      return { success: true, workerMessages: messages };
    } catch (err: unknown) {
      this.activeWorkers.delete(workerId);
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  /**
   * Process a single worker turn
   */
  private async processWorkerTurn(
    sessionId: string,
    workerId: string,
    modelId: string,
    provider: Provider,
    messages: InternalMessage[],
    ctx: ToolContext,
    reasoningLevel?: string
  ): Promise<boolean> {
    const normalizedReasoning = normalizeReasoningLevel(provider.name, modelId, reasoningLevel);
    const streamSignal = withTimeoutSignal(ctx.signal, AGENT.LLM_STREAM_TIMEOUT_MS);
    
    const stream = this.providers.executeWithRetry(
      {
        model: modelId,
        systemPrompt: "You are a specialist Worker Agent. EXECUTE the assigned task using tools. QUALITY FIRST. VERIFY.",
        messages: toProviderMessages(messages),
        tools: this.tools.getToolDefsForRole("worker"),
        maxTokens: 16384,
        signal: streamSignal,
        ...(normalizedReasoning !== undefined && { reasoningLevel: normalizedReasoning }),
      },
      provider.name
    );

    let assistantContent = "";
    const pendingToolCalls = new Map<string, { name: string; input: string }>();
    const completedToolCalls: CompletedToolCall[] = [];

    for await (const event of stream) {
      if (event.type === "error") {
        throw new Error(event.error ?? "LLM stream error");
      }
      
      if (event.type === "content_delta") {
        const contentDelta = event.content ?? "";
        assistantContent += contentDelta;
        this.userInteraction.emitStreamDelta(sessionId, workerId, contentDelta, modelId);
      } else if (event.type === "usage_update") {
        this.userInteraction.emitUsage(
          sessionId,
          workerId,
          modelId,
          provider.name,
          event.tokensIn ?? 0,
          event.tokensOut ?? 0,
          true
        );
      } else if (event.type === "tool_use_start") {
        pendingToolCalls.set(event.toolCallId!, { name: event.toolName!, input: "" });
        this.userInteraction.emitToolCall(sessionId, workerId, { id: event.toolCallId!, name: event.toolName!, input: {} });
      } else if (event.type === "tool_use_delta") {
        const tc = pendingToolCalls.get(event.toolCallId!);
        if (tc) tc.input += event.toolInput ?? "";
      } else if (event.type === "tool_use_stop") {
        const call = pendingToolCalls.get(event.toolCallId!);
        if (call) {
          let parsedInput = {};
          try {
            parsedInput = JSON.parse(call.input || "{}");
          } catch {
            koryLog.debug({ input: call.input }, "Malformed tool input JSON");
          }
          completedToolCalls.push({ id: event.toolCallId!, name: call.name, input: parsedInput });
          pendingToolCalls.delete(event.toolCallId!);
        }
      }
    }

    messages.push({
      role: "assistant",
      content: assistantContent,
      tool_calls: completedToolCalls.length ? completedToolCalls.map((tc) => ({ id: tc.id, name: tc.name, input: tc.input })) : undefined,
    });

    if (completedToolCalls.length === 0) {
      return false; // No tool calls, turn complete
    }

    // Execute tool calls
    for (const tc of completedToolCalls) {
      const result = await this.tools.execute(ctx, { id: tc.id, name: tc.name, input: tc.input });
      this.userInteraction.emitToolResult(sessionId, workerId, result);
      messages.push({ role: "tool", content: JSON.stringify(result), tool_call_id: tc.id });
    }

    return true; // Continue to next turn
  }

  /**
   * Cleanup worktree after worker completion
   */
  private async cleanupWorktree(taskId: string, success: boolean): Promise<void> {
    if (!this.workspaceManager) return;

    try {
      if (success) {
        const reconcileResult = await this.workspaceManager.reconcile(taskId);
        if (!reconcileResult.success) {
          koryLog.warn({ taskId, msg: reconcileResult.message }, "Worktree reconcile failed");
        }
      } else {
        await this.workspaceManager.cleanup(taskId);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      koryLog.warn({ taskId, err: message }, "Worktree cleanup/reconcile error");
    }
  }

  /**
   * Resolve domain from hint or classify from message
   */
  private resolveDomain(message: string, domainHint?: string): WorkerDomain {
    if (domainHint && ["general", "ui", "backend", "test", "review"].includes(domainHint)) {
      return domainHint as WorkerDomain;
    }
    return this.routingService.classifyDomain(message);
  }

  /**
   * Format worker messages to transcript
   */
  private formatTranscript(messages?: InternalMessage[]): string {
    if (!messages) return "Worker completed.";
    return messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
  }

  /**
   * Cancel all workers for a session
   */
  cancelSessionWorkers(sessionId: string): void {
    for (const [workerId, worker] of this.activeWorkers) {
      if (worker.sessionId === sessionId) {
        worker.abort.abort();
        this.activeWorkers.delete(workerId);
      }
    }
  }

  /**
   * Cancel all workers
   */
  cancelAll(): void {
    for (const [, worker] of this.activeWorkers) {
      worker.abort.abort();
    }
    this.activeWorkers.clear();
  }

  /**
   * Cancel a specific worker by ID
   */
  cancelWorker(workerId: string): void {
    const worker = this.activeWorkers.get(workerId);
    if (worker) {
      worker.abort.abort();
      this.activeWorkers.delete(workerId);
      koryLog.info({ workerId, sessionId: worker.sessionId }, "Worker cancelled");
    }
  }

  /**
   * Get status of all active workers
   */
  getStatus(): Array<{ id: string; agent: AgentIdentity; status: AgentStatus; sessionId: string }> {
    return Array.from(this.activeWorkers.entries()).map(([id, worker]) => ({
      id,
      agent: worker.agent,
      status: worker.status,
      sessionId: worker.sessionId,
    }));
  }

}
