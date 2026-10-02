import { getContext } from '../context';
import type { GoalScope } from '@koryphaios/shared';
import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';
import { sanitizeGoalEvidence } from '../stores/goal-store';

/** Manager-only, explicit-intent boundary for agent-created durable goals. */
export class CreateGoalTool implements Tool {
  readonly name = 'create_goal';
  readonly role = 'manager' as const;
  readonly description =
    'Create a durable Goal Mode goal only when the user explicitly asks to create, track, or turn work into a goal. Never use this merely because a task sounds goal-like. Goals remain uncompleted until verified checklist evidence and final verification are recorded.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      objective: {
        type: 'string',
        maxLength: 2000,
        description: 'Concrete objective the user explicitly requested as a goal',
      },
      scope: {
        type: 'string',
        enum: ['workspace', 'project', 'session'],
        description: 'Goal ownership scope; default workspace',
      },
      planningDepth: {
        type: 'string',
        enum: ['minimal', 'adaptive', 'structured'],
        description: 'Optional checklist planning depth',
      },
    },
    required: ['objective'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const objective = typeof call.input.objective === 'string' ? call.input.objective.trim() : '';
    const scope = (call.input.scope ?? 'workspace') as GoalScope;
    const planningDepth = call.input.planningDepth as
      'minimal' | 'adaptive' | 'structured' | undefined;
    if (!objective)
      return {
        callId: call.id,
        name: this.name,
        output: 'Error: objective is required.',
        isError: true,
        durationMs: 0,
      };
    if (objective.length > 2_000)
      return {
        callId: call.id,
        name: this.name,
        output: 'Error: objective cannot exceed 2000 characters.',
        isError: true,
        durationMs: 0,
      };
    if (!['workspace', 'project', 'session'].includes(scope))
      return {
        callId: call.id,
        name: this.name,
        output: 'Error: invalid goal scope.',
        isError: true,
        durationMs: 0,
      };
    if (scope === 'project' && !ctx.workingDirectory)
      return {
        callId: call.id,
        name: this.name,
        output: 'Error: project goals require a project-scoped chat.',
        isError: true,
        durationMs: 0,
      };
    const { goals, goalDriver } = getContext();
    const goal = await goals.create({
      objective,
      scope,
      projectPath: scope === 'project' ? ctx.workingDirectory : undefined,
      sessionId: scope === 'session' ? ctx.sessionId : undefined,
      planningDepth,
    });
    await goals.addActivity(
      goal.id,
      'manager_created',
      'Goal created by Kory after explicit user request.',
      ctx.sessionId,
    );
    if (!ctx.activeProvider || !ctx.activeModel)
      return {
        callId: call.id,
        name: this.name,
        output: `Created ${scope} goal ${goal.id}: ${goal.objective}. Select a model and start it from Goal Mode.`,
        isError: false,
        durationMs: 0,
      };
    await goalDriver.start(goal.id, {
      sessionId: ctx.sessionId,
      provider: ctx.activeProvider,
      model: ctx.activeModel,
      reasoningLevel: ctx.reasoningLevel,
    });
    return {
      callId: call.id,
      name: this.name,
      output: `Created and started ${scope} goal ${goal.id}: ${goal.objective}. Goal Mode will continue through its checklist until completion, a human pause/stop, or a confirmed blocker.`,
      isError: false,
      durationMs: 0,
    };
  }
}

/** Goal-bound managers report candidate evidence or blockers; the durable driver adjudicates both. */
export class UpdateGoalTool implements Tool {
  readonly name = 'update_goal';
  readonly role = 'manager' as const;
  readonly description =
    'For an active Goal Mode turn only: report concrete completion evidence or a genuine blocker candidate. This does not itself complete or stop the goal; the durable driver and enabled Critic decide.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['evidence', 'blocked'] },
      message: {
        type: 'string',
        maxLength: 8000,
        description:
          'Concrete check/artifact result, or the exact blocker after exhausting safe alternatives',
      },
    },
    required: ['status', 'message'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const status = call.input.status;
    const message = typeof call.input.message === 'string' ? call.input.message.trim() : '';
    if (!ctx.goalId || !ctx.goalItemId)
      return {
        callId: call.id,
        name: this.name,
        output: 'Error: update_goal is only available inside an active Goal Mode turn.',
        isError: true,
        durationMs: 0,
      };
    if (!message || (status !== 'evidence' && status !== 'blocked'))
      return {
        callId: call.id,
        name: this.name,
        output: 'Error: valid status and concrete message are required.',
        isError: true,
        durationMs: 0,
      };
    if (message.length > 8_000)
      return {
        callId: call.id,
        name: this.name,
        output: 'Error: Goal evidence and blocker previews cannot exceed 8000 characters.',
        isError: true,
        durationMs: 0,
      };
    const { goals } = getContext();
    const goal = await goals.get(ctx.goalId);
    const item = goal?.checklist.find((entry) => entry.id === ctx.goalItemId);
    if (
      !goal ||
      goal.status !== 'running' ||
      item?.status !== 'running' ||
      goal.execution?.sessionId !== ctx.sessionId
    )
      return {
        callId: call.id,
        name: this.name,
        output: 'Error: this Goal Mode turn is no longer active; evidence was not recorded.',
        isError: true,
        durationMs: 0,
      };
    const type = status === 'blocked' ? 'blocker_candidate' : 'evidence_candidate';
    await goals.addActivity(
      ctx.goalId,
      type,
      `${ctx.goalItemId}|${sanitizeGoalEvidence(message)}`,
      ctx.sessionId,
    );
    return {
      callId: call.id,
      name: this.name,
      output:
        status === 'blocked'
          ? 'Blocker candidate recorded. Goal Mode will retry or adjudicate it; do not claim the goal stopped.'
          : 'Evidence candidate recorded. Goal Mode will run its quality gate; do not claim completion yet.',
      isError: false,
      durationMs: 0,
    };
  }
}

/**
 * Reshape a Goal Mode plan: add, rename, reorder, or delete checks.
 *
 * Graded 'any' so any role can correct a plan it is executing against, but
 * routed through `GoalStore.editChecklistPlan`, which only accepts shape. An
 * agent therefore cannot mark a check complete or attach evidence to it here --
 * `update_goal` and the critic remain the only paths that can do that.
 */
export class EditGoalChecklistTool implements Tool {
  readonly name = 'edit_goal_checklist';
  readonly role = 'any' as const;
  readonly description =
    'Reshape a Goal Mode plan: add, rename, reorder, or delete its checks. This changes the plan only -- it cannot mark a check complete or record evidence. Use update_goal inside an active Goal Mode turn to report progress on the current check, and the Critic to verify it.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      goalId: { type: 'string', description: 'The goal whose plan should change' },
      items: {
        type: 'array',
        description: 'The full replacement plan. Checks omitted from this list are deleted.',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description:
                'Existing check id, to keep that check and its state. Omit for a new check.',
            },
            title: { type: 'string', maxLength: 1000, description: 'Check title' },
            order: { type: 'number', description: 'Position, zero-based' },
          },
          required: ['title'],
        },
      },
    },
    required: ['goalId', 'items'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const start = Date.now();
    const goalId = typeof call.input.goalId === 'string' ? call.input.goalId.trim() : '';
    const rawItems = call.input.items;
    if (!goalId) return this.fail(call, 'goalId is required.', start);
    if (!Array.isArray(rawItems) || rawItems.length === 0)
      return this.fail(call, 'items must be a non-empty replacement plan.', start);
    const items = rawItems
      .map((entry, index) => {
        const raw = (entry ?? {}) as Record<string, unknown>;
        const title = typeof raw.title === 'string' ? raw.title.trim() : '';
        const id = typeof raw.id === 'string' ? raw.id.trim() : '';
        return {
          ...(id ? { id } : {}),
          title,
          order: Number.isFinite(raw.order) ? Number(raw.order) : index,
        };
      })
      .filter((item) => item.title);
    if (!items.length) return this.fail(call, 'Every check requires a title.', start);
    try {
      const { goals, wsManager } = getContext();
      const actor = ctx.callerRole ? `${ctx.callerRole} agent` : 'an agent';
      const goal = await goals.editChecklistPlan(goalId, items, actor);
      if (!goal) return this.fail(call, `No goal ${goalId}.`, start);
      const plan = goal.checklist
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((item) => `  [${item.status === 'completed' ? 'x' : ' '}] ${item.id}  ${item.title}`)
        .join('\n');
      wsManager.broadcast({
        type: 'goals.updated',
        payload: { goal },
        timestamp: Date.now(),
        sessionId: goal.sessionId,
      });
      return {
        callId: call.id,
        name: this.name,
        output: `Plan updated for goal ${goalId}. Status and evidence were preserved; completing a check still requires evidence and verification.\n${plan}`,
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return this.fail(call, err instanceof Error ? err.message : String(err), start);
    }
  }

  private fail(call: ToolCallInput, message: string, start: number): ToolCallOutput {
    return {
      callId: call.id,
      name: this.name,
      output: `Error: ${message}`,
      isError: true,
      durationMs: Date.now() - start,
    };
  }
}
