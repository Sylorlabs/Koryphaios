import type { Tool, ToolContext, ToolCallInput, ToolCallOutput } from "./registry";

/**
 * Tool for the Manager to ask the user a question with predefined options.
 * Blocks execution until the user responds.
 */
export class AskUserTool implements Tool {
  readonly name = "ask_user";
  readonly role = "manager" as const;
  readonly description = "Ask the user a question and provide multiple options for them to choose from. Use this when you need user guidance, approval, or clarification on how to proceed. Always include an 'Other' option.";
  readonly inputSchema = {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to ask the user" },
      options: { 
        type: "array", 
        items: { type: "string" }, 
        description: "List of options for the user to choose from (e.g. ['Apply changes', 'Discard changes', 'Other...'])" 
      },
    },
    required: ["question", "options"],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const { question, options } = call.input as { question: string; options: string[] };

    if (!ctx.waitForUserInput) {
      return {
        callId: call.id,
        name: this.name,
        output: "Error: User input system not available in this context.",
        isError: true,
        durationMs: 0,
      };
    }

    try {
      const selection = await ctx.waitForUserInput(question, options);
      return {
        callId: call.id,
        name: this.name,
        output: `User selected: ${selection}`,
        isError: false,
        durationMs: 0,
      };
    } catch (err: any) {
      return {
        callId: call.id,
        name: this.name,
        output: `Error waiting for user input: ${err.message}`,
        isError: true,
        durationMs: 0,
      };
    }
  }
}

/**
 * Tool for the Manager to delegate a task to a specialist worker (coder agent).
 * Sub-agents run only when the manager explicitly calls this tool—never automatically.
 */
export class DelegateToWorkerTool implements Tool {
  readonly name = "delegate_to_worker";
  readonly role = "manager" as const;
  readonly description = "Delegate a task to a specialist worker (sub-agent) only when you have explicitly decided that the task needs a dedicated coder and cannot be handled by you. Sub-agents (general, ui, backend, test, review) run only when you call this tool—never for conversation, clarification, or small edits. Use only for substantial implementation, refactoring, or multi-file work. Provide a clear, self-contained task description. Optional: domain hint (ui | backend | general | test | review).";
  readonly inputSchema = {
    type: "object",
    properties: {
      task: { type: "string", description: "Clear task description for the worker" },
      domain: { type: "string", description: "Optional: ui | backend | general | test | review" },
    },
    required: ["task"],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const { task, domain } = call.input as { task: string; domain?: string };
    if (!task || typeof task !== "string" || !task.trim()) {
      return { callId: call.id, name: this.name, output: "Error: task is required.", isError: true, durationMs: 0 };
    }
    if (!ctx.delegateToWorker) {
      return { callId: call.id, name: this.name, output: "Error: Delegation not available in this context.", isError: true, durationMs: 0 };
    }
    try {
      const result = await ctx.delegateToWorker(task.trim(), domain);
      return { callId: call.id, name: this.name, output: result, isError: false, durationMs: 0 };
    } catch (err: any) {
      return { callId: call.id, name: this.name, output: `Delegation failed: ${err.message ?? String(err)}`, isError: true, durationMs: 0 };
    }
  }
}

/**
 * Tool for Workers to ask the Manager for help or clarification.
 * This will trigger the Manager to perform reasoning or web search.
 */
export class AskManagerTool implements Tool {
  readonly name = "ask_manager";
  readonly role = "worker" as const;
  readonly description = "Ask the Manager for help, clarification, or professional advice when you are confused. You can also use this to REQUEST that the Manager asks the User a question if you believe user input is required for a project-level decision.";
  readonly inputSchema = {
    type: "object",
    properties: {
      question: { type: "string", description: "The specific question or problem you need help with" },
    },
    required: ["question"],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    // The actual execution of this tool is handled as an intercept in KoryManager's loop
    // to allow the Manager to take over. If it reaches here, it means it wasn't intercepted.
    return {
      callId: call.id,
      name: this.name,
      output: `Question sent to Manager: "${(call.input as any).question}". Please wait for the Manager's response.`,
      isError: false,
      durationMs: 0,
    };
  }
}
