import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FINOPS_FULL_TASK_EVAL_CONSTANTS,
  FINOPS_FULL_TASK_SKILL_EVAL_MATERIALIZERS,
  FINOPS_FULL_TASK_SKILL_EVAL_SCORERS,
  scoreFinopsFullTask,
} from '../skill-eval-finops-full-task-fixtures';
import type { SkillEvalScenarioV3 } from '../skill-eval-harness';

const roots: string[] = [];
const finopsTaskRoot = join(import.meta.dir, '../../../../skills-v5/finops-cloud-cost/evals/tasks');

interface AuthoredTaskContract {
  falsifiableChecks: Array<{ id: string; assertion: string }>;
  requiredEvidence: string[];
}

function authoredTask(filename: 'scenario-1.json' | 'scenario-2.json'): AuthoredTaskContract {
  return JSON.parse(readFileSync(join(finopsTaskRoot, filename), 'utf8')) as AuthoredTaskContract;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function scenario(id: string): SkillEvalScenarioV3 {
  return {
    id,
    skill: 'finops-cloud-cost',
    category: 'full-task',
    prompt: 'Apply finops expertise to this task',
    expectedSelection: true,
    expectedSkills: [],
    forbiddenSkills: [],
    heldOut: true,
    adjacentSkills: [],
    tags: ['held-out', 'full-task'],
    environment: {
      kind: 'repository',
      startingState: 'fixture://finops-cloud-cost/test',
      requirements: [],
    },
    falsifiableChecks: [],
    scorers: [],
    requiredEvidence: [],
    requiredArtifacts: [],
  };
}

async function rootFor(id: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'kory-finops-full-'));
  roots.push(root);
  const materializer = FINOPS_FULL_TASK_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches(scenario(id)),
  );
  expect(materializer).toBeDefined();
  await materializer!.materialize(root, scenario(id));
  return root;
}

const verification = {
  checks: [
    'scope-and-hierarchy',
    'operating-contract',
    'execution-invariant',
    'verification-discipline',
    'anti-pattern-resistance',
    'evidence-and-uncertainty',
  ].map((id) => ({
    id,
    status: 'passed',
    evidence: 'Verified from immutable evaluator evidence.',
  })),
  negativePath:
    'Overlapping or unsafe optimization recommendations remain deferred instead of summed.',
  recovery:
    'Keep rollback state and remeasure effective cost plus reliability guardrails after changes.',
  evidenceLabels: {
    fixture: 'observed',
    liveProvider: 'unavailable',
    pairedEvaluation: 'external-evaluator',
  },
};

function validCommitmentResult(
  monitoring: Record<string, unknown> = {
    status: 'hypothetical-not-purchased',
    commitCoverage: 0.488,
    commitUtilization: 1,
    guardrailsPass: true,
  },
): Record<string, unknown> {
  return {
    scenarioId: FINOPS_FULL_TASK_EVAL_CONSTANTS.scenarioCommitment,
    boundary: 'finops-cloud-cost',
    costContract: {
      provider: 'Azure',
      export: 'FOCUS-compatible-evaluator-ledger',
      schemaVersion: '1.1',
      periods: ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08'],
      currency: 'USD',
      costLens: 'effective',
    },
    reconciliation: { reconciled: true },
    commitmentDecision: {
      existingCommitmentHourly: 25,
      worstDemandHourly: 75,
      maxSafeNewCommitHourly: 40,
      providerProposedHourly: 70,
      purchaseAllowedNow: false,
      reasons: [
        'migration-decision-pending',
        'provider-proposal-above-safe-bound',
        'pending-usage-optimization',
        'noncancellable-term',
      ],
      providerEstimateBasis: 'list-price',
      providerLookbackDays: 7,
    },
    monitoring,
    governance: {
      owner: 'cloud-finops',
      reviewCadence: 'weekly',
      renewalReviewDaysBefore: 45,
    },
    uncertainty: ['Live provider entitlement and current recommendations are unavailable.'],
  };
}

describe('FinOps full-task fixtures', () => {
  test('authored contracts require only scenario-applicable full-task evidence at current generations', () => {
    const allocationTask = authoredTask('scenario-1.json');
    const commitmentTask = authoredTask('scenario-2.json');
    const allocationVerification = allocationTask.falsifiableChecks.find(
      (check) => check.id === 'verification-discipline',
    )?.assertion;
    const commitmentVerification = commitmentTask.falsifiableChecks.find(
      (check) => check.id === 'verification-discipline',
    )?.assertion;

    expect(allocationVerification).toContain(
      'Do not require unrelated full commitment purchase-sizing or post-purchase monitoring evidence',
    );
    expect(allocationTask.requiredEvidence).toContain(
      'Allocation/shared-cost/unallocated coverage plus business/resource unit-economics definitions and driver decomposition',
    );
    expect(allocationTask.requiredEvidence).toContain(
      'Implemented before/after effective-cost realized savings, transaction-normalized unit cost, reliability/performance guardrails, owner/governance and rollback/action ledger',
    );
    expect(
      allocationTask.requiredEvidence.some((item) =>
        item.startsWith('Usage/rightsize/rate/commitment scenarios using effective costs'),
      ),
    ).toBe(false);

    expect(commitmentVerification).toContain(
      'Do not require unrelated allocation/unit-economics or implemented realized-savings evidence',
    );
    expect(commitmentTask.requiredEvidence).toContain(
      'Steady, migration, seasonal, growth, and pending-optimization demand scenarios with utilization-floor safe commitment bound',
    );
    expect(commitmentTask.requiredEvidence).toContain(
      'Hypothetical post-purchase monitoring, reliability/performance guardrails, owner/governance, and renewal controls without claiming realized savings',
    );
    expect(
      commitmentTask.requiredEvidence.some((item) => item.startsWith('Allocation/shared-cost/')),
    ).toBe(false);

    expect(FINOPS_FULL_TASK_SKILL_EVAL_MATERIALIZERS.map((item) => item.id)).toEqual([
      'finops-cloud-cost/reconciled-ledger-full-task@3',
      'finops-cloud-cost/commitment-ledger-full-task@4',
    ]);
    expect(FINOPS_FULL_TASK_SKILL_EVAL_SCORERS.map((item) => item.id)).toEqual([
      'finops-cloud-cost/reconciled-ledger-full-task-scorer@3',
      'finops-cloud-cost/commitment-ledger-full-task-scorer@4',
    ]);
  });

  test('materialized guides expose exact scenario result shapes and formula semantics', async () => {
    const allocationRoot = await rootFor(FINOPS_FULL_TASK_EVAL_CONSTANTS.scenarioAllocation);
    const allocationStarter = JSON.parse(readFileSync(join(allocationRoot, 'result.json'), 'utf8'));
    expect(allocationStarter.reconciliation).toEqual({
      billedRowTotal: null,
      invoiceTotal: null,
      reconciled: null,
    });
    expect(allocationStarter.recommendationDecision).toEqual({
      selectedRecommendationIds: [],
      deferredRecommendationIds: [],
    });

    const commitmentRoot = await rootFor(FINOPS_FULL_TASK_EVAL_CONSTANTS.scenarioCommitment);
    const commitmentStarter = JSON.parse(readFileSync(join(commitmentRoot, 'result.json'), 'utf8'));
    expect(commitmentStarter.monitoring).toEqual({
      status: '<status-enum>',
      commitCoverage: null,
      commitUtilization: null,
      guardrailsPass: null,
    });
    expect(commitmentStarter.commitmentDecision.reasons).toEqual(['<reason-code>']);
    const readme = readFileSync(join(commitmentRoot, 'README.md'), 'utf8');
    expect(readme).toContain(
      'maxSafeNewCommitHourly = uncoveredWorstHourly * utilizationFloor',
    );
    expect(readme).toContain(
      'commitCoverage = hypothetical new commitment / observed eligible usage',
    );
    expect(readme).toContain(
      'commitUtilization = min(observed eligible usage / hypothetical new commitment, 1)',
    );
    expect(readme).toContain('migration-decision-pending');
    expect(readme).toContain('provider-proposal-above-safe-bound');
    expect(readme).toContain('pending-usage-optimization');
    expect(readme).toContain('noncancellable-term');
    expect(readme).toContain(
      'monitoring.status must be exactly hypothetical-not-purchased',
    );
    expect(readme).toContain(
      'negativePath and recovery must each be descriptive strings (at least 20 characters)',
    );
  });

  test('scenario 1 independently verifies reconciliation, allocation, unit economics, and realized savings', async () => {
    const root = await rootFor(FINOPS_FULL_TASK_EVAL_CONSTANTS.scenarioAllocation);
    writeFileSync(
      join(root, 'result.json'),
      JSON.stringify(
        {
          scenarioId: FINOPS_FULL_TASK_EVAL_CONSTANTS.scenarioAllocation,
          boundary: 'finops-cloud-cost',
          costContract: {
            provider: 'AWS',
            export: 'CUR-compatible-evaluator-ledger',
            schemaVersion: '2.0',
            period: '2026-08',
            currency: 'USD',
            costLens: 'billed-and-effective',
          },
          reconciliation: { billedRowTotal: 10000, invoiceTotal: 10000, reconciled: true },
          allocation: {
            allocated: { 'team-a': 5280, 'team-b': 3720 },
            sharedPool: 2800,
            unallocated: 1000,
            unallocatedPercent: 10,
          },
          unitEconomics: {
            denominatorSource: 'product-transaction-ledger',
            current: { 'team-a': 2.2, 'team-b': 3.1 },
            prior: { 'team-a': 2, 'team-b': 3.5 },
          },
          recommendationDecision: {
            selectedRecommendationIds: ['R1'],
            deferredRecommendationIds: ['R2', 'C1'],
          },
          realizedSavings: {
            effectiveSavings: 700,
            beforeUnitCost: 2.457,
            afterUnitCost: 2.17,
            guardrailsPass: true,
            rollbackReady: true,
          },
          governance: { owner: 'platform-finops', reviewCadence: 'monthly' },
          uncertainty: [
            'Live provider state is unavailable; conclusions are bounded to fixture evidence.',
          ],
        },
        null,
        2,
      ) + '\n',
    );
    writeFileSync(join(root, 'verification.json'), JSON.stringify(verification, null, 2) + '\n');

    const score = scoreFinopsFullTask(FINOPS_FULL_TASK_EVAL_CONSTANTS.scenarioAllocation, root);
    expect(score.passed, score.evidence.join('\n')).toBe(true);
    expect(score.integrityFailure).toBe(false);
  });

  test('scenario 2 independently bounds a commitment and preserves migration/irreversibility risk', async () => {
    const root = await rootFor(FINOPS_FULL_TASK_EVAL_CONSTANTS.scenarioCommitment);
    writeFileSync(
      join(root, 'result.json'),
      JSON.stringify(validCommitmentResult(), null, 2) + '\n',
    );
    writeFileSync(join(root, 'verification.json'), JSON.stringify(verification, null, 2) + '\n');

    const score = scoreFinopsFullTask(FINOPS_FULL_TASK_EVAL_CONSTANTS.scenarioCommitment, root);
    expect(score.passed, score.evidence.join('\n')).toBe(true);
    expect(score.integrityFailure).toBe(false);
  });

  test('scenario 2 scores coverage and utilization as distinct monitoring metrics', async () => {
    const root = await rootFor(FINOPS_FULL_TASK_EVAL_CONSTANTS.scenarioCommitment);
    writeFileSync(
      join(root, 'result.json'),
      JSON.stringify(
        validCommitmentResult({
          status: 'hypothetical-not-purchased',
          commitCoverage: 0.488,
          commitUtilization: 0.488,
          guardrailsPass: true,
        }),
        null,
        2,
      ) + '\n',
    );
    writeFileSync(join(root, 'verification.json'), JSON.stringify(verification, null, 2) + '\n');

    const score = scoreFinopsFullTask(FINOPS_FULL_TASK_EVAL_CONSTANTS.scenarioCommitment, root);
    expect(score.passed).toBe(false);
    expect(score.evidence).toContain('monitor coverage recomputed: pass');
    expect(score.evidence).toContain('monitor utilization recomputed: fail');
  });

  test('verification paths must remain descriptive strings', async () => {
    const root = await rootFor(FINOPS_FULL_TASK_EVAL_CONSTANTS.scenarioCommitment);
    writeFileSync(
      join(root, 'result.json'),
      JSON.stringify(validCommitmentResult(), null, 2) + '\n',
    );
    writeFileSync(
      join(root, 'verification.json'),
      JSON.stringify(
        {
          ...verification,
          negativePath: { summary: verification.negativePath },
        },
        null,
        2,
      ) + '\n',
    );

    const score = scoreFinopsFullTask(FINOPS_FULL_TASK_EVAL_CONSTANTS.scenarioCommitment, root);
    expect(score.passed).toBe(false);
    expect(score.evidence).toContain('negative path recorded: fail');
  });

  test('altered evaluator billing evidence fails closed as an integrity violation', async () => {
    const root = await rootFor(FINOPS_FULL_TASK_EVAL_CONSTANTS.scenarioAllocation);
    writeFileSync(join(root, 'evidence/packet.json'), '{"tampered":true}\n');
    const score = scoreFinopsFullTask(FINOPS_FULL_TASK_EVAL_CONSTANTS.scenarioAllocation, root);
    expect(score.passed).toBe(false);
    expect(score.integrityFailure).toBe(true);
  });
});
