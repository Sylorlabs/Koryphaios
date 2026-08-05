import {
  advanceWorkflow,
  createWorkflowDraft,
  getWorkflowDefinition,
  listWorkflowDefinitions,
  listWorkflowRuns,
  startWorkflow,
  workflowNextInstruction,
} from '../kory/workflows';
import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';
import { getContext } from '../context';

function workflowCatalog(root: string): string {
  const definitions = listWorkflowDefinitions(root);
  return definitions.length
    ? definitions.map((item) => `${item.name} (${item.id})`).join(', ')
    : 'none';
}

function resolveWorkflow(reference: string, root: string) {
  const normalized = reference.trim().toLowerCase();
  if (!normalized) return undefined;
  return listWorkflowDefinitions(root).find(
    (item) => item.id.toLowerCase() === normalized || item.name.toLowerCase() === normalized,
  );
}

export class ListWorkflowsTool implements Tool {
  readonly name = 'list_workflows';
  readonly role = 'manager' as const;
  readonly description =
    'List the registered host-owned workflows available in this workspace before selecting one to start.';
  readonly inputSchema = { type: 'object', properties: {} };
  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const definitions = listWorkflowDefinitions(ctx.workingDirectory);
    const output = definitions.length
      ? definitions.map((item) => `${item.name} (${item.id}): ${item.description}`).join('\n')
      : 'No workflows are registered in this workspace.';
    return { callId: call.id, name: this.name, output, isError: false, durationMs: 0 };
  }
}

export class StartWorkflowTool implements Tool {
  readonly name = 'start_workflow';
  readonly role = 'manager' as const;
  readonly description =
    'Start a registered, host-owned task workflow only when the user explicitly asks for it or its safe automatic selection is clearly relevant. Call list_workflows first when the exact ID or name is unknown. Workflows never grant tools, create Goals, or change permissions.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      workflowId: {
        type: 'string',
        description: 'A registered built-in, project, or personal workflow ID',
      },
      workflow: {
        type: 'string',
        description:
          'Registered workflow ID or exact display name; accepted as a compatibility alias',
      },
      name: {
        type: 'string',
        description: 'Exact registered workflow display name; accepted when workflowId is unknown',
      },
      task: {
        type: 'string',
        description: 'The concrete user task this workflow should carry out',
      },
      goalId: {
        type: 'string',
        description: 'Optional outside Goal Mode. Goal Mode supplies and validates this identity.',
      },
    },
    required: ['task'],
  };
  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const reference =
      typeof call.input.workflowId === 'string'
        ? call.input.workflowId
        : typeof call.input.workflow === 'string'
          ? call.input.workflow
          : typeof call.input.name === 'string'
            ? call.input.name
            : '';
    const task = typeof call.input.task === 'string' ? call.input.task : '';
    const definition = resolveWorkflow(reference, ctx.workingDirectory);
    if (!task.trim())
      return {
        callId: call.id,
        name: this.name,
        output: `Error: a non-empty task is required. Registered workflows: ${workflowCatalog(ctx.workingDirectory)}.`,
        isError: true,
        durationMs: 0,
      };
    if (!definition)
      return {
        callId: call.id,
        name: this.name,
        output: `Error: no registered workflow matches ${reference.trim() ? `"${reference.trim()}"` : 'the empty selection'}. Registered workflows: ${workflowCatalog(ctx.workingDirectory)}. Call list_workflows before retrying.`,
        isError: true,
        durationMs: 0,
      };
    const workflowId = definition.id;
    const requestedGoalId = typeof call.input.goalId === 'string' ? call.input.goalId : undefined;
    if (ctx.goalId && requestedGoalId && requestedGoalId !== ctx.goalId) {
      return {
        callId: call.id,
        name: this.name,
        output: 'Error: workflow goal identity must match the host-owned active Goal.',
        isError: true,
        durationMs: 0,
      };
    }
    const run = startWorkflow(ctx.workingDirectory, {
      workflowId,
      task,
      sessionId: ctx.sessionId,
      goalId: ctx.goalId ?? requestedGoalId,
      goalItemId: ctx.goalItemId,
      requestedBy: 'agent',
    });
    return {
      callId: call.id,
      name: this.name,
      output: `Started ${definition.name} (run ${run.id})${run.goalId ? ` linked to Goal ${run.goalId}${run.goalItemId ? ` item ${run.goalItemId}` : ''}` : ''}. ${workflowNextInstruction(run, ctx.workingDirectory)} Record concrete stage evidence with update_workflow; do not claim Goal completion until the Goal host and its critic accept the resulting evidence.`,
      isError: false,
      durationMs: 0,
    };
  }
}

export class UpdateWorkflowTool implements Tool {
  readonly name = 'update_workflow';
  readonly role = 'manager' as const;
  readonly description =
    'Record concrete evidence for the current stage of a workflow run, or report a genuine blocker. This host advances the stage; the agent cannot skip stages or declare a Goal complete.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      runId: { type: 'string' },
      evidence: { type: 'string' },
      status: { type: 'string', enum: ['evidence', 'blocked'] },
    },
    required: ['runId', 'evidence', 'status'],
  };
  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const runId = typeof call.input.runId === 'string' ? call.input.runId : '';
    const evidence = typeof call.input.evidence === 'string' ? call.input.evidence : '';
    const block = call.input.status === 'blocked';
    try {
      const existing = listWorkflowRuns(ctx.workingDirectory, ctx.sessionId).find(
        (run) => run.id === runId,
      );
      if (!existing) throw new Error('Workflow run not found in this session');
      if (ctx.goalId && existing.goalId !== ctx.goalId)
        throw new Error('Workflow run is not linked to the active Goal');
      if (ctx.goalItemId && existing.goalItemId !== ctx.goalItemId)
        throw new Error('Workflow run is not linked to the active Goal item');
      const run = advanceWorkflow(ctx.workingDirectory, runId, { evidence, block });
      return {
        callId: call.id,
        name: this.name,
        output:
          run.status === 'completed'
            ? 'Workflow completed with recorded stage evidence. This does not complete any linked Goal.'
            : run.status === 'blocked'
              ? `Workflow blocked: ${run.blocker}`
              : workflowNextInstruction(run, ctx.workingDirectory),
        isError: false,
        durationMs: 0,
      };
    } catch (error) {
      return {
        callId: call.id,
        name: this.name,
        output: `Error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
        durationMs: 0,
      };
    }
  }
}

export class CreateWorkflowDraftTool implements Tool {
  readonly name = 'create_workflow_draft';
  readonly role = 'manager' as const;
  readonly description =
    'Inside an active Goal item only, save a declarative reusable-workflow draft after recognizing a genuinely recurring procedure. This never activates the workflow; the human must review and activate it in the Workflows panel.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      stages: {
        type: 'array',
        minItems: 2,
        maxItems: 12,
        items: {
          type: 'object',
          properties: { label: { type: 'string' }, description: { type: 'string' } },
          required: ['label', 'description'],
        },
      },
    },
    required: ['name', 'description', 'stages'],
  };
  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    if (!ctx.goalId || !ctx.goalItemId)
      return {
        callId: call.id,
        name: this.name,
        output: 'Error: workflow drafts can only be created inside an active Goal item.',
        isError: true,
        durationMs: 0,
      };
    try {
      const input = call.input as {
        name: string;
        description: string;
        stages: Array<{ label: string; description: string }>;
      };
      const draft = createWorkflowDraft(ctx.workingDirectory, {
        ...input,
        goalId: ctx.goalId,
        goalItemId: ctx.goalItemId,
      });
      await getContext().goals.addActivity(
        ctx.goalId,
        'workflow_drafted',
        `${draft.id}|${draft.name}`,
        ctx.sessionId,
      );
      return {
        callId: call.id,
        name: this.name,
        output: `Drafted ${draft.name} with ${draft.stages.length} evidence-gated stages. It is temporary and inactive until the user explicitly activates it for this project or their personal library in the Workflows panel.`,
        isError: false,
        durationMs: 0,
      };
    } catch (error) {
      return {
        callId: call.id,
        name: this.name,
        output: `Error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
        durationMs: 0,
      };
    }
  }
}
