import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { ListWorkflowsTool, StartWorkflowTool, UpdateWorkflowTool } from '../tools/workflows';

const roots: string[] = [];
let previousPersonalWorkflowRoot: string | undefined;
const root = () => {
  const value = mkdtempSync(join(tmpdir(), 'kory-workflow-'));
  roots.push(value);
  return value;
};
beforeEach(() => {
  previousPersonalWorkflowRoot = process.env.KORYPHAIOS_WORKFLOWS_HOME;
  process.env.KORYPHAIOS_WORKFLOWS_HOME = root();
});
afterEach(() => {
  if (previousPersonalWorkflowRoot === undefined) {
    delete process.env.KORYPHAIOS_WORKFLOWS_HOME;
  } else {
    process.env.KORYPHAIOS_WORKFLOWS_HOME = previousPersonalWorkflowRoot;
  }
  roots.splice(0).forEach((value) => rmSync(value, { recursive: true, force: true }));
});

describe('host-owned workflows', () => {
  test('starts a design-quality run and persists each evidence-gated stage', () => {
    const project = root();
    const run = startWorkflow(project, {
      workflowId: 'design-quality',
      sessionId: 'session-1',
      task: 'Improve the settings screen',
      requestedBy: 'human',
    });
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
    const run = startWorkflow(project, {
      workflowId: 'design-quality',
      sessionId: 'session-1',
      task: 'Improve the settings screen',
      requestedBy: 'agent',
    });
    expect(() => advanceWorkflow(project, run.id, { evidence: '' })).toThrow(
      'Evidence is required',
    );
    expect(stopWorkflow(project, run.id).status).toBe('stopped');
    expect(() => advanceWorkflow(project, run.id, { evidence: 'later' })).toThrow(
      'Workflow is not running',
    );
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
    const wrongItem = await update.run(
      { ...ctx, goalItemId: 'item-2' },
      {
        id: 'update-1',
        name: update.name,
        input: { runId: run.id, evidence: 'real inspection', status: 'evidence' },
      },
    );
    expect(wrongItem.isError).toBe(true);
    expect(wrongItem.output).toContain('active Goal item');
  });

  test('agents can discover workflows and start one by its exact display name', async () => {
    const project = root();
    const ctx = { sessionId: 'session-1', workingDirectory: project };
    const list = await new ListWorkflowsTool().run(ctx, {
      id: 'list-1',
      name: 'list_workflows',
      input: {},
    });
    expect(list.isError).toBe(false);
    expect(list.output).toContain('Design Quality Loop (design-quality)');

    const start = await new StartWorkflowTool().run(ctx, {
      id: 'start-by-name',
      name: 'start_workflow',
      input: { name: 'Design Quality Loop', task: 'Polish workflow feedback' },
    });
    expect(start.isError).toBe(false);
    expect(listWorkflowRuns(project, 'session-1')[0]?.workflowId).toBe('design-quality');

    const aliased = await new StartWorkflowTool().run(ctx, {
      id: 'start-by-common-alias',
      name: 'start_workflow',
      input: { workflow: 'design-quality', task: 'Verify the compatibility alias' },
    });
    expect(aliased.isError).toBe(false);
  });

  test('invalid workflow calls return actionable registered choices', async () => {
    const project = root();
    const tool = new StartWorkflowTool();
    const unknown = await tool.run(
      { sessionId: 'session-1', workingDirectory: project },
      {
        id: 'unknown',
        name: tool.name,
        input: { name: 'test', task: 'test' },
      },
    );
    expect(unknown.isError).toBe(true);
    expect(unknown.output).toContain('no registered workflow matches "test"');
    expect(unknown.output).toContain('Design Quality Loop (design-quality)');
    expect(unknown.output).toContain('list_workflows');
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
    expect(() =>
      createWorkflowDraft(project, {
        name: 'Unsafe shell workflow',
        description: 'Run a command automatically',
        goalId: 'goal-1',
        goalItemId: 'item-1',
        stages: [
          { label: 'One', description: 'Use sudo' },
          { label: 'Two', description: 'Finish' },
        ],
      }),
    ).toThrow('declarative');
  });

  test('malformed persisted workflow data fails visibly and is never overwritten', () => {
    const project = root();
    const workflowDirectory = join(project, '.koryphaios', 'workflows');
    const draftsPath = join(workflowDirectory, 'drafts.json');
    mkdirSync(workflowDirectory, { recursive: true });
    writeFileSync(draftsPath, '{ malformed draft data');

    expect(() =>
      createWorkflowDraft(project, {
        name: 'Safe draft',
        description: 'A valid description',
        goalId: 'goal-1',
        goalItemId: 'item-1',
        stages: [
          { label: 'Inspect', description: 'Inspect first' },
          { label: 'Verify', description: 'Verify second' },
        ],
      }),
    ).toThrow('existing file was preserved');
    expect(readFileSync(draftsPath, 'utf8')).toBe('{ malformed draft data');
  });

  test('activation preserves a malformed definition library and leaves the draft inactive', () => {
    const project = root();
    const draft = createWorkflowDraft(project, {
      name: 'Safe draft',
      description: 'A valid description',
      goalId: 'goal-1',
      goalItemId: 'item-1',
      stages: [
        { label: 'Inspect', description: 'Inspect first' },
        { label: 'Verify', description: 'Verify second' },
      ],
    });
    const definitionsPath = join(project, '.koryphaios', 'workflows', 'definitions.json');
    writeFileSync(definitionsPath, '{ malformed definitions');

    expect(() => activateWorkflowDraft(project, draft.id, 'project')).toThrow(
      'existing file was preserved',
    );
    expect(readFileSync(definitionsPath, 'utf8')).toBe('{ malformed definitions');
    expect(listWorkflowDrafts(project)[0]?.status).toBe('draft');
  });

  test('bounds and redacts persisted tasks and stage evidence', () => {
    const project = root();
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
    const run = startWorkflow(project, {
      workflowId: 'design-quality',
      sessionId: 'session-1',
      task: `Inspect token=${secret}`,
      requestedBy: 'human',
    });
    const advanced = advanceWorkflow(project, run.id, {
      evidence: `token=${secret}\n${'proof '.repeat(2_000)}`,
    });

    expect(advanced.task).not.toContain(secret);
    expect(advanced.evidence[0]?.value).not.toContain(secret);
    expect(advanced.evidence[0]?.value.length).toBeLessThanOrEqual(8_000);
    expect(
      readFileSync(join(project, '.koryphaios', 'workflows', 'runs.json'), 'utf8'),
    ).not.toContain(secret);
  });
});
