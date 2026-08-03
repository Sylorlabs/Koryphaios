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
    const planningDepth = call.input.planningDepth as 'minimal' | 'adaptive' | 'structured' | undefined;
    if (!objective) return { callId: call.id, name: this.name, output: 'Error: objective is required.', isError: true, durationMs: 0 };
    if (!['workspace', 'project', 'session'].includes(scope)) return { callId: call.id, name: this.name, output: 'Error: invalid goal scope.', isError: true, durationMs: 0 };
    if (scope === 'project' && !ctx.workingDirectory) return { callId: call.id, name: this.name, output: 'Error: project goals require a project-scoped chat.', isError: true, durationMs: 0 };
    const context = getContext();
    const { goals } = context;
    const goal = await goals.create({
      objective,
      scope,
      projectPath: scope === 'project' ? ctx.workingDirectory : undefined,
      sessionId: scope === 'session' ? ctx.sessionId : undefined,
      planningDepth,
    });
    await goals.addActivity(goal.id, 'manager_created', 'Goal created by Kory after explicit user request.', ctx.sessionId);
    const routing = context.kory?.getLastManagerRouting?.(ctx.sessionId);
    if (routing?.model && routing.provider && context.goalDriver) {
      await context.goalDriver.start(goal.id, { sessionId: ctx.sessionId, provider: routing.provider, model: routing.model });
    }
    return { callId: call.id, name: this.name, output: `Created ${scope} goal ${goal.id}: ${goal.objective}. It has ${goal.checklist.length} dependency-aware checklist items${routing?.model && routing.provider ? ' and will continue automatically after this turn' : '; choose a provider model to start it'}. Independent verification is required before completion.`, isError: false, durationMs: 0 };
  }
}

/** Lets the active Goal Mode manager persist evidence or a genuine blocker candidate. */
export class UpdateGoalTool implements Tool {
  readonly name = 'update_goal';
  readonly role = 'manager' as const;
  readonly description =
    'Update only the active Goal Mode checklist item. Record concrete evidence as work progresses. Report a blocker only after exhausting safe alternatives; Goal Mode requires the same blocker to recur before it stops.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['record_evidence', 'report_blocker'] },
      value: { type: 'string', description: 'Concrete evidence or exact blocker with attempted alternatives' },
      kind: { type: 'string', enum: ['check', 'artifact', 'note'] },
      blockerCategory: { type: 'string', enum: ['human_input', 'authorization', 'external_dependency', 'environment', 'safety'] },
    },
    required: ['action', 'value'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const active = ctx.goalContext;
    const value = typeof call.input.value === 'string' ? call.input.value.trim() : '';
    if (!active) return { callId: call.id, name: this.name, output: 'Error: no active Goal Mode item.', isError: true, durationMs: 0 };
    if (!value) return { callId: call.id, name: this.name, output: 'Error: value is required.', isError: true, durationMs: 0 };
    const { goals } = getContext();
    if (call.input.action === 'record_evidence') {
      const kind = ['check', 'artifact', 'note'].includes(String(call.input.kind)) ? call.input.kind as 'check' | 'artifact' | 'note' : 'note';
      await goals.addItemEvidence(active.goalId, active.itemId, { kind, value });
      return { callId: call.id, name: this.name, output: 'Evidence recorded as pending independent verification. Continue until the checklist item is fully satisfied.', isError: false, durationMs: 0 };
    }
    if (call.input.action === 'report_blocker') {
      const category = String(call.input.blockerCategory ?? 'external_dependency');
      await goals.addActivity(active.goalId, 'blocker_candidate', `${active.itemId}|${category}: ${value}`, ctx.sessionId);
      return { callId: call.id, name: this.name, output: 'Blocker candidate recorded. Keep trying safe alternatives; Goal Mode stops only after this blocker is independently repeated.', isError: false, durationMs: 0 };
    }
    return { callId: call.id, name: this.name, output: 'Error: invalid action.', isError: true, durationMs: 0 };
  }
}
