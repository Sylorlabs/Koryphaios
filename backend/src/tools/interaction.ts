import type { Tool, ToolContext, ToolCallInput, ToolCallOutput } from './registry';

/**
 * Tool for the Manager to ask the user a question with predefined options.
 * Blocks execution until the user responds.
 */
export class AskUserTool implements Tool {
  readonly name = 'ask_user';
  readonly role = 'manager' as const;
  readonly description =
    "Ask the user a question and provide multiple options for them to choose from. Use this when you need user guidance, approval, or clarification on how to proceed. Always include an 'Other' option.";
  readonly inputSchema = {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description:
          "List of options for the user to choose from (e.g. ['Apply changes', 'Discard changes', 'Other...'])",
      },
    },
    required: ['question', 'options'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const { question, options } = call.input as { question: string; options: string[] };

    if (!ctx.waitForUserInput) {
      return {
        callId: call.id,
        name: this.name,
        output: 'Error: User input system not available in this context.',
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
  readonly name = 'delegate_to_worker';
  readonly role = 'manager' as const;
  readonly description =
    'Delegate a task to a specialist worker (sub-agent) only when you have explicitly decided that the task needs a dedicated coder and cannot be handled by you. Sub-agents (general, ui, backend, test, review) run only when you call this tool—never for conversation, clarification, or small edits. Use only for substantial implementation, refactoring, or multi-file work. Provide a clear, self-contained task description. Optional: domain hint (ui | backend | general | test | review).';
  readonly inputSchema = {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Clear task description for the worker' },
      domain: { type: 'string', description: 'Optional: ui | backend | general | test | review' },
    },
    required: ['task'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const { task, domain } = call.input as { task: string; domain?: string };
    if (!task || typeof task !== 'string' || !task.trim()) {
      return {
        callId: call.id,
        name: this.name,
        output: 'Error: task is required.',
        isError: true,
        durationMs: 0,
      };
    }
    if (!ctx.delegateToWorker) {
      return {
        callId: call.id,
        name: this.name,
        output: 'Error: Delegation not available in this context.',
        isError: true,
        durationMs: 0,
      };
    }
    try {
      const result = await ctx.delegateToWorker(task.trim(), domain);
      return { callId: call.id, name: this.name, output: result, isError: false, durationMs: 0 };
    } catch (err: any) {
      return {
        callId: call.id,
        name: this.name,
        output: `Delegation failed: ${err.message ?? String(err)}`,
        isError: true,
        durationMs: 0,
      };
    }
  }
}

/**
 * Tool for Workers to ask the Manager for help or clarification.
 * This will trigger the Manager to perform reasoning or web search.
 */
export class AskManagerTool implements Tool {
  readonly name = 'ask_manager';
  readonly role = 'worker' as const;
  readonly description =
    'Ask the Manager for help, clarification, or professional advice when you are confused. You can also use this to REQUEST that the Manager asks the User a question if you believe user input is required for a project-level decision.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The specific question or problem you need help with',
      },
    },
    required: ['question'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    // The actual execution of this tool is handled as an intercept in KoryManager's loop
    // to allow the Manager to take over. We return a structured signal.
    return {
      callId: call.id,
      name: this.name,
      output: JSON.stringify({
        type: 'INTERVENTION_REQUEST',
        question: (call.input as any).question,
      }),
      isError: false,
      durationMs: 0,
    };
  }
}

/**
 * Tool for the Manager to hide messages from its own context window to free up space.
 * Hidden messages are stored in the DB and can be recalled at any time.
 */
export class HideContextTool implements Tool {
  readonly name = 'hide_context';
  readonly role = 'manager' as const;
  readonly description =
    "Remove messages from your active context window to reduce token usage. Hidden messages are preserved in storage and can be recalled at any time with recall_context. Use 'tool_results' to hide all stored tool outputs, or 'all' to hide all prior conversation history.";
  readonly inputSchema = {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['tool_results', 'all'],
        description: "'tool_results' hides all tool call outputs; 'all' hides the entire prior conversation",
      },
    },
    required: ['scope'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const start = Date.now();
    const { scope } = call.input as { scope: 'tool_results' | 'all' };

    if (!ctx.hideContext) {
      return { callId: call.id, name: this.name, output: 'Context management not available.', isError: true, durationMs: 0 };
    }

    try {
      const hiddenIds = await ctx.hideContext(scope);
      return {
        callId: call.id,
        name: this.name,
        output: `Hidden ${hiddenIds.length} message(s) from context (scope: ${scope}). Use recall_context to restore them.`,
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return { callId: call.id, name: this.name, output: `Error: ${err.message}`, isError: true, durationMs: Date.now() - start };
    }
  }
}

/**
 * Tool for the Manager to restore previously hidden messages back into its context window.
 */
export class RecallContextTool implements Tool {
  readonly name = 'recall_context';
  readonly role = 'manager' as const;
  readonly description =
    "Restore messages that were previously hidden from your context window using hide_context. Use 'tool_results' to restore only tool outputs, or 'all' to restore everything. Restored messages will be included in your context on the next turn.";
  readonly inputSchema = {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['tool_results', 'all'],
        description: "'tool_results' restores hidden tool outputs; 'all' restores the full conversation history",
      },
    },
    required: ['scope'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const start = Date.now();
    const { scope } = call.input as { scope: 'tool_results' | 'all' };

    if (!ctx.recallContext) {
      return { callId: call.id, name: this.name, output: 'Context management not available.', isError: true, durationMs: 0 };
    }

    try {
      await ctx.recallContext(scope === 'all' ? 'all' : 'tool_results');
      return {
        callId: call.id,
        name: this.name,
        output: `Restored ${scope} messages to context. They will be included starting from the next turn.`,
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return { callId: call.id, name: this.name, output: `Error: ${err.message}`, isError: true, durationMs: Date.now() - start };
    }
  }
}
