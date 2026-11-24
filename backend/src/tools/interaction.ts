import { normalizeFallbackStepsInput } from '../kory/fallback-chain-input';
import type { Tool, ToolContext, ToolCallInput, ToolCallOutput } from './registry';
import { serverLog } from '../logger';
import { normalizeSkillAssignment } from '../kory/skill-assignment';
import { normalizeCompareGroupId } from '../kory/async-children';

/**
 * Tool for the Manager to ask the user a question with predefined options.
 * Blocks execution until the user responds.
 */
export class RequestCriticReviewTool implements Tool {
  readonly name = 'request_critic_review';
  readonly role = 'manager' as const;
  readonly description =
    'In Critic Auto mode, request an independent Critic review of your proposed answer when its claims, correctness, or risk would benefit from separate verification. Do not call for trivial checks, readiness tests, simple acknowledgements, or routine low-risk replies. Use only when you can state a concrete review concern; this records a concern for the decision prompt at the end of your turn and has no effect in Always or Off modes. You make the final yes or no decision then and choose an enabled Critic model if yes. To rank the attempts of a multi-model comparison, pass the compareGroupId you gave those delegate_to_worker calls as compare.groupId; the Critic then ranks them.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      reason: { type: 'string', minLength: 1, maxLength: 500, description: 'Specific reason an independent review is valuable for this response.' },
      compareGroupId: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        description: 'Optional compare group (compare.groupId of delegate_to_worker) whose attempts the Critic should rank.',
      },
    },
    required: ['reason'],
    additionalProperties: false,
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const reason = typeof call.input.reason === 'string' ? call.input.reason.trim() : '';
    if (!reason || reason.length > 500) {
      return { callId: call.id, name: this.name, output: 'Provide a concrete review reason of 1-500 characters.', isError: true, durationMs: 0 };
    }
    let compareGroupId: string | undefined;
    if (call.input.compareGroupId !== undefined) {
      compareGroupId = normalizeCompareGroupId(call.input.compareGroupId);
      if (!compareGroupId) {
        return { callId: call.id, name: this.name, output: 'compareGroupId must be a 1-64 character token such as "auth-models".', isError: true, durationMs: 0 };
      }
    }
    if (!ctx.requestCriticReview) {
      return { callId: call.id, name: this.name, output: 'Manager review selection is unavailable in this context.', isError: true, durationMs: 0 };
    }
    ctx.requestCriticReview(reason, compareGroupId);
    return {
      callId: call.id,
      name: this.name,
      output: compareGroupId
        ? `Review concern recorded with compare group ${compareGroupId}. The finishing agent will decide whether to invoke a Critic at the end of the turn, and a Critic that runs will rank that group's attempts.`
        : 'Review concern recorded. The finishing agent will decide whether to invoke a Critic at the end of the turn.',
      isError: false,
      durationMs: 0,
    };
  }
}

export interface AskUserPrompt {
  question: string;
  options: string[];
}

const ASK_USER_OTHER_OPTION = /^\s*(other|something else)\b/i;
const ASK_USER_MAX_OPTIONS = 8;
const ASK_USER_STOP_ANSWERS = new Set(['__cancelled__', '__timeout__']);

function normalizeAskUserOptions(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const options: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    let option: string | null = null;
    if (typeof item === 'string') {
      option = item.trim();
    } else if (typeof item === 'object' && item !== null) {
      const record = item as Record<string, unknown>;
      for (const key of ['label', 'value', 'title', 'text', 'option']) {
        const candidate = record[key];
        if (typeof candidate === 'string' && candidate.trim()) {
          option = candidate.trim();
          break;
        }
      }
    }
    if (!option || ASK_USER_OTHER_OPTION.test(option)) continue;
    const dedupeKey = option.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    options.push(option);
    if (options.length >= ASK_USER_MAX_OPTIONS) break;
  }
  return options;
}

function askUserQuestionText(entry: unknown, keys: string[]): string | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const record = entry as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

/**
 * Normalize the agent-supplied ask_user input into concrete prompts. Accepts
 * the plain `{ question, options }` shape and the Claude Code AskUserQuestion
 * `{ questions: [{ question, header?, options: [{ label, description }] }] }`
 * shape so a CLI-native call still lands on the durable question UI.
 */
export function normalizeAskUserInput(input: unknown): AskUserPrompt[] {
  const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  if (Array.isArray(record.questions)) {
    const prompts: AskUserPrompt[] = [];
    for (const entry of record.questions) {
      const question = askUserQuestionText(entry, ['question', 'prompt', 'text']);
      if (!question) continue;
      const options =
        typeof entry === 'object' && entry !== null
          ? normalizeAskUserOptions((entry as Record<string, unknown>).options)
          : [];
      prompts.push({ question, options });
    }
    return prompts;
  }
  const question = askUserQuestionText(record, ['question']);
  if (!question) return [];
  return [{ question, options: normalizeAskUserOptions(record.options) }];
}

/**
 * Runs the normalized ask_user flow: sequential questions, always answerable
 * with a custom response or a keep-chatting defer. Shared by the first-party
 * AskUserTool, the manager intercept, and the CLI MCP-bridge path (whose
 * waitForUserInput defaults both UI affordances off for binary approvals).
 */
export async function runAskUser(
  callId: string,
  name: string,
  input: unknown,
  wait: (
    question: string,
    options: string[],
    opts: { allowOther: boolean; allowKeepChatting: boolean },
  ) => Promise<string>,
): Promise<ToolCallOutput> {
  const prompts = normalizeAskUserInput(input);
  if (prompts.length === 0) {
    return {
      callId,
      name,
      output:
        'ask_user needs { "question": string, "options"?: string[] }. Example: {"question":"Which database should I use?","options":["SQLite (Recommended)","Postgres"]}',
      isError: true,
      durationMs: 0,
    };
  }
  const answered: { question: string; answer: string }[] = [];
  try {
    for (const prompt of prompts) {
      const answer = await wait(prompt.question, prompt.options, {
        allowOther: true,
        allowKeepChatting: true,
      });
      answered.push({ question: prompt.question, answer });
      if (ASK_USER_STOP_ANSWERS.has(answer)) break;
    }
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'ask_user: error waiting for user input',
    );
    return {
      callId,
      name,
      output: `Error waiting for user input: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
      durationMs: 0,
    };
  }
  const output =
    answered.length === 1
      ? `User selected: ${answered[0]!.answer}`
      : answered
          .map((entry) => `Q: ${entry.question}\nUser selected: ${entry.answer}`)
          .join('\n\n');
  return { callId, name, output, isError: false, durationMs: 0 };
}

export class AskUserTool implements Tool {
  readonly name = 'ask_user';
  readonly role = 'manager' as const;
  readonly description =
    "Ask the user a question and wait for their answer. Use it whenever you are unsure, the request is ambiguous, or a decision would materially change the result. Provide 2-4 short options with your recommendation first; the UI always offers a custom-answer box, so do not add an 'Other' option.";
  readonly inputSchema = {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: '2-4 short answer choices, recommended first',
      },
    },
    required: ['question'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    if (!ctx.waitForUserInput) {
      return {
        callId: call.id,
        name: this.name,
        output: 'Error: User input system not available in this context.',
        isError: true,
        durationMs: 0,
      };
    }
    return runAskUser(call.id, this.name, call.input, ctx.waitForUserInput);
  }
}

/**
 * Tool for the Manager to delegate a task to a specialist worker (coder agent).
 * Sub-agents run only when the manager explicitly calls this tool—never automatically.
 */
export class DelegateToWorkerTool implements Tool {
  readonly name = 'delegate_to_worker';
  /** Any role: the manager delegates, and a worker may delegate one level further
   *  (see MAX_DELEGATION_DEPTH). The host grant decides who actually can. */
  readonly role = 'any' as const;
  readonly description =
    'Delegate a task to a specialist worker (sub-agent) only when you have explicitly decided that the task needs one. ' +
    'Pass model as provider:model to use any connected, chat-capable model; the host rejects an unconnected model and lists the closest connected ones. ' +
    'Omit model and the host picks from the user\'s category pool for this domain, preferring an identity independent from the manager; if the pool holds only the manager model it reuses it and discloses the lack of independence. ' +
    'wait defaults to true: the call returns the worker result. With wait:false the call returns at once with an agentId, you keep working, and the result arrives later as a host message; join early with wait_for_agents. ' +
    'compare.groupId runs the same task again under another model: send N calls with the same task, different models, worktree:true and one shared groupId; their results come back together, and request_critic_review with that compareGroupId ranks them. Offer a comparison to the user for a large or ambiguous task before starting one. ' +
    'Provide a clear, self-contained task description and the most accurate domain hint.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Clear task description for the worker' },
      domain: { type: 'string', description: 'Optional: ui | backend | general | test | review' },
      workerSkills: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Exact installed skill names required for the worker. Missing or conflicting skills block execution.',
      },
      model: {
        type: 'string',
        description:
          'Optional provider:model for any connected, chat-capable model. Omit to use the domain pool default. An unconnected model is rejected with the closest connected matches.',
      },
      reasoningLevel: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'xhigh'],
        description: 'Optional reasoning effort for this worker turn.',
      },
      worktree: {
        type: 'boolean',
        description:
          'Whether this worker gets its own Git worktree, which starts from the last commit and cannot see uncommitted work. Use false for read-only research, a single focused edit, or work that depends on uncommitted changes in the chat checkout; true for parallel or risky edits. Required unless the chat Worktree setting is Always or Never, which overrides it. Compare attempts must use true.',
      },
      wait: {
        type: 'boolean',
        description:
          'Default true: return the worker result in this call. false: return immediately with an agentId and deliver the result later as a host message, so you can keep working. Join with wait_for_agents.',
      },
      compare: {
        type: 'object',
        description:
          'Group this attempt with other attempts at the same task under different models. Results come back grouped and request_critic_review can rank the group.',
        properties: {
          groupId: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            description: 'Short token shared by every attempt in one comparison, e.g. "auth-models".',
          },
        },
        required: ['groupId'],
        additionalProperties: false,
      },
      fallbacks: {
        type: 'array',
        maxItems: 20,
        description:
          'Ordered fallback models tried only when the primary worker fails because its provider is unavailable or rate limited. Each step may set its own reasoning level.',
        items: {
          type: 'object',
          properties: {
            provider: { type: 'string', description: 'Provider name, e.g. anthropic or openai.' },
            model: { type: 'string', description: 'Fallback model id. A legacy provider:model string is also accepted.' },
            reasoningLevel: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'] },
            label: { type: 'string', description: 'Optional display name for this step.' },
          },
          required: ['model'],
          additionalProperties: false,
        },
      },
      criticSkills: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Exact installed skills required for the independent critic, in addition to verification guidance.',
      },
    },
    required: ['task'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const { task, domain, model, reasoningLevel, worktree } = call.input as {
      task: string;
      domain?: string;
      model?: string;
      reasoningLevel?: string;
      worktree?: boolean;
    };
    // Current `{provider, model, reasoningLevel, label}` steps and the legacy
    // `{ model: 'provider:model' }` form both normalize to the chain step type.
    const fallbacks = Array.isArray(call.input.fallbacks)
      ? normalizeFallbackStepsInput(call.input.fallbacks)
      : undefined;
    if (!task || typeof task !== 'string' || !task.trim()) {
      return {
        callId: call.id,
        name: this.name,
        output: 'Error: task is required.',
        isError: true,
        durationMs: 0,
      };
    }
    const wait = typeof call.input.wait === 'boolean' ? call.input.wait : true;
    let compareGroupId: string | undefined;
    if (call.input.compare !== undefined) {
      const compare = call.input.compare as { groupId?: unknown } | null;
      compareGroupId = normalizeCompareGroupId(compare?.groupId);
      if (!compareGroupId) {
        return {
          callId: call.id,
          name: this.name,
          output: 'Error: compare.groupId must be a 1-64 character token such as "auth-models".',
          isError: true,
          durationMs: 0,
        };
      }
      if (worktree === false) {
        return {
          callId: call.id,
          name: this.name,
          output:
            'Error: compare attempts need worktree:true so parallel attempts cannot overwrite each other in one checkout.',
          isError: true,
          durationMs: 0,
        };
      }
    }
    if (!ctx.delegateToWorker) {
      const role = ctx.callerRole ?? 'unknown';
      // Plan mode is a planning posture, not a delegation veto. A manager may
      // delegate investigation while planning; only the host grant controls
      // whether delegation is bound at all.
      const reason =
        role === 'worker'
          ? 'workers at the maximum delegation depth cannot start sub-agents'
          : role !== 'manager'
            ? `caller role is '${role}' (delegation requires the manager or a worker below the depth limit)`
            : 'no host delegation grant is bound to this session';
      return {
        callId: call.id,
        name: this.name,
        output: `Error: Delegation not available in this context (${reason}).`,
        isError: true,
        durationMs: 0,
      };
    }
    try {
      const skills = normalizeSkillAssignment({
        worker: call.input.workerSkills,
        critic: call.input.criticSkills,
      });
      const result = await ctx.delegateToWorker(
        task.trim(),
        domain,
        skills,
        model,
        reasoningLevel,
        typeof worktree === 'boolean' ? worktree : undefined,
        fallbacks,
        { wait, ...(compareGroupId ? { compareGroupId } : {}) },
      );
      // A compare attempt carries a group header before the worker's own marker.
      const failed =
        typeof result === 'string' && /^(\[compare [^\]]*\]\n)?WORKER_FAILED/.test(result);
      return {
        callId: call.id,
        name: this.name,
        output: result,
        isError: failed,
        durationMs: 0,
      };
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'delegate_to_worker: delegation failed',
      );
      return {
        callId: call.id,
        name: this.name,
        output: `Delegation failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
        durationMs: 0,
      };
    }
  }
}

/**
 * Join worker agents started with delegate_to_worker wait:false. Finished
 * results are returned here and are not repeated in a later host message.
 */
export class WaitForAgentsTool implements Tool {
  readonly name = 'wait_for_agents';
  readonly role = 'manager' as const;
  readonly description =
    'Wait for background workers you started with delegate_to_worker wait:false. Omit agentIds to wait for every outstanding worker. Returns finished results; anything still running after timeoutSec is reported and will still arrive as a host message.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      agentIds: {
        type: 'array',
        maxItems: 50,
        items: { type: 'string' },
        description: 'agentIds returned by delegate_to_worker. Omit to wait for all outstanding workers.',
      },
      timeoutSec: {
        type: 'number',
        minimum: 1,
        maximum: 1800,
        description: 'How long to wait before returning. Default 300.',
      },
    },
    additionalProperties: false,
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    if (!ctx.waitForAgents) {
      return {
        callId: call.id,
        name: this.name,
        output: 'Error: wait_for_agents is not available in this context.',
        isError: true,
        durationMs: 0,
      };
    }
    const rawIds = call.input.agentIds;
    if (rawIds !== undefined && !Array.isArray(rawIds)) {
      return { callId: call.id, name: this.name, output: 'Error: agentIds must be an array of strings.', isError: true, durationMs: 0 };
    }
    const agentIds = Array.isArray(rawIds)
      ? rawIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim())
      : undefined;
    const timeoutRaw = call.input.timeoutSec;
    const timeoutSec =
      typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw)
        ? Math.min(1800, Math.max(1, timeoutRaw))
        : undefined;
    try {
      const output = await ctx.waitForAgents({ ...(agentIds ? { agentIds } : {}), ...(timeoutSec ? { timeoutSec } : {}) });
      return { callId: call.id, name: this.name, output, isError: false, durationMs: 0 };
    } catch (err: unknown) {
      return {
        callId: call.id,
        name: this.name,
        output: `wait_for_agents failed: ${err instanceof Error ? err.message : String(err)}`,
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
    if (ctx.requestManagerInput) {
      const output = await ctx.requestManagerInput(String(call.input.question ?? ''));
      return { callId: call.id, name: this.name, output, isError: false, durationMs: 0 };
    }
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
