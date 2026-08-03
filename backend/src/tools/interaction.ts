import type { Tool, ToolContext, ToolCallInput, ToolCallOutput } from './registry';
import type { KoryQuestionChart, KoryQuestionSlider } from '@koryphaios/shared';

/**
 * Tool for the Manager to ask the user a question with predefined options.
 * Blocks execution until the user responds.
 */
export class AskUserTool implements Tool {
  readonly name = 'ask_user';
  readonly role = 'manager' as const;
  readonly description =
    'Ask the user a focused question with suggested choices. Koryphaios always adds Custom response and Keep chatting actions. When quantities or comparisons materially improve the decision, you may also provide sliders and one relevant bar, line, or pie chart. Do not add decorative charts.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Two to five concise suggested choices (e.g. ['Apply changes', 'Discard changes']). Do not add Other or Custom; the UI provides it.",
      },
      chart: {
        type: 'object',
        description: 'Optional evidence chart that directly informs the question.',
        properties: {
          type: { type: 'string', enum: ['bar', 'line', 'pie'] },
          title: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } },
          datasets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                data: { type: 'array', items: { type: 'number' } },
              },
              required: ['data'],
            },
          },
        },
        required: ['type', 'labels', 'datasets'],
      },
      sliders: {
        type: 'array',
        description: 'Optional quantitative inputs. Use only when the user is choosing numeric values.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            min: { type: 'number' },
            max: { type: 'number' },
            step: { type: 'number' },
            value: { type: 'number' },
            unit: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['id', 'label', 'min', 'max', 'step', 'value'],
        },
      },
    },
    required: ['question', 'options'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const { question, options, chart, sliders } = call.input;

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
      const selection = await ctx.waitForUserInput(question as string, options as string[], {
        chart: chart as KoryQuestionChart | undefined,
        sliders: sliders as KoryQuestionSlider[] | undefined,
        allowKeepChatting: true,
      });
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
    'Delegate a task to a specialist worker (sub-agent) only when you have explicitly decided that the task needs one. The user manually selects the manager and configures the eligible model pool for each subagent category; Kory chooses only within that pool, preferring an identity independent from the manager. If the pool contains only the manager model, reuse it and disclose the lack of independence rather than blocking. Sub-agents (general, ui, backend, test, review) run only when you call this tool. Provide a clear, self-contained task description and the most accurate domain hint so the correct user-enabled pool is used.';
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
