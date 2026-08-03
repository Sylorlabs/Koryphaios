import { getContext } from '../context';
import type { GoalScope } from '@koryphaios/shared';
import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';

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
      | 'minimal'
      | 'adaptive'
      | 'structured'
      | undefined;
    if (!objective)
      return {
        callId: call.id,
        name: this.name,
        output: 'Error: objective is required.',
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
    const type = status === 'blocked' ? 'blocker_candidate' : 'evidence_candidate';
    await getContext().goals.addActivity(
      ctx.goalId,
      type,
      `${ctx.goalItemId}|${message}`,
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
