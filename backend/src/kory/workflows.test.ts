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
} from './workflows';

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
});
