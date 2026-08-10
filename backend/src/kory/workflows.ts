import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { redactSecretsInText } from '../security';

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

export type WorkflowScope = 'project' | 'personal';
export interface WorkflowDraft extends WorkflowDefinition {
  goalId: string;
  goalItemId: string;
  status: 'draft' | 'activated';
  activatedScope?: WorkflowScope;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  sessionId: string;
  goalId?: string;
  /** Checklist item owned by Goal Mode when the workflow was started in a Goal turn. */
  goalItemId?: string;
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
    description:
      'Turn a UI request into an evidence-backed design brief, rendered result, review, and repair loop.',
    autoStartSafe: true,
    stages: [
      {
        id: 'inspect',
        label: 'Inspect',
        description:
          'Inspect the real product, target medium, existing components, tokens, and states before proposing a direction.',
        requiresEvidence: true,
      },
      {
        id: 'brief',
        label: 'Design brief',
        description:
          'Record the audience, hierarchy, interaction flow, visual direction, and required states.',
        requiresEvidence: true,
      },
      {
        id: 'build',
        label: 'Build',
        description:
          'Implement the smallest coherent vertical slice using existing product patterns.',
        requiresEvidence: true,
      },
      {
        id: 'render',
        label: 'Render review',
        description:
          'Capture the actual rendered result and check empty, loading, error, keyboard, resize, and alternate-input states.',
        requiresEvidence: true,
      },
      {
        id: 'repair',
        label: 'Repair',
        description:
          'Repair the concrete issues found by the review; do not substitute a prose claim for a rendered result.',
        requiresEvidence: true,
      },
      {
        id: 'verify',
        label: 'Verify',
        description:
          'Run proportional checks and state exactly what passed, failed, or could not be verified.',
        requiresEvidence: true,
      },
    ],
  },
];

const workflowRoot = (root: string) => join(resolve(root), '.koryphaios', 'workflows');
const runPath = (root: string) => join(workflowRoot(root), 'runs.json');
const draftPath = (root: string) => join(workflowRoot(root), 'drafts.json');
const projectDefinitionsPath = (root: string) => join(workflowRoot(root), 'definitions.json');
const personalDefinitionsPath = () =>
  join(
    process.env.KORYPHAIOS_WORKFLOWS_HOME
      ? resolve(process.env.KORYPHAIOS_WORKFLOWS_HOME)
      : join(homedir(), '.koryphaios', 'workflows'),
    'definitions.json',
  );

const isMissingFileError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'ENOENT';

const readArray = <T>(path: string, guard: (value: unknown) => value is T): T[] => {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw new Error(
      `Could not read workflow data at ${path}; the existing file was preserved: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Invalid workflow JSON at ${path}; the existing file was preserved: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed) || !parsed.every(guard)) {
    throw new Error(`Invalid workflow records at ${path}; the existing file was preserved`);
  }
  return parsed;
};

const writeArray = (path: string, values: unknown[]) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(values, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
};

const validStoredString = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;

const validDefinition = (value: unknown): value is WorkflowDefinition => {
  const item = value as WorkflowDefinition;
  return Boolean(
    item &&
    validStoredString(item.id, 200) &&
    validStoredString(item.name, 160) &&
    validStoredString(item.description, 2_000) &&
    typeof item.autoStartSafe === 'boolean' &&
    Array.isArray(item.stages) &&
    item.stages.length >= 2 &&
    item.stages.length <= 12 &&
    item.stages.every(
      (stage) =>
        stage &&
        validStoredString(stage.id, 200) &&
        validStoredString(stage.label, 160) &&
        validStoredString(stage.description, 2_000) &&
        stage.requiresEvidence === true,
    ),
  );
};
const validDraft = (value: unknown): value is WorkflowDraft =>
  validDefinition(value) &&
  validStoredString((value as WorkflowDraft).goalId, 200) &&
  validStoredString((value as WorkflowDraft).goalItemId, 200) &&
  ['draft', 'activated'].includes((value as WorkflowDraft).status) &&
  Number.isFinite((value as WorkflowDraft).createdAt) &&
  Number.isFinite((value as WorkflowDraft).updatedAt) &&
  ((value as WorkflowDraft).activatedScope === undefined ||
    ['project', 'personal'].includes((value as WorkflowDraft).activatedScope!));
const readRuns = (root: string): WorkflowRun[] => readArray(runPath(root), validRun);
const validRun = (value: unknown): value is WorkflowRun => {
  const run = value as WorkflowRun;
  return Boolean(
    run &&
    validStoredString(run.id, 200) &&
    validStoredString(run.workflowId, 200) &&
    validStoredString(run.sessionId, 200) &&
    (run.goalId === undefined || validStoredString(run.goalId, 200)) &&
    (run.goalItemId === undefined || validStoredString(run.goalItemId, 200)) &&
    validStoredString(run.task, 4_000) &&
    ['human', 'agent'].includes(run.requestedBy) &&
    ['running', 'blocked', 'completed', 'stopped'].includes(run.status) &&
    Number.isInteger(run.stageIndex) &&
    run.stageIndex >= 0 &&
    Array.isArray(run.evidence) &&
    run.evidence.length <= 12 &&
    run.evidence.every(
      (entry) =>
        entry &&
        validStoredString(entry.stageId, 200) &&
        validStoredString(entry.value, 8_000) &&
        Number.isFinite(entry.createdAt),
    ) &&
    (run.blocker === undefined || validStoredString(run.blocker, 8_000)) &&
    Number.isFinite(run.createdAt) &&
    Number.isFinite(run.updatedAt),
  );
};
const writeRuns = (root: string, runs: WorkflowRun[]) => {
  writeArray(runPath(root), runs);
};

const boundedText = (value: string, label: string, maxLength: number): string => {
  const sanitized = redactSecretsInText(String(value), maxLength).trim();
  if (!sanitized) throw new Error(`${label} is required`);
  return sanitized.slice(0, maxLength);
};

const boundedId = (value: string | undefined, label: string): string | undefined => {
  if (value === undefined) return undefined;
  const sanitized = String(value)
    .trim()
    .replace(/[\0-\x1f\x7f]/g, ' ')
    .slice(0, 200);
  if (!sanitized) throw new Error(`${label} is required`);
  return sanitized;
};

export const listWorkflowDefinitions = (root?: string): WorkflowDefinition[] => {
  const custom = root
    ? [
        ...readArray(projectDefinitionsPath(root), validDefinition),
        ...readArray(personalDefinitionsPath(), validDefinition),
      ]
    : [];
  return [...DEFINITIONS, ...custom].filter(
    (item, index, all) => all.findIndex((other) => other.id === item.id) === index,
  );
};
export const getWorkflowDefinition = (id: string, root?: string) =>
  listWorkflowDefinitions(root).find((item) => item.id === id);
export const listWorkflowDrafts = (root: string): WorkflowDraft[] =>
  readArray(draftPath(root), validDraft).sort((a, b) => b.updatedAt - a.updatedAt);

export function createWorkflowDraft(
  root: string,
  input: {
    name: string;
    description: string;
    goalId: string;
    goalItemId: string;
    stages: Array<{ label: string; description: string }>;
  },
): WorkflowDraft {
  const name = boundedText(input.name, 'Workflow name', 160);
  const description = boundedText(input.description, 'Workflow description', 2_000);
  const goalId = boundedId(input.goalId, 'Workflow Goal identity');
  const goalItemId = boundedId(input.goalItemId, 'Workflow Goal item identity');
  if (!goalId || !goalItemId)
    throw new Error('Workflow drafts require an active Goal item, name, and description');
  if (input.stages.length < 2 || input.stages.length > 12)
    throw new Error('Workflow drafts require 2 to 12 stages');
  const normalizedStages = input.stages.map((stage, index) => ({
    id: `stage-${index + 1}`,
    label: boundedText(stage.label, `Workflow stage ${index + 1} label`, 160),
    description: boundedText(stage.description, `Workflow stage ${index + 1} description`, 2_000),
    requiresEvidence: true,
  }));
  const unsafe = [
    name,
    description,
    ...normalizedStages.flatMap((stage) => [stage.label, stage.description]),
  ]
    .join(' ')
    .toLowerCase();
  if (
    /```|(?:&&|\|\||;\s*(?:sudo|bash|sh)\b)|\bsudo\s|\bchmod\s|\bapi[_ -]?keys?\b|\bsecret tokens?\b|\bgrant\b.{0,32}\bpermissions?\b|\bdisable\b.{0,32}\bcritic\b/.test(
      unsafe,
    )
  )
    throw new Error(
      'Workflow drafts are declarative and cannot contain executable code, credentials, or authority changes',
    );
  const now = Date.now();
  const draft: WorkflowDraft = {
    id: `draft-${crypto.randomUUID()}`,
    name,
    description,
    autoStartSafe: false,
    stages: normalizedStages,
    goalId,
    goalItemId,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };
  const drafts = listWorkflowDrafts(root);
  writeArray(draftPath(root), [draft, ...drafts]);
  return draft;
}

export function activateWorkflowDraft(
  root: string,
  draftId: string,
  scope: WorkflowScope,
): WorkflowDraft {
  const drafts = listWorkflowDrafts(root);
  const index = drafts.findIndex((draft) => draft.id === draftId);
  if (index < 0) throw new Error('Workflow draft not found');
  const draft = drafts[index];
  if (draft.status !== 'draft') throw new Error('Workflow draft is already activated');
  const definition: WorkflowDefinition = {
    id: `custom-${crypto.randomUUID()}`,
    name: draft.name,
    description: draft.description,
    autoStartSafe: false,
    stages: draft.stages,
  };
  const path = scope === 'personal' ? personalDefinitionsPath() : projectDefinitionsPath(root);
  writeArray(path, [definition, ...readArray(path, validDefinition)]);
  const activated = {
    ...draft,
    status: 'activated' as const,
    activatedScope: scope,
    updatedAt: Date.now(),
  };
  drafts[index] = activated;
  writeArray(draftPath(root), drafts);
  return activated;
}
export const listWorkflowRuns = (root: string, sessionId?: string): WorkflowRun[] =>
  readRuns(root)
    .filter((run) => !sessionId || run.sessionId === sessionId)
    .sort((left, right) => right.updatedAt - left.updatedAt);

export function startWorkflow(
  root: string,
  input: Pick<WorkflowRun, 'workflowId' | 'sessionId' | 'task' | 'requestedBy'> &
    Pick<WorkflowRun, 'goalId' | 'goalItemId'>,
): WorkflowRun {
  if (!getWorkflowDefinition(input.workflowId, root)) throw new Error('Unknown workflow');
  const task = boundedText(input.task, 'Workflow task', 4_000);
  const sessionId = boundedId(input.sessionId, 'Workflow session identity');
  const goalId = boundedId(input.goalId, 'Workflow Goal identity');
  const goalItemId = boundedId(input.goalItemId, 'Workflow Goal item identity');
  if (!sessionId) throw new Error('Workflow session identity is required');
  const now = Date.now();
  const run: WorkflowRun = {
    id: crypto.randomUUID(),
    workflowId: input.workflowId,
    sessionId,
    goalId,
    goalItemId,
    task,
    requestedBy: input.requestedBy,
    status: 'running',
    stageIndex: 0,
    evidence: [],
    createdAt: now,
    updatedAt: now,
  };
  const runs = readRuns(root);
  writeRuns(root, [run, ...runs]);
  return run;
}

export function advanceWorkflow(
  root: string,
  runId: string,
  input: { evidence: string; block?: boolean },
): WorkflowRun {
  const runs = readRuns(root);
  const index = runs.findIndex((run) => run.id === runId);
  if (index < 0) throw new Error('Workflow run not found');
  const current = runs[index];
  const definition = getWorkflowDefinition(current.workflowId, root);
  if (!definition || current.status !== 'running') throw new Error('Workflow is not running');
  const stage = definition.stages[current.stageIndex];
  const evidence = input.evidence.trim()
    ? boundedText(input.evidence, 'Workflow evidence', 8_000)
    : '';
  if (stage?.requiresEvidence && !evidence)
    throw new Error(`Evidence is required for ${stage.label}`);
  const now = Date.now();
  const next: WorkflowRun = input.block
    ? { ...current, status: 'blocked', blocker: evidence || 'Blocked', updatedAt: now }
    : {
        ...current,
        stageIndex: current.stageIndex + 1,
        status: current.stageIndex + 1 >= definition.stages.length ? 'completed' : 'running',
        evidence: evidence
          ? [...current.evidence, { stageId: stage.id, value: evidence, createdAt: now }]
          : current.evidence,
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

export function workflowNextInstruction(run: WorkflowRun, root?: string): string {
  const definition = getWorkflowDefinition(run.workflowId, root);
  const stage = definition?.stages[run.stageIndex];
  return stage
    ? `${definition!.name} · ${stage.label}: ${stage.description}`
    : `${definition?.name ?? 'Workflow'} is complete.`;
}
