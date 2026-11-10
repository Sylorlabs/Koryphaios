import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PLAN_MODE_SKILL_EVAL_MATERIALIZERS,
  PLAN_MODE_SKILL_EVAL_SCORERS,
} from '../skill-eval-plan-mode-fixtures';
import type { SkillEvalScenarioV3 } from '../skill-eval-harness';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const READY_HANDOFF = 'plan-mode-full-task-ready-handoff';

/**
 * Verbatim decision summary from a real with-skill candidate artifact
 * (`plan-mode-full-task-ready-handoff_cad6d0db.../files/planning/final-plan.md`).
 * It is the regression case: the pre-cutover rollback boundary names
 * "v2 write cutover" before the rollout statement that follows it, so the
 * previous first-mention rollout-ordering check rejected a correctly ordered plan.
 */
const REAL_ORDERED_DECISION_SUMMARY = `## Decision summary

Migrate workspace storage from \`workspace.json\` formatVersion 1 to formatVersion 2, which the architecture proposal describes as a SQLite index with a JSON compatibility adapter. Do not change implementation during planning.

- **Compatibility:** v4.8 and v4.9 must both read workspaces during a two-release dual-read transition. This permits v4.8 to continue reading v1 workspaces while v4.9 reads v1 and v2. It does not permit v4.8 to read v2 after v2 becomes authoritative.
- **Rollback:** rollback to v4.8 is supported only before v2 write cutover. After cutover, downgrade is unavailable because v4.8 understands only v1; use forward repair instead.
- **Rollout:** \`dual-read -> shadow-write -> v2-write -> cleanup\`. This permits staged validation before writes switch to v2; it makes cleanup dependent on completed compatibility and recovery checks.
`;

const SHUFFLED_ROLLOUT = REAL_ORDERED_DECISION_SUMMARY.replace(
  '`dual-read -> shadow-write -> v2-write -> cleanup`',
  '`cleanup -> dual-read -> shadow-write -> v2-write`',
);

const POST_CUTOVER_ROLLBACK_CLAIMED = REAL_ORDERED_DECISION_SUMMARY.replace(
  'After cutover, downgrade is unavailable because v4.8 understands only v1; use forward repair instead.',
  'After cutover, rollback to v4.8 remains available as a downgrade path in addition to forward repair.',
);

const MISSING_CLEANUP_PHASE = REAL_ORDERED_DECISION_SUMMARY.replace(
  '`dual-read -> shadow-write -> v2-write -> cleanup`. This permits staged validation before writes switch to v2; it makes cleanup dependent on completed compatibility and recovery checks.',
  '`dual-read -> shadow-write -> v2-write`. This permits staged validation before writes switch to v2 and makes the final removal dependent on completed compatibility and recovery checks.',
);

function readyFinalPlanBody(decisionSummary: string): string {
  return `# Workspace storage format migration plan

${decisionSummary}
## Current-state evidence

- implementation/architecture.json identifies workspace.json formatVersion 1 as current and names v4.8 as the v1-only compatibility boundary.
- implementation/src/workspace/open.ts rejects every formatVersion other than 1; implementation/src/workspace/save.ts serializes JSON.

## Detailed implementation plan

Dependency-ordered steps with concrete target surfaces, acceptance criteria, and verification.

1. Define the v2 contract in implementation/src/workspace/open.ts and implementation/src/workspace/save.ts.
2. Ship dual-read so v4.8 and v4.9 both read v1 during the two-release transition.
3. Add shadow-write behind the cutover gate with observable mismatch handling.
4. Perform the gated v2 write cutover with forward repair retained.
5. Complete the post-window removal after the compatibility window and recovery checks pass.

## User journey and failure states

Valid opens and saves per rollout stage; unsupported versions and malformed JSON fail with an actionable error and preserve the source; authorization denial stops before storage open; shadow failures preserve the authoritative v1 save; interrupted v2 writes repair forward.

## Risks and alternatives

- v4.8 is v1-only, so v2 cutover ends downgrade support; staging is the mitigation.
- The current recovery test does not exercise interruption, so failure injection is added before cutover.

## Acceptance criteria

- v4.8 and v4.9 both open v1 workspaces during the two-release dual-read transition, and v4.9 also opens v2.
- Cutover is gated on dual-read and shadow-write evidence, and interrupted writes retain a forward-repair route.

## Verification plan

- Versioned open/save fixtures, invalid and unknown formats, denied paths, injected storage failures, and interruption at durable-write boundaries.
- Host readiness validator reports ready for the synchronized plan note and final plan.

## Remaining assumptions

- Measurable shadow-write gates will be defined before cutover is enabled.
`;
}

function readyPlanNote(): string {
  return `${JSON.stringify(
    {
      status: 'ready',
      request: 'Plan the workspace storage format migration without implementation changes.',
      currentStateEvidence: [
        'implementation/architecture.json identifies v1 ownership and v4.8 compatibility boundary',
        'implementation/src/workspace/open.ts rejects non-v1 formats',
      ],
      confirmedDecisions: {
        compatibilityTarget: {
          resolved: true,
          value:
            'v4.8 and v4.9 must both read workspaces during a two-release dual-read transition',
        },
        rollbackPolicy: {
          resolved: true,
          value:
            'rollback to v4.8 is supported only before v2 write cutover; after cutover use forward repair, not downgrade',
        },
        rolloutShape: {
          resolved: true,
          value: 'dual-read -> shadow-write -> v2-write -> cleanup',
        },
      },
      openDecisions: [],
      steps: [
        {
          target: 'implementation/src/workspace/open.ts',
          dependsOn: [],
          acceptance: 'v1 and v2 formats and adapter consistency are explicit',
          verification: 'focused contract and invalid-input tests',
          recovery: 'retain the original valid workspace',
        },
        {
          target: 'implementation/src/workspace/open.ts',
          dependsOn: ['step 1'],
          acceptance: 'v4.8 and v4.9 both read v1 during the transition',
          verification: 'workspace-open fixture verification',
          recovery: 'preserve the source and defer migration',
        },
        {
          target: 'implementation/src/workspace/save.ts',
          dependsOn: ['step 2'],
          acceptance: 'v1 remains authoritative and shadow failures do not block saves',
          verification: 'workspace-save and injected-failure tests',
          recovery: 'continue from the intact v1 workspace',
        },
        {
          target: 'implementation/src/workspace/save.ts',
          dependsOn: ['step 3'],
          acceptance: 'cutover is gated and forward repair is retained',
          verification: 'cutover, interruption, and recovery tests',
          recovery: 'forward repair from retained workspace state',
        },
      ],
      risks: ['cross-version workspace readability', 'interrupted migration recovery'],
      acceptanceCriteria: [
        'v4.8 and v4.9 both open v1 workspaces during the two-release transition',
        'cutover occurs only after dual-read and shadow-write evidence passes',
      ],
      verification: [
        'versioned open/save fixtures with invalid and unknown formats',
        'injected storage failures and interruption at durable-write boundaries',
      ],
      remainingAssumptions: ['measurable shadow-write gates are defined before cutover'],
    },
    null,
    2,
  )}\n`;
}

async function materializeReadyHandoff(): Promise<string> {
  const scenario = {
    id: READY_HANDOFF,
    skill: 'plan-mode',
    category: 'full-task',
  } as SkillEvalScenarioV3;
  const root = mkdtempSync(join(tmpdir(), 'kory-plan-mode-regression-'));
  roots.push(root);
  const materializer = PLAN_MODE_SKILL_EVAL_MATERIALIZERS.find((item) => item.matches(scenario))!;
  await materializer.materialize(root, scenario);
  writeFileSync(join(root, 'planning', 'plan-note.json'), readyPlanNote());
  return root;
}

function scoreWith(root: string, decisionSummary: string) {
  const scorer = PLAN_MODE_SKILL_EVAL_SCORERS.find((item) =>
    item.scenarioIds.includes(READY_HANDOFF),
  )!;
  const planText = `${readyFinalPlanBody(decisionSummary).trimEnd()}\n\n<!-- KORY_PLAN_READY -->\n`;
  writeFileSync(join(root, 'planning', 'final-plan.md'), planText);
  return scorer.score({
    scenario: {
      id: READY_HANDOFF,
      skill: 'plan-mode',
      category: 'full-task',
    } as SkillEvalScenarioV3,
    experiment: {} as never,
    workingDirectory: root,
    observation: {
      output: planText,
      transcript: [],
      files: [],
      commands: [],
      durationMs: 0,
    } as never,
  });
}

test('scores a faithful ready-handoff candidate as passing with full quality', async () => {
  const root = await materializeReadyHandoff();
  const score = await scoreWith(root, REAL_ORDERED_DECISION_SUMMARY);
  expect(score.passed).toBe(true);
  expect(score.quality).toBe(1);
  expect(score.verification).toBe(1);
  expect(score.evidence).toContain('final plan sections/decisions: complete');
});

test('accepts a rollout ordered after the pre-cutover rollback boundary', async () => {
  const root = await materializeReadyHandoff();
  const score = await scoreWith(root, REAL_ORDERED_DECISION_SUMMARY);
  // The rollback boundary names "v2 write cutover" before the rollout statement;
  // first-mention ordering used to reject exactly this shape.
  expect(score.evidence).toContain('durable plan note: actionable');
  expect(score.passed).toBe(true);
});

test('rejects a rollout sequence that is shuffled', async () => {
  const root = await materializeReadyHandoff();
  const score = await scoreWith(root, SHUFFLED_ROLLOUT);
  expect(score.passed).toBe(false);
  expect(score.evidence).toContain('final plan sections/decisions: incomplete');
});

test('rejects a rollout that omits a phase', async () => {
  const root = await materializeReadyHandoff();
  const score = await scoreWith(root, MISSING_CLEANUP_PHASE);
  expect(score.passed).toBe(false);
  expect(score.evidence).toContain('final plan sections/decisions: incomplete');
});

test('rejects a plan that claims rollback survives the cutover', async () => {
  const root = await materializeReadyHandoff();
  const score = await scoreWith(root, POST_CUTOVER_ROLLBACK_CLAIMED);
  expect(score.passed).toBe(false);
  expect(score.evidence).toContain('final plan sections/decisions: incomplete');
});
