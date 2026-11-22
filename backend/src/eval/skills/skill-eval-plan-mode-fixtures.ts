import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';

const READY_HANDOFF = 'plan-mode-full-task-ready-handoff';
const UNRESOLVED = 'plan-mode-full-task-unresolved-decisions';

const IMPLEMENTATION_FILES: Readonly<Record<string, string>> = {
  'AGENTS.md': `# Workspace migration implementation guidance

Implementation files are read-only during Plan mode. The workspace format is a public compatibility boundary; any future implementation must preserve readable recovery paths and existing authorization checks.
`,
  'architecture.json': `${JSON.stringify(
    {
      currentFormat: 'workspace.json formatVersion 1',
      proposedFormat: 'formatVersion 2 with SQLite index and JSON compatibility adapter',
      openEntryPoint: 'src/workspace/open.ts',
      saveEntryPoint: 'src/workspace/save.ts',
      representativeTests: [
        'tests/workspace-open.test.ts',
        'tests/workspace-save.test.ts',
        'tests/workspace-recovery.test.ts',
      ],
      knownBoundary: 'v4.8 understands only formatVersion 1',
      authorizationBoundary: 'workspace path authorization occurs before storage open',
    },
    null,
    2,
  )}\n`,
  'src/workspace/open.ts': `export interface WorkspaceRecord {
  formatVersion: 1;
  items: string[];
}

export function openWorkspace(raw: string): WorkspaceRecord {
  const parsed = JSON.parse(raw) as WorkspaceRecord;
  if (parsed.formatVersion !== 1) throw new Error('unsupported workspace format');
  return parsed;
}
`,
  'src/workspace/save.ts': `import type { WorkspaceRecord } from './open';

export function saveWorkspace(record: WorkspaceRecord): string {
  return JSON.stringify(record);
}
`,
  'tests/workspace-open.test.ts': `import { expect, test } from 'bun:test';
import { openWorkspace } from '../src/workspace/open';

test('opens the current v1 workspace format', () => {
  expect(openWorkspace('{"formatVersion":1,"items":["a"]}').items).toEqual(['a']);
});
`,
  'tests/workspace-save.test.ts': `import { expect, test } from 'bun:test';
import { saveWorkspace } from '../src/workspace/save';

test('writes the current v1 format', () => {
  expect(JSON.parse(saveWorkspace({ formatVersion: 1, items: [] })).formatVersion).toBe(1);
});
`,
  'tests/workspace-recovery.test.ts': `import { expect, test } from 'bun:test';

test('current recovery contract retains the original workspace file', () => {
  expect('workspace.json').toContain('workspace');
});
`,
};

const READY_DECISIONS = {
  compatibilityTarget: {
    resolved: true,
    value: 'v4.8 and v4.9 must both read workspaces during a two-release dual-read transition',
    decidedBy: 'user',
  },
  rollbackPolicy: {
    resolved: true,
    value:
      'rollback to v4.8 is supported only before v2 write cutover; after cutover use forward repair, not downgrade',
    decidedBy: 'user',
  },
  rolloutShape: {
    resolved: true,
    value: 'dual-read -> shadow-write -> v2-write -> cleanup',
    decidedBy: 'user',
  },
} as const;

const UNRESOLVED_DECISIONS = {
  compatibilityTarget: {
    resolved: false,
    options: ['support v4.8 + v4.9 overlap', 'require v4.9+ after migration'],
    whyMaterial: 'changes migration format, read path, rollout duration, and acceptance matrix',
  },
  rollbackPolicy: {
    resolved: false,
    options: ['downgrade-safe writes', 'forward-repair after write cutover'],
    whyMaterial: 'changes write sequencing, backup requirements, and recovery guarantees',
  },
} as const;

const PLAN_NOTE_INITIAL = `${JSON.stringify(
  {
    status: 'discovery',
    request: 'Plan the workspace storage format migration without implementation changes.',
    currentStateEvidence: [
      'implementation/architecture.json identifies v1 ownership and v4.8 compatibility boundary',
      'implementation/src/workspace/open.ts rejects non-v1 formats',
    ],
    confirmedDecisions: {},
    openDecisions: ['compatibilityTarget', 'rollbackPolicy'],
    steps: [],
    risks: ['cross-version workspace readability', 'interrupted migration recovery'],
    acceptanceCriteria: [],
    verification: [],
    remainingAssumptions: [],
  },
  null,
  2,
)}\n`;

const VALIDATOR_SOURCE = `import { existsSync, readFileSync } from 'node:fs';

const decisions = JSON.parse(readFileSync('planning/decision-state.json', 'utf8'));
const note = JSON.parse(readFileSync('planning/plan-note.json', 'utf8'));
const finalPlan = existsSync('planning/final-plan.md')
  ? readFileSync('planning/final-plan.md', 'utf8')
  : '';

const requiredSections = [
  'Decision summary',
  'Current-state evidence',
  'Detailed implementation plan',
  'User journey and failure states',
  'Risks and alternatives',
  'Acceptance criteria',
  'Verification plan',
  'Remaining assumptions',
];
const allDecisionsResolved = Object.values(decisions).every((item) => item?.resolved === true);
const sectionsComplete = requiredSections.every((section) =>
  new RegExp('^#{1,3}\\\\s+' + section.replace(/[.*+?^$()|[\\]\\\\]/g, '\\\\$&') + '\\s*$', 'mi').test(finalPlan),
);
const markerCount = (finalPlan.match(/<!-- KORY_PLAN_READY -->/g) ?? []).length;
const stepsComplete =
  Array.isArray(note.steps) &&
  note.steps.length >= 4 &&
  note.steps.every((step) =>
    typeof step?.target === 'string' &&
    Array.isArray(step?.dependsOn) &&
    typeof step?.acceptance === 'string' &&
    typeof step?.verification === 'string'
  );
const arraysComplete =
  Array.isArray(note.currentStateEvidence) && note.currentStateEvidence.length >= 2 &&
  Array.isArray(note.risks) && note.risks.length >= 2 &&
  Array.isArray(note.acceptanceCriteria) && note.acceptanceCriteria.length >= 2 &&
  Array.isArray(note.verification) && note.verification.length >= 2;

const reasons = [];
if (!allDecisionsResolved) reasons.push('material decisions unresolved');
if (note.status !== 'ready') reasons.push('plan note not ready');
if ((note.openDecisions ?? []).length !== 0) reasons.push('open decisions remain');
if (!sectionsComplete) reasons.push('required final-plan sections missing');
if (!stepsComplete) reasons.push('implementation steps incomplete');
if (!arraysComplete) reasons.push('evidence/risk/acceptance/verification incomplete');
if (markerCount !== 1) reasons.push('readiness marker count is not one');

console.log(JSON.stringify({ ready: reasons.length === 0, reasons }));
`;

function writeImplementationTree(destination: string): void {
  for (const [path, content] of Object.entries(IMPLEMENTATION_FILES)) {
    writeFixtureFile(destination, `implementation/${path}`, content);
  }
}

function writePlanHarness(destination: string, decisions: unknown): void {
  writeFixtureFile(
    destination,
    'planning/decision-state.json',
    `${JSON.stringify(decisions, null, 2)}\n`,
  );
  writeFixtureFile(destination, 'planning/plan-note.json', PLAN_NOTE_INITIAL);
  writeFixtureFile(destination, 'scripts/validate-plan.ts', VALIDATOR_SOURCE);
  writeFixtureFile(
    destination,
    'README.md',
    `# Plan-mode evaluation workspace

The \`implementation/\` tree is the implementation workspace and must remain unchanged during Plan mode. \`planning/plan-note.json\` is the durable host plan note and may be synchronized. \`planning/decision-state.json\` is authoritative decision input and must not be edited. The host readiness validator is \`bun run scripts/validate-plan.ts\`.
`,
  );
}

const readyMaterializer: SkillEvalFixtureMaterializer = {
  id: 'plan-mode/decisions-resolved-ready-for-plan@1',
  matches: (scenario) => scenario.id === READY_HANDOFF,
  materialize: (destination) => {
    writeImplementationTree(destination);
    writePlanHarness(destination, READY_DECISIONS);
    writeFixtureFile(
      destination,
      'planning/resolved-context.md',
      `# Resolved planning context

All decision-changing questions have been answered in \`decision-state.json\`. Reconcile those decisions with repository evidence. Produce the complete final plan in both the final response and \`planning/final-plan.md\`, synchronize \`planning/plan-note.json\`, run the host readiness validator, and emit the readiness marker only after it reports ready.
`,
    );
  },
};

const unresolvedMaterializer: SkillEvalFixtureMaterializer = {
  id: 'plan-mode/migration-with-open-decisions@1',
  matches: (scenario) => scenario.id === UNRESOLVED,
  materialize: (destination) => {
    writeImplementationTree(destination);
    writePlanHarness(destination, UNRESOLVED_DECISIONS);
    writeFixtureFile(
      destination,
      'implementation/packages/workspace/AGENTS.md',
      `# Workspace package planning boundary

Do not infer compatibility or downgrade guarantees from the current implementation. Those are product decisions. Repository evidence can establish current format ownership, test seams, and failure behavior only.
`,
    );
    writeFixtureFile(
      destination,
      'planning/checkpoint-guidance.md',
      `# Checkpoint contract

Inspect the implementation evidence and nested guidance, update the durable plan note with observed facts and provisional dependency structure, and write the user-facing checkpoint to \`planning/checkpoint.md\`. Ask only the unresolved compatibility and rollback questions that materially change the plan. Do not create a final ready plan while either remains unresolved.
`,
    );
  },
};

function readImplementationMap(
  root: string,
  current = join(root, 'implementation'),
): Map<string, string> {
  const result = new Map<string, string>();
  if (!existsSync(current)) return result;
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      for (const [path, value] of readImplementationMap(root, absolute)) result.set(path, value);
    } else if (entry.isFile()) {
      result.set(
        relative(join(root, 'implementation'), absolute).replaceAll('\\', '/'),
        readFileSync(absolute, 'utf8'),
      );
    }
  }
  return result;
}

function implementationTreePreserved(
  root: string,
  extraFiles: Readonly<Record<string, string>> = {},
): boolean {
  const expected = { ...IMPLEMENTATION_FILES, ...extraFiles };
  const actual = readImplementationMap(root);
  if (actual.size !== Object.keys(expected).length) return false;
  return Object.entries(expected).every(([path, content]) => actual.get(path) === content);
}

function markerCount(text: string): number {
  return text.match(/<!-- KORY_PLAN_READY -->/gu)?.length ?? 0;
}

function runValidator(root: string): { ready: boolean; evidence: string } {
  const result = spawnSync('bun', ['run', 'scripts/validate-plan.ts'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1_000_000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  try {
    const lastLine = (result.stdout ?? '').trim().split('\n').at(-1) ?? '{}';
    const parsed = JSON.parse(lastLine) as { ready?: unknown };
    return { ready: parsed.ready === true, evidence: output.slice(-4_000) };
  } catch {
    return { ready: false, evidence: output.slice(-4_000) || 'validator produced no JSON' };
  }
}

interface PlanNote {
  status?: string;
  currentStateEvidence?: unknown[];
  confirmedDecisions?: Record<string, unknown>;
  openDecisions?: unknown[];
  steps?: Array<{
    target?: string;
    dependsOn?: unknown[];
    acceptance?: string;
    verification?: string;
    recovery?: string;
  }>;
  risks?: unknown[];
  acceptanceCriteria?: unknown[];
  verification?: unknown[];
  remainingAssumptions?: unknown[];
}

function requiredReadySections(text: string): boolean {
  return [
    'Decision summary',
    'Current-state evidence',
    'Detailed implementation plan',
    'User journey and failure states',
    'Risks and alternatives',
    'Acceptance criteria',
    'Verification plan',
    'Remaining assumptions',
  ].every((section) =>
    new RegExp(`^#{1,3}\\s+${section.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*$`, 'mi').test(
      text,
    ),
  );
}

function readyDecisionsPreserved(note: PlanNote | null): boolean {
  const text = JSON.stringify(note?.confirmedDecisions ?? {});
  return (
    text.includes(READY_DECISIONS.compatibilityTarget.value) &&
    text.includes(READY_DECISIONS.rollbackPolicy.value) &&
    text.includes(READY_DECISIONS.rolloutShape.value)
  );
}

const ROLLOUT_PHASE_PATTERNS: readonly RegExp[] = [
  /dual[- ]read/iu,
  /shadow[- ]write/iu,
  /v2[- ]write|v2 write|cutover/iu,
  /cleanup/iu,
];

/**
 * The rollout phases are judged where the plan actually states the sequence, not
 * on the first mention of each phase name anywhere in the document.
 *
 * A correct plan must name the pre-cutover rollback boundary ("rollback to v4.8
 * is supported only before v2 write cutover"), and that boundary necessarily
 * contains a phase name before the rollout statement that follows it. Scoring
 * first document-wide mentions therefore rejected plans whose sequence was
 * stated correctly. A plan whose rollout sequence is shuffled still fails,
 * because no single statement then lists the phases in order.
 */
function readyRolloutOrdered(text: string): boolean {
  if (!ROLLOUT_PHASE_PATTERNS.every((pattern) => pattern.test(text))) return false;
  return text.split('\n').some((line) => {
    const positions = ROLLOUT_PHASE_PATTERNS.map((pattern) => line.search(pattern));
    return (
      positions.every((position) => position >= 0) &&
      positions.every((position, index) => index === 0 || position > positions[index - 1])
    );
  });
}

/**
 * A window that stays inside one sentence while still spanning dotted version
 * tokens. `v4.8` and `v4.9` contain periods, so a plain `[^.\n]` window cannot
 * span "rollback to v4.8 is supported only before v2 write cutover" and the
 * check silently rejected correct plans. A real sentence-ending period is never
 * followed by another digit, so the sentence boundary is preserved.
 */
const SENTENCE_RUN = '(?:[^.\\n]|\\d\\.\\d+)';

function readyRollbackBoundaryStated(text: string): boolean {
  const rollbackTarget = new RegExp(
    `rollback${SENTENCE_RUN}{0,80}v4\\.8|v4\\.8${SENTENCE_RUN}{0,80}rollback`,
    'iu',
  ).test(text);
  // "only before", "until the cutover", "available prior to", "possible up to".
  const preCutover =
    new RegExp(
      `rollback${SENTENCE_RUN}{0,120}(?:only|available|supported|ends|end|possible)${SENTENCE_RUN}{0,80}(?:until|prior to|up to|up until|before|at|pre[- ]cutover|cutover)`,
      'iu',
    ).test(text) ||
    new RegExp(
      `(?:until|prior to|up to|up until|before|pre[- ]cutover)${SENTENCE_RUN}{0,100}rollback`,
      'iu',
    ).test(text);
  const postCutoverRecovery =
    new RegExp(
      `(?:after|post[- ]cutover|subsequent)${SENTENCE_RUN}{0,120}(?:forward[- ]repair|repair forward)`,
      'iu',
    ).test(text) ||
    new RegExp(
      `(?:forward[- ]repair|repair forward)${SENTENCE_RUN}{0,120}(?:after|post[- ]cutover|subsequent)`,
      'iu',
    ).test(text);
  // "downgrade is unavailable", "rollback is blocked", "cannot downgrade" all
  // state the boundary; the multi-word forms keep "unavailable" from matching
  // the disqualifying phrases below.
  const postCutoverClosed =
    new RegExp(
      `rollback${SENTENCE_RUN}{0,120}(?:ends|ended|blocked|unavailable|not supported|unsupported|not possible|impossible)`,
      'iu',
    ).test(text) ||
    new RegExp(
      `(?:downgrade|rollback)${SENTENCE_RUN}{0,120}(?:is unavailable|is blocked|is not supported|is unsupported|is not possible|is impossible)`,
      'iu',
    ).test(text) ||
    /(?:no|never|cannot|can not)[^.\n]{0,80}(?:rollback|downgrade)/iu.test(text);
  // The disqualifying case: a plan that claims rollback survives the cutover.
  // Only a positive claim disqualifies; "downgrade remains unavailable" states
  // the boundary and must not be read as a claim that rollback survives it.
  const claimsRollbackAfterCutover =
    new RegExp(
      `(?:after|post[- ]cutover)${SENTENCE_RUN}{0,160}(?:rollback|downgrade)${SENTENCE_RUN}{0,80}(?:remains?\\s+(?:available|supported|possible)|is still\\s+(?:available|supported|possible)|stays?\\s+available)`,
      'iu',
    ).test(text) ||
    new RegExp(
      `(?:rollback|downgrade)${SENTENCE_RUN}{0,80}(?:remains?\\s+(?:available|supported|possible)|is still\\s+(?:available|supported|possible))${SENTENCE_RUN}{0,80}(?:after|post[- ]cutover)`,
      'iu',
    ).test(text);
  return (
    rollbackTarget &&
    preCutover &&
    postCutoverRecovery &&
    postCutoverClosed &&
    !claimsRollbackAfterCutover
  );
}

function readyDecisionTextPreserved(text: string): boolean {
  const compatibility =
    /v4\.8/iu.test(text) &&
    /v4\.9/iu.test(text) &&
    /dual[- ]read|two[- ]release|two release/iu.test(text);
  return compatibility && readyRollbackBoundaryStated(text) && readyRolloutOrdered(text);
}

function readyNoteActionable(note: PlanNote | null): boolean {
  if (!note || note.status !== 'ready' || (note.openDecisions?.length ?? 0) !== 0) return false;
  if ((note.currentStateEvidence?.length ?? 0) < 2) return false;
  if ((note.risks?.length ?? 0) < 2 || (note.acceptanceCriteria?.length ?? 0) < 2) return false;
  if ((note.verification?.length ?? 0) < 2 || (note.steps?.length ?? 0) < 4) return false;
  const stepText = JSON.stringify(note.steps);
  const hasTargets =
    /implementation\/src\/workspace\/open\.ts/u.test(stepText) &&
    /implementation\/src\/workspace\/save\.ts/u.test(stepText) &&
    /test|verification/iu.test(stepText);
  const structured =
    note.steps?.every(
      (step) =>
        typeof step.target === 'string' &&
        Array.isArray(step.dependsOn) &&
        typeof step.acceptance === 'string' &&
        typeof step.verification === 'string',
    ) ?? false;
  return hasTargets && structured;
}

const readyScorer: SkillEvalDeterministicScorer = {
  id: 'plan-mode/ready-handoff-scorer@4',
  scenarioIds: [READY_HANDOFF],
  score: ({ workingDirectory, observation }) => {
    const implementationPreserved = implementationTreePreserved(workingDirectory);
    const decisionStatePreserved =
      readFileSync(join(workingDirectory, 'planning/decision-state.json'), 'utf8') ===
      `${JSON.stringify(READY_DECISIONS, null, 2)}\n`;
    const note = readJsonArtifact<PlanNote>(workingDirectory, 'planning/plan-note.json');
    const finalPlan = existsSync(join(workingDirectory, 'planning/final-plan.md'))
      ? readFileSync(join(workingDirectory, 'planning/final-plan.md'), 'utf8')
      : '';
    const sections = requiredReadySections(finalPlan) && requiredReadySections(observation.output);
    const decisions =
      readyDecisionsPreserved(note) &&
      readyDecisionTextPreserved(finalPlan) &&
      readyDecisionTextPreserved(observation.output);
    const noteActionable = readyNoteActionable(note);
    const marker = markerCount(finalPlan) === 1 && markerCount(observation.output) === 1;
    const validator = runValidator(workingDirectory);
    const passed =
      implementationPreserved &&
      decisionStatePreserved &&
      sections &&
      decisions &&
      noteActionable &&
      marker &&
      validator.ready;
    return {
      passed,
      quality: passed ? 1 : implementationPreserved && noteActionable ? 0.75 : 0,
      verification: validator.ready ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `implementation tree: ${implementationPreserved ? 'unchanged' : 'changed'}`,
        `decision source: ${decisionStatePreserved ? 'preserved' : 'changed'}`,
        `final plan sections/decisions: ${sections && decisions ? 'complete' : 'incomplete'}`,
        `durable plan note: ${noteActionable ? 'actionable' : 'incomplete'}`,
        `readiness marker: ${marker ? 'gated once' : 'invalid'}`,
        `validator ready: ${validator.ready ? 'yes' : 'no'}`,
        validator.evidence,
      ],
    };
  },
};

const UNRESOLVED_NESTED_INSTRUCTIONS = `# Workspace package planning boundary

Do not infer compatibility or downgrade guarantees from the current implementation. Those are product decisions. Repository evidence can establish current format ownership, test seams, and failure behavior only.
`;

function unresolvedNoteSound(note: PlanNote | null): boolean {
  if (!note || note.status === 'ready') return false;
  const open = (note.openDecisions ?? []).map(String);
  if (!open.includes('compatibilityTarget') || !open.includes('rollbackPolicy')) return false;
  const confirmedText = JSON.stringify(note.confirmedDecisions ?? {});
  if (/v4\.8 and v4\.9|require v4\.9|downgrade-safe|forward-repair/iu.test(confirmedText))
    return false;
  if ((note.currentStateEvidence?.length ?? 0) < 2 || (note.steps?.length ?? 0) < 2) return false;
  return (
    note.steps?.every(
      (step) =>
        typeof step.target === 'string' &&
        Array.isArray(step.dependsOn) &&
        typeof step.verification === 'string',
    ) ?? false
  );
}

function materialQuestionsPresent(text: string): boolean {
  const questionCount = text.match(/\?/gu)?.length ?? 0;
  const compatibility = /compatib|v4\.8|v4\.9|version support|overlap/iu.test(text);
  const rollback = /rollback|downgrade|forward[- ]repair|write cutover/iu.test(text);
  return questionCount >= 2 && questionCount <= 4 && compatibility && rollback;
}

const unresolvedScorer: SkillEvalDeterministicScorer = {
  id: 'plan-mode/unresolved-decisions-scorer@1',
  scenarioIds: [UNRESOLVED],
  score: ({ workingDirectory, observation }) => {
    const implementationPreserved = implementationTreePreserved(workingDirectory, {
      'packages/workspace/AGENTS.md': UNRESOLVED_NESTED_INSTRUCTIONS,
    });
    const decisionStatePreserved =
      readFileSync(join(workingDirectory, 'planning/decision-state.json'), 'utf8') ===
      `${JSON.stringify(UNRESOLVED_DECISIONS, null, 2)}\n`;
    const note = readJsonArtifact<PlanNote>(workingDirectory, 'planning/plan-note.json');
    const checkpoint = existsSync(join(workingDirectory, 'planning/checkpoint.md'))
      ? readFileSync(join(workingDirectory, 'planning/checkpoint.md'), 'utf8')
      : '';
    const noteSound = unresolvedNoteSound(note);
    const questions =
      materialQuestionsPresent(observation.output) && materialQuestionsPresent(checkpoint);
    const noReadyMarker =
      markerCount(observation.output) === 0 &&
      markerCount(checkpoint) === 0 &&
      (!existsSync(join(workingDirectory, 'planning/final-plan.md')) ||
        markerCount(readFileSync(join(workingDirectory, 'planning/final-plan.md'), 'utf8')) === 0);
    const validator = runValidator(workingDirectory);
    const validatorClosed = !validator.ready;
    const passed =
      implementationPreserved &&
      decisionStatePreserved &&
      noteSound &&
      questions &&
      noReadyMarker &&
      validatorClosed;
    return {
      passed,
      quality: passed ? 1 : implementationPreserved && noteSound && noReadyMarker ? 0.75 : 0,
      verification: validatorClosed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `implementation tree: ${implementationPreserved ? 'unchanged' : 'changed'}`,
        `decision source: ${decisionStatePreserved ? 'preserved' : 'changed'}`,
        `durable open-decision state: ${noteSound ? 'sound' : 'invalid'}`,
        `minimum material questions: ${questions ? 'present' : 'missing'}`,
        `readiness marker: ${noReadyMarker ? 'absent' : 'premature'}`,
        `validator fails closed: ${validatorClosed ? 'yes' : 'no'}`,
        validator.evidence,
      ],
    };
  },
};

export const PLAN_MODE_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  readyMaterializer,
  unresolvedMaterializer,
];

export const PLAN_MODE_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  readyScorer,
  unresolvedScorer,
];
