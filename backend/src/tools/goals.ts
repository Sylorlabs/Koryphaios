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
      objective: { type: 'string', description: 'Concrete objective the user explicitly requested as a goal' },
      scope: { type: 'string', enum: ['workspace', 'project', 'session'], description: 'Goal ownership scope; default workspace' },
      planningDepth: { type: 'string', enum: ['minimal', 'adaptive', 'structured'], description: 'Optional checklist planning depth' },
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
    const { goals } = getContext();
    const goal = await goals.create({
      objective,
      scope,
      projectPath: scope === 'project' ? ctx.workingDirectory : undefined,
      sessionId: scope === 'session' ? ctx.sessionId : undefined,
      planningDepth,
    });
    await goals.addActivity(goal.id, 'manager_created', 'Goal created by Kory after explicit user request.', ctx.sessionId);
    return { callId: call.id, name: this.name, output: `Created ${scope} goal ${goal.id}: ${goal.objective}. It has ${goal.checklist.length} dependency-aware checklist items and still requires verified evidence before completion.`, isError: false, durationMs: 0 };
  }
}
