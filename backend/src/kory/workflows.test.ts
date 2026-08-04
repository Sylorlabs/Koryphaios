import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  advanceWorkflow,
  getWorkflowDefinition,
  listWorkflowRuns,
  startWorkflow,
  stopWorkflow,
  workflowNextInstruction,
  createWorkflowDraft,
  activateWorkflowDraft,
  listWorkflowDrafts,
  listWorkflowDefinitions,
} from './workflows';
import { StartWorkflowTool, UpdateWorkflowTool } from '../tools/workflows';

const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(join(tmpdir(), 'kory-workflow-'));
  roots.push(value);
  return value;
};
afterEach(() => roots.splice(0).forEach((value) => rmSync(value, { recursive: true, force: true })));

describe('host-owned workflows', () => {
  test('starts a design-quality run and persists each evidence-gated stage', () => {
    const project = root();
    const run = startWorkflow(project, { workflowId: 'design-quality', sessionId: 'session-1', task: 'Improve the settings screen', requestedBy: 'human' });
    expect(workflowNextInstruction(run)).toContain('Inspect');
    let current = run;
    for (const stage of getWorkflowDefinition('design-quality')!.stages) {
      current = advanceWorkflow(project, current.id, { evidence: `${stage.id} evidence` });
    }
    expect(current.status).toBe('completed');
    expect(current.evidence).toHaveLength(6);
    expect(listWorkflowRuns(project, 'session-1')[0]?.status).toBe('completed');
  });

  test('cannot skip evidence or confuse a stopped workflow with a Goal', () => {
    const project = root();
    const run = startWorkflow(project, { workflowId: 'design-quality', sessionId: 'session-1', task: 'Improve the settings screen', requestedBy: 'agent' });
    expect(() => advanceWorkflow(project, run.id, { evidence: '' })).toThrow('Evidence is required');
    expect(stopWorkflow(project, run.id).status).toBe('stopped');
    expect(() => advanceWorkflow(project, run.id, { evidence: 'later' })).toThrow('Workflow is not running');
  });

  test('managed and CLI tool contexts bind workflows to the host-owned Goal item', async () => {
    const project = root();
    const ctx = {
      sessionId: 'session-1',
      workingDirectory: project,
      goalId: 'goal-1',
      goalItemId: 'item-1',
    };
    const start = new StartWorkflowTool();
    const result = await start.run(ctx, {
      id: 'start-1',
      name: start.name,
      input: { workflowId: 'design-quality', task: 'Polish Goal Mode' },
    });
    expect(result.isError).toBe(false);
    const run = listWorkflowRuns(project, 'session-1')[0]!;
    expect(run.goalId).toBe('goal-1');
    expect(run.goalItemId).toBe('item-1');

    const update = new UpdateWorkflowTool();
    const wrongItem = await update.run({ ...ctx, goalItemId: 'item-2' }, {
      id: 'update-1',
      name: update.name,
      input: { runId: run.id, evidence: 'real inspection', status: 'evidence' },
    });
    expect(wrongItem.isError).toBe(true);
    expect(wrongItem.output).toContain('active Goal item');
  });

  test('Goal drafts remain inactive until explicit scoped activation', () => {
    const project = root();
    const draft = createWorkflowDraft(project, {
      name: 'Release evidence loop',
      description: 'Repeatable release review',
      goalId: 'goal-1',
      goalItemId: 'item-1',
      stages: [
        { label: 'Inspect', description: 'Inspect release inputs' },
        { label: 'Verify', description: 'Record release evidence' },
      ],
    });
    expect(listWorkflowDefinitions(project).some((item) => item.name === draft.name)).toBe(false);
    expect(listWorkflowDrafts(project)[0]?.status).toBe('draft');
    const active = activateWorkflowDraft(project, draft.id, 'project');
    expect(active.activatedScope).toBe('project');
    expect(listWorkflowDefinitions(project).some((item) => item.name === draft.name)).toBe(true);
  });

  test('workflow drafts reject executable or authority-bearing content', () => {
    const project = root();
    expect(() => createWorkflowDraft(project, {
      name: 'Unsafe shell workflow',
      description: 'Run a command automatically',
      goalId: 'goal-1',
      goalItemId: 'item-1',
      stages: [{ label: 'One', description: 'Use sudo' }, { label: 'Two', description: 'Finish' }],
    })).toThrow('declarative');
  });
});
