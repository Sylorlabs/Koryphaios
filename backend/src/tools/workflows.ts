import { advanceWorkflow, getWorkflowDefinition, startWorkflow, workflowNextInstruction } from '../kory/workflows';
import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';

export class StartWorkflowTool implements Tool {
  readonly name = 'start_workflow';
  readonly role = 'manager' as const;
  readonly description = 'Start a registered, host-owned task workflow only when the user explicitly asks for it or its safe automatic selection is clearly relevant. Workflows never grant tools, create Goals, or change permissions.';
  readonly inputSchema = { type: 'object', properties: { workflowId: { type: 'string', enum: ['design-quality'] }, task: { type: 'string' }, goalId: { type: 'string' } }, required: ['workflowId', 'task'] };
  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const workflowId = typeof call.input.workflowId === 'string' ? call.input.workflowId : '';
    const task = typeof call.input.task === 'string' ? call.input.task : '';
    if (!getWorkflowDefinition(workflowId) || !task.trim()) return { callId: call.id, name: this.name, output: 'Error: a registered workflow and non-empty task are required.', isError: true, durationMs: 0 };
    const run = startWorkflow(ctx.workingDirectory, { workflowId, task, sessionId: ctx.sessionId, goalId: typeof call.input.goalId === 'string' ? call.input.goalId : undefined, requestedBy: 'agent' });
    return { callId: call.id, name: this.name, output: `Started ${getWorkflowDefinition(workflowId)!.name}. ${workflowNextInstruction(run)} Record concrete stage evidence with update_workflow; do not claim completion until the host marks every stage complete.`, isError: false, durationMs: 0 };
  }
}

export class UpdateWorkflowTool implements Tool {
  readonly name = 'update_workflow';
  readonly role = 'manager' as const;
  readonly description = 'Record concrete evidence for the current stage of a workflow run, or report a genuine blocker. This host advances the stage; the agent cannot skip stages or declare a Goal complete.';
  readonly inputSchema = { type: 'object', properties: { runId: { type: 'string' }, evidence: { type: 'string' }, status: { type: 'string', enum: ['evidence', 'blocked'] } }, required: ['runId', 'evidence', 'status'] };
  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const runId = typeof call.input.runId === 'string' ? call.input.runId : '';
    const evidence = typeof call.input.evidence === 'string' ? call.input.evidence : '';
    const block = call.input.status === 'blocked';
    try {
      const run = advanceWorkflow(ctx.workingDirectory, runId, { evidence, block });
      return { callId: call.id, name: this.name, output: run.status === 'completed' ? 'Workflow completed with recorded stage evidence. This does not complete any linked Goal.' : run.status === 'blocked' ? `Workflow blocked: ${run.blocker}` : workflowNextInstruction(run), isError: false, durationMs: 0 };
    } catch (error) {
      return { callId: call.id, name: this.name, output: `Error: ${error instanceof Error ? error.message : String(error)}`, isError: true, durationMs: 0 };
    }
  }
}
