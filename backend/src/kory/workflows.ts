import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type WorkflowRunStatus = 'running' | 'blocked' | 'completed' | 'stopped';

export interface WorkflowStage {
  id: string;
  label: string;
  description: string;
  requiresEvidence: boolean;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  autoStartSafe: boolean;
  stages: WorkflowStage[];
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  sessionId: string;
  goalId?: string;
  task: string;
  requestedBy: 'human' | 'agent';
  status: WorkflowRunStatus;
  stageIndex: number;
  evidence: Array<{ stageId: string; value: string; createdAt: number }>;
  blocker?: string;
  createdAt: number;
  updatedAt: number;
}

const DEFINITIONS: WorkflowDefinition[] = [
  {
    id: 'design-quality',
    name: 'Design Quality Loop',
    description: 'Turn a UI request into an evidence-backed design brief, rendered result, review, and repair loop.',
    autoStartSafe: true,
    stages: [
      { id: 'inspect', label: 'Inspect', description: 'Inspect the real product, target medium, existing components, tokens, and states before proposing a direction.', requiresEvidence: true },
      { id: 'brief', label: 'Design brief', description: 'Record the audience, hierarchy, interaction flow, visual direction, and required states.', requiresEvidence: true },
      { id: 'build', label: 'Build', description: 'Implement the smallest coherent vertical slice using existing product patterns.', requiresEvidence: true },
      { id: 'render', label: 'Render review', description: 'Capture the actual rendered result and check empty, loading, error, keyboard, resize, and alternate-input states.', requiresEvidence: true },
      { id: 'repair', label: 'Repair', description: 'Repair the concrete issues found by the review; do not substitute a prose claim for a rendered result.', requiresEvidence: true },
      { id: 'verify', label: 'Verify', description: 'Run proportional checks and state exactly what passed, failed, or could not be verified.', requiresEvidence: true },
    ],
  },
];

const runPath = (root: string) => join(resolve(root), '.koryphaios', 'workflows', 'runs.json');
const readRuns = (root: string): WorkflowRun[] => {
  try {
    const parsed = JSON.parse(readFileSync(runPath(root), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(validRun) : [];
  } catch {
    return [];
  }
};
const validRun = (value: unknown): value is WorkflowRun => {
  const run = value as WorkflowRun;
  return Boolean(run && typeof run.id === 'string' && typeof run.workflowId === 'string' && typeof run.sessionId === 'string' && typeof run.task === 'string' && ['human', 'agent'].includes(run.requestedBy) && ['running', 'blocked', 'completed', 'stopped'].includes(run.status) && Number.isInteger(run.stageIndex) && Array.isArray(run.evidence));
};
const writeRuns = (root: string, runs: WorkflowRun[]) => {
  const path = runPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(runs, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
};

export const listWorkflowDefinitions = (): WorkflowDefinition[] => DEFINITIONS;
export const getWorkflowDefinition = (id: string) => DEFINITIONS.find((item) => item.id === id);
export const listWorkflowRuns = (root: string, sessionId?: string): WorkflowRun[] =>
  readRuns(root).filter((run) => !sessionId || run.sessionId === sessionId).sort((left, right) => right.updatedAt - left.updatedAt);

export function startWorkflow(root: string, input: Pick<WorkflowRun, 'workflowId' | 'sessionId' | 'task' | 'requestedBy'> & Pick<WorkflowRun, 'goalId'>): WorkflowRun {
  if (!getWorkflowDefinition(input.workflowId)) throw new Error('Unknown workflow');
  if (!input.task.trim()) throw new Error('Workflow task is required');
  const now = Date.now();
  const run: WorkflowRun = { id: crypto.randomUUID(), workflowId: input.workflowId, sessionId: input.sessionId, goalId: input.goalId, task: input.task.trim(), requestedBy: input.requestedBy, status: 'running', stageIndex: 0, evidence: [], createdAt: now, updatedAt: now };
  const runs = readRuns(root);
  writeRuns(root, [run, ...runs]);
  return run;
}

export function advanceWorkflow(root: string, runId: string, input: { evidence: string; block?: boolean }): WorkflowRun {
  const runs = readRuns(root);
  const index = runs.findIndex((run) => run.id === runId);
  if (index < 0) throw new Error('Workflow run not found');
  const current = runs[index];
  const definition = getWorkflowDefinition(current.workflowId);
  if (!definition || current.status !== 'running') throw new Error('Workflow is not running');
  const stage = definition.stages[current.stageIndex];
  const evidence = input.evidence.trim();
  if (stage?.requiresEvidence && !evidence) throw new Error(`Evidence is required for ${stage.label}`);
  const now = Date.now();
  const next: WorkflowRun = input.block
    ? { ...current, status: 'blocked', blocker: evidence || 'Blocked', updatedAt: now }
    : {
        ...current,
        stageIndex: current.stageIndex + 1,
        status: current.stageIndex + 1 >= definition.stages.length ? 'completed' : 'running',
        evidence: evidence ? [...current.evidence, { stageId: stage.id, value: evidence, createdAt: now }] : current.evidence,
        updatedAt: now,
      };
  runs[index] = next;
  writeRuns(root, runs);
  return next;
}

export function stopWorkflow(root: string, runId: string): WorkflowRun {
  const runs = readRuns(root);
  const index = runs.findIndex((run) => run.id === runId);
  if (index < 0) throw new Error('Workflow run not found');
  if (runs[index].status !== 'running' && runs[index].status !== 'blocked') return runs[index];
  const next = { ...runs[index], status: 'stopped' as const, updatedAt: Date.now() };
  runs[index] = next;
  writeRuns(root, runs);
  return next;
}

export function workflowNextInstruction(run: WorkflowRun): string {
  const definition = getWorkflowDefinition(run.workflowId);
  const stage = definition?.stages[run.stageIndex];
  return stage ? `${definition!.name} · ${stage.label}: ${stage.description}` : `${definition?.name ?? 'Workflow'} is complete.`;
}
