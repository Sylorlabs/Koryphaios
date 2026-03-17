// TaskPlanningService - Decomposes complex tasks into parallel subtasks
// Enables multi-worker parallel execution for complex multi-domain tasks

import type { ProviderRegistry, Provider } from "../../providers";
import type { WorkerDomain } from "@koryphaios/shared";
import { RoutingService } from "./RoutingService";
import { koryLog } from "../../logger";

export interface SubTask {
  id: string;
  description: string;
  domain: WorkerDomain;
  dependencies: string[]; // IDs of subtasks that must complete before this one
  estimatedComplexity: "low" | "medium" | "high";
}

export interface TaskPlan {
  canParallelize: boolean;
  subtasks: SubTask[];
  reasoning: string;
}

export interface ParallelWorkerResult {
  subtaskId: string;
  success: boolean;
  output: string;
  error?: string;
}

export class TaskPlanningService {
  private routingService: RoutingService;

  constructor(
    private providers: ProviderRegistry,
    config: { fallbacks?: Record<string, string[]> }
  ) {
    this.routingService = new RoutingService(providers, { 
      fallbacks: config.fallbacks ?? {},
      assignments: {},
      agents: {
        manager: { model: 'claude-3-7-sonnet', reasoningLevel: 'high' },
        coder: { model: 'claude-3-7-sonnet', maxTokens: 16384 },
        task: { model: 'gpt-4o-mini', maxTokens: 8192 }
      },
    });
  }

  /**
   * Analyze a task and create a parallel execution plan if possible
   */
  async createExecutionPlan(
    sessionId: string,
    task: string,
    provider: Provider,
    modelId: string
  ): Promise<TaskPlan> {
    const planningPrompt = `You are a task decomposition specialist. Analyze the following task and determine if it can be broken down into independent subtasks that can execute in parallel.

Task: "${task}"

Rules for decomposition:
1. Split by domain: UI, backend, tests, and documentation can often be done in parallel
2. Split by file: Independent files can be worked on simultaneously
3. Consider dependencies: Some tasks must wait for others (e.g., tests need code first)

Respond with a JSON object in this exact format:
{
  "canParallelize": true|false,
  "reasoning": "Brief explanation of your decomposition strategy",
  "subtasks": [
    {
      "id": "unique-id-1",
      "description": "Specific, actionable subtask description",
      "domain": "ui|backend|test|review|general",
      "dependencies": [],
      "estimatedComplexity": "low|medium|high"
    }
  ]
}

Guidelines:
- If the task is simple (single file, single domain), set canParallelize: false
- If the task spans multiple domains (e.g., "create a form with API endpoint"), split it
- Each subtask should be self-contained and actionable
- Use dependencies to order tasks that must happen sequentially`;

    try {
      const stream = provider.streamResponse({
        model: modelId,
        systemPrompt: planningPrompt,
        messages: [{ role: "user", content: "Create an execution plan for this task." }],
        maxTokens: 4096,
      });

      let response = "";
      for await (const event of stream) {
        if (typeof event === "object" && event !== null) {
          if ((event as any).type === "content_delta") {
            response += (event as any).content ?? "";
          } else if ((event as any).type === "error") {
            throw new Error((event as any).error ?? "Planning stream error");
          }
        }
      }

      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = response.match(/```json\s*([\s\S]*?)```/) || 
                        response.match(/```\s*([\s\S]*?)```/) ||
                        [null, response];
      
      const jsonStr = jsonMatch[1]?.trim() ?? response.trim();
      const plan = JSON.parse(jsonStr) as TaskPlan;

      // Validate plan structure
      if (!plan.subtasks || !Array.isArray(plan.subtasks)) {
        return { canParallelize: false, subtasks: [], reasoning: "Invalid plan structure" };
      }

      // Validate subtasks
      const validDomains: WorkerDomain[] = ["ui", "backend", "test", "review", "general"];
      plan.subtasks = plan.subtasks.filter(st => 
        st.id && 
        st.description && 
        validDomains.includes(st.domain) &&
        Array.isArray(st.dependencies)
      );

      // If only one valid subtask, no parallelization benefit
      if (plan.subtasks.length <= 1) {
        plan.canParallelize = false;
      }

      koryLog.info({ 
        sessionId, 
        canParallelize: plan.canParallelize, 
        subtaskCount: plan.subtasks.length 
      }, "Task plan created");

      return plan;
    } catch (err) {
      koryLog.warn({ sessionId, error: String(err) }, "Task planning failed, falling back to single worker");
      return { 
        canParallelize: false, 
        subtasks: [], 
        reasoning: "Planning failed, executing as single task" 
      };
    }
  }

  /**
   * Group subtasks by their dependency level for parallel execution
   */
  groupByExecutionLevel(subtasks: SubTask[]): SubTask[][] {
    const completed = new Set<string>();
    const levels: SubTask[][] = [];
    const remaining = new Set(subtasks.map(st => st.id));

    while (remaining.size > 0) {
      const currentLevel: SubTask[] = [];
      
      for (const subtask of subtasks) {
        if (!remaining.has(subtask.id)) continue;
        
        // Check if all dependencies are completed
        const depsSatisfied = subtask.dependencies.every(dep => completed.has(dep));
        if (depsSatisfied) {
          currentLevel.push(subtask);
        }
      }

      if (currentLevel.length === 0) {
        // Circular dependency or missing dependency - force remaining to next level
        for (const id of remaining) {
          const st = subtasks.find(s => s.id === id);
          if (st) currentLevel.push(st);
        }
      }

      // Mark current level as completed
      for (const st of currentLevel) {
        completed.add(st.id);
        remaining.delete(st.id);
      }

      if (currentLevel.length > 0) {
        levels.push(currentLevel);
      }
    }

    return levels;
  }

  /**
   * Check if a task is complex enough to benefit from parallelization
   */
  shouldPlanTask(task: string): boolean {
    // Indicators of complexity that benefit from planning
    const complexityIndicators = [
      " and ", " also ", " then ", " additionally ",
      "frontend", "backend", "ui", "api", "database",
      "component", "endpoint", "test", "documentation",
      "refactor", "implement", "create", "build",
      "multiple", "several", "various"
    ];
    
    const lowerTask = task.toLowerCase();
    const indicatorCount = complexityIndicators.filter(ind => 
      lowerTask.includes(ind)
    ).length;
    
    // High word count also suggests complexity
    const wordCount = task.split(/\s+/).length;
    
    return indicatorCount >= 2 || wordCount > 15;
  }
}
