import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSkillEvalSuiteV3,
  compareCompetitiveExperimentControls,
  createPairedSkillExperimentsV3,
  validateBlindSemanticJudgeAssignment,
  validatePairedSkillExperimentsV3,
} from '../../eval/skills/skill-eval-harness';
import {
  buildPairwiseRoutingConfusionMatrix,
  buildSkillEvaluationCard,
  CURRENT_SKILL_EVAL_CONTRACT_VERSION,
  evaluateSkillPromotion,
  recordSkillEvaluationRun,
  type SkillEvaluationRun,
} from '../skill-evaluations';
import { loadV5SkillPackages } from '../skill-packages';
import { currentV5SkillEvaluationContracts } from '../../eval/skills/skill-eval-current-contract';
import { isDirectSkillSelection, listSkills, resolveSkills } from '../skills';
import { createTaskContract } from '../prompts/index';
import { ensureSkillSteward } from '../skill-stewards';

let root = '';
let skillsHome = '';

function currentTaskIdentity(skill: string, scenarioId: string) {
  const pkg = loadV5SkillPackages().packages.find((item) => item.sidecar.name === skill)!;
  const contract = currentV5SkillEvaluationContracts(pkg, CURRENT_SKILL_EVAL_CONTRACT_VERSION).get(
    scenarioId,
  )!;
  return {
    evaluationContractVersion: contract.evaluationContractVersion,
    evaluationContractHash: contract.evaluationContractHash,
    materializerId: contract.materializerIds[0]!,
    deterministicScorerId: contract.scorerIds[0]!,
  };
}

setDefaultTimeout(60_000);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kory-v5-eval-project-'));
  skillsHome = mkdtempSync(join(tmpdir(), 'kory-v5-eval-home-'));
  process.env.KORYPHAIOS_SKILLS_HOME = skillsHome;
  mkdirSync(join(root, '.git'));
});

afterEach(() => {
  delete process.env.KORYPHAIOS_SKILLS_HOME;
  rmSync(root, { recursive: true, force: true });
  rmSync(skillsHome, { recursive: true, force: true });
});

describe('V5 evaluation harness', () => {
  test('builds a held-out scenario suite from the first-class skill package', () => {
    const skillPackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'skill-authoring-evaluation',
    )!;
    const suite = buildSkillEvalSuiteV3(skillPackage);
    expect(suite).toMatchObject({
      schemaVersion: 3,
      skill: 'skill-authoring-evaluation',
      packageVersion: skillPackage.sidecar.version,
      heldOut: true,
    });
    expect(suite.scenarios).toHaveLength(18);
    expect(suite.scenarios.filter((scenario) => scenario.category === 'full-task')).toHaveLength(2);
    expect(suite.scenarios.every((scenario) => scenario.heldOut)).toBe(true);
    expect(
      suite.scenarios
        .filter((scenario) => scenario.category === 'full-task')
        .every((scenario) => scenario.scorers.some((scorer) => scorer.kind === 'deterministic')),
    ).toBe(true);
  });

  test('creates strict same-model skill/no-skill pairs and reports competitor control mismatches', () => {
    const pair = createPairedSkillExperimentsV3({
      pairId: 'skill-authoring-pair-1',
      suiteId: 'skill-authoring-evaluation:v5.0.0:held-out',
      skill: 'skill-authoring-evaluation',
      skillRevisionHash: 'abc123',
      provider: 'openai',
      model: 'subject-model',
      harnessVersion: 'v3',
      runtimeIdentity: 'kory-test-runtime',
      tools: ['filesystem', 'shell'],
      budget: { inputTokenLimit: 20_000, outputTokenLimit: 4_000, wallClockMs: 120_000 },
      createdAt: '2026-09-01T12:00:00Z',
    });
    expect(validatePairedSkillExperimentsV3(pair.withSkill, pair.withoutSkill)).toEqual({
      valid: true,
      reasons: [],
    });
    const mismatched = {
      ...pair.withoutSkill,
      subject: 'codex' as const,
      runtimeIdentity: 'codex-cli-runtime',
    };
    expect(compareCompetitiveExperimentControls(pair.withSkill, mismatched)).toEqual(['runtime']);
    expect(validatePairedSkillExperimentsV3(pair.withSkill, mismatched).reasons).toEqual(
      expect.arrayContaining(['subject differs', 'runtime identity differs']),
    );
  });

  test('requires blind semantic judges to be blind to variant and intended outcome', () => {
    const assignment = {
      id: 'judge-1',
      suiteId: 'suite-1',
      scenarioId: 'scenario-1',
      pairId: 'pair-1',
      artifactA: ['artifact-a'],
      artifactB: ['artifact-b'],
      dimensions: ['professional quality'],
      blindTo: ['skill-variant', 'expected-outcome'] as const,
    };
    expect(
      validateBlindSemanticJudgeAssignment({ ...assignment, blindTo: [...assignment.blindTo] }),
    ).toEqual({ valid: true, reasons: [] });
    expect(
      validateBlindSemanticJudgeAssignment({ ...assignment, blindTo: ['skill-variant'] }),
    ).toEqual({ valid: false, reasons: ['judge must be blind to expected-outcome'] });
  });

  test('uses package-held-out cases and isolates infrastructure failures from skill regressions', () => {
    const skill = listSkills(root).find((item) => item.name === 'skill-authoring-evaluation')!;
    const card = buildSkillEvaluationCard(root, skill);
    expect(card.suite.categories.positive).toHaveLength(5);
    expect(card.suite.categories.negative).toHaveLength(5);
    expect(card.suite.categories.ambiguous).toHaveLength(3);
    expect(card.suite.categories.adversarial).toHaveLength(3);
    expect(card.suite.categories['full-task']).toHaveLength(2);
    expect(card.cases.every((item) => item.heldOut)).toBe(true);

    const scenario = card.suite.categories.positive[0]!;
    recordSkillEvaluationRun(root, {
      id: 'infra-failed-run',
      skill: skill.name,
      revisionHash: skill.hash,
      caseId: scenario.id,
      provider: 'test-provider',
      model: 'subject-model',
      harnessVersion: 'v3',
      role: 'worker',
      evaluator: 'deterministic',
      passed: false,
      quality: 0,
      verification: 0,
      integrityFailure: false,
      evidence: ['provider-timeout-log'],
      recordedAt: '2026-09-01T12:00:00Z',
      protocolVersion: 3,
      variant: 'with-skill',
      caseCategory: 'positive',
      comparisonId: 'pair-infra',
      routing: { expectedSelection: true, selected: false },
      suiteId: 'skill-authoring-evaluation:v5.0.0:held-out',
      scenarioId: scenario.id,
      experimentId: 'pair-infra:with-skill',
      infrastructureFailure: {
        kind: 'provider',
        retryable: true,
        evidence: ['provider-timeout-log'],
        detail: 'Provider timed out before the scenario executed.',
      },
    });

    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(gate.infrastructureFailures).toBe(1);
    expect(gate.regressionCases).toBe(0);
    expect(gate.status).toBe('insufficient-evidence');
    expect(gate.reasons).toContain(
      'Only infrastructure-failed runs are recorded; no skill outcome has been observed.',
    );
  });

  test('reports pairwise adjacent-skill confusion from held-out routing observations', () => {
    const skill = listSkills(root).find((item) => item.name === 'skill-authoring-evaluation')!;
    const card = buildSkillEvaluationCard(root, skill);
    const testCase = card.suite.categories.negative.find((item) =>
      item.adjacentSkills?.includes('plugin-creator'),
    )!;
    const run: SkillEvaluationRun = {
      id: 'pairwise-false-positive',
      skill: skill.name,
      revisionHash: skill.hash,
      caseId: testCase.id,
      provider: 'test-provider',
      model: 'subject-model',
      harnessVersion: 'v3',
      role: 'worker',
      evaluator: 'deterministic',
      passed: false,
      quality: 0,
      verification: 1,
      integrityFailure: false,
      evidence: ['routing-trace'],
      recordedAt: '2026-09-01T12:00:00Z',
      protocolVersion: 3,
      variant: 'with-skill',
      caseCategory: 'negative',
      comparisonId: 'pair-routing',
      routing: { expectedSelection: false, selected: true, selectedSkills: [skill.name] },
      suiteId: 'skill-authoring-evaluation:v5.0.0:held-out',
      scenarioId: testCase.id,
      experimentId: 'pair-routing:with-skill',
    };
    const matrix = buildPairwiseRoutingConfusionMatrix(card.cases, [run]);
    expect(matrix[0]).toMatchObject({
      adjacentSkill: 'plugin-creator',
      observations: 1,
      falsePositives: 1,
      falseNegatives: 0,
      errorRate: 1,
    });
  });

  // Bound each test as the library grows; every original case and gate still runs.
  // A single synchronous sweep of the original 179 packages exceeded the test timeout.
  const routingPackages = loadV5SkillPackages().packages;
  for (let offset = 0; offset < routingPackages.length; offset += 20) {
    const batch = routingPackages.slice(offset, offset + 20);
    test(`routes held-out package batch ${offset / 20 + 1}/${Math.ceil(routingPackages.length / 20)} through the real resolver at V5 gates`, () => {
      const skillRevisions = listSkills(root);
      const routingFailures: Array<Record<string, unknown>> = [];
      const routingGateFailures: Array<{
        skill: string;
        precision: number;
        recall: number;
      }> = [];
      for (const skillPackage of batch) {
        const observations = skillPackage.evaluation.routing.map((testCase) => {
          const pins =
            skillPackage.sidecar.invocationMode === 'user-invoked' && testCase.expectedSelection
              ? [skillPackage.sidecar.name]
              : undefined;
          const result = resolveSkills(root, testCase.prompt, createTaskContract(testCase.prompt), {
            contextBudget: 60_000,
            skillRevisions,
            pins,
          });
          const selected = result.selected.map((item) => item.skill.name);
          const target = result.selected.find(
            (item) => item.skill.name === skillPackage.sidecar.name,
          );
          const actual = Boolean(
            target && (testCase.selectionScope !== 'direct' || isDirectSkillSelection(target)),
          );
          const missingExpected = testCase.expectedSkills.filter(
            (name) => !selected.includes(name),
          );
          const selectedForbidden = testCase.forbiddenSkills.filter((name) =>
            selected.includes(name),
          );
          const missingHierarchy = actual
            ? [...skillPackage.sidecar.broader, ...skillPackage.sidecar.requires].filter(
                (name) => !selected.includes(name),
              )
            : [];
          return {
            id: testCase.id,
            expected: testCase.expectedSelection,
            actual,
            bundleCorrect:
              !result.blocked &&
              missingExpected.length === 0 &&
              selectedForbidden.length === 0 &&
              missingHierarchy.length === 0,
            selected,
            missingExpected,
            selectedForbidden,
            missingHierarchy,
            blocked: result.blocked,
            hierarchyErrors: result.hierarchyErrors,
          };
        });
        const truePositives = observations.filter((item) => item.expected && item.actual).length;
        const falsePositives = observations.filter((item) => !item.expected && item.actual).length;
        const falseNegatives = observations.filter((item) => item.expected && !item.actual).length;
        const precision = truePositives / (truePositives + falsePositives);
        const recall = truePositives / (truePositives + falseNegatives);
        routingFailures.push(
          ...observations
            .filter((item) => item.expected !== item.actual || !item.bundleCorrect)
            .map((item) => ({ skill: skillPackage.sidecar.name, ...item })),
        );
        if (precision < 0.95 || recall < 0.95) {
          routingGateFailures.push({ skill: skillPackage.sidecar.name, precision, recall });
        }
      }
      expect(routingFailures).toEqual([]);
      expect(routingGateFailures).toEqual([]);
    }, 30_000);
  }

  test('scores universal-router precision from expected and forbidden downstream skills', () => {
    const skill = listSkills(root).find((item) => item.name === 'task-routing')!;
    const card = buildSkillEvaluationCard(root, skill);
    const positive = card.suite.categories.positive[0]!;
    const negative = card.suite.categories.negative[0]!;
    recordSkillEvaluationRun(root, {
      id: 'universal-route-positive',
      skill: skill.name,
      revisionHash: skill.hash,
      caseId: positive.id,
      provider: 'test-provider',
      model: 'subject-model',
      harnessVersion: 'v3',
      role: 'worker',
      evaluator: 'deterministic',
      passed: true,
      quality: 1,
      verification: 1,
      integrityFailure: false,
      evidence: ['route-trace-positive'],
      recordedAt: '2026-09-01T12:00:00Z',
      protocolVersion: 3,
      variant: 'with-skill',
      caseCategory: 'positive',
      comparisonId: 'universal-route-positive-pair',
      routing: {
        expectedSelection: true,
        selected: true,
        selectedSkills: [...(positive.expectedSkills ?? [])],
        expectedSkills: [...(positive.expectedSkills ?? [])],
        forbiddenSkills: [...(positive.forbiddenSkills ?? [])],
      },
      suiteId: 'task-routing:v5.0.0:held-out',
      scenarioId: positive.id,
      experimentId: 'universal-route-positive:with-skill',
    });
    recordSkillEvaluationRun(root, {
      id: 'universal-route-negative',
      skill: skill.name,
      revisionHash: skill.hash,
      caseId: negative.id,
      provider: 'test-provider',
      model: 'subject-model',
      harnessVersion: 'v3',
      role: 'worker',
      evaluator: 'deterministic',
      passed: false,
      quality: 0.5,
      verification: 1,
      integrityFailure: false,
      evidence: ['route-trace-negative'],
      recordedAt: '2026-09-01T12:01:00Z',
      protocolVersion: 3,
      variant: 'with-skill',
      caseCategory: 'negative',
      comparisonId: 'universal-route-negative-pair',
      routing: {
        expectedSelection: true,
        selected: true,
        selectedSkills: [negative.forbiddenSkills![0]!],
        expectedSkills: [...(negative.expectedSkills ?? [])],
        forbiddenSkills: [...(negative.forbiddenSkills ?? [])],
      },
      suiteId: 'task-routing:v5.0.0:held-out',
      scenarioId: negative.id,
      experimentId: 'universal-route-negative:with-skill',
    });
    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(gate.routingPrecision).toBeLessThan(1);
    expect(gate.routingRecall).toBe(1);
  });

  test('carries failed scenarios across revision hashes until the current revision retests them', () => {
    const skill = listSkills(root).find((item) => item.name === 'skill-authoring-evaluation')!;
    ensureSkillSteward(root, skill.name);
    const card = buildSkillEvaluationCard(root, skill);
    const scenario = card.suite.categories.positive[0]!;
    recordSkillEvaluationRun(root, {
      id: 'historical-routing-failure',
      skill: skill.name,
      revisionHash: 'historical-revision',
      caseId: scenario.id,
      provider: 'test-provider',
      model: 'subject-model',
      harnessVersion: 'v3',
      role: 'worker',
      evaluator: 'deterministic',
      passed: false,
      quality: 0,
      verification: 1,
      integrityFailure: false,
      evidence: ['historical-routing-trace'],
      recordedAt: '2026-09-01T11:00:00Z',
      protocolVersion: 3,
      variant: 'with-skill',
      caseCategory: 'positive',
      comparisonId: 'historical-routing-pair',
      routing: { expectedSelection: true, selected: false },
      suiteId: 'skill-authoring-evaluation:v5.0.0:held-out',
      scenarioId: scenario.id,
      experimentId: 'historical-routing-pair:with-skill',
    });

    const withRegression = buildSkillEvaluationCard(root, skill);
    const regression = withRegression.suite.categories.regression.find(
      (item) => item.regressionOfRunId === 'historical-routing-failure',
    );
    expect(regression).toBeDefined();

    const currentPositive = withRegression.suite.categories.positive[0]!;
    for (const [index, category] of withRegression.suite.requiredCategories.entries()) {
      const testCase = withRegression.suite.categories[category][0]!;
      for (const variant of ['with-skill', 'without-skill'] as const) {
        recordSkillEvaluationRun(root, {
          id: `current-${category}-${variant}`,
          skill: skill.name,
          revisionHash: skill.hash,
          caseId: testCase.id,
          provider: 'test-provider',
          model: 'subject-model',
          harnessVersion: 'v3',
          role: 'worker',
          evaluator: index === 0 && variant === 'with-skill' ? 'blind-review' : 'deterministic',
          passed: variant === 'with-skill',
          quality: variant === 'with-skill' ? 0.9 : 0.4,
          verification: variant === 'with-skill' ? 0.9 : 0.4,
          integrityFailure: false,
          evidence: [`current-${category}-${variant}`],
          recordedAt: `2026-09-01T12:0${index}:00Z`,
          protocolVersion: 3,
          variant,
          caseCategory: category,
          comparisonId: `current-pair-${category}`,
          routing: {
            expectedSelection: testCase.expectedSelection,
            selected: testCase.expectedSelection,
          },
          evaluatorProvenance:
            index === 0 && variant === 'with-skill'
              ? {
                  evaluatorId: 'blind-evaluator',
                  // Synthetic independent reviewer identity for this isolated fixture.
                  agentId: 'test-blind-reviewer',
                  kind: 'model',
                  provider: 'independent-reviewer',
                  model: 'reviewer-model-v1',
                  assignmentId: 'blind-assignment',
                  blindTo: ['skill-variant', 'expected-outcome'],
                  evidence: ['blind-assignment'],
                }
              : undefined,
          suiteId: 'skill-authoring-evaluation:v5.0.0:held-out',
          scenarioId: testCase.id,
          experimentId: `current-pair-${category}:${variant}`,
        });
      }
    }
    expect(currentPositive).toBeDefined();
    const blocked = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(blocked.openRegressions).toBe(1);
    expect(blocked.status).toBe('blocked');

    recordSkillEvaluationRun(root, {
      id: 'historical-routing-retest',
      skill: skill.name,
      revisionHash: skill.hash,
      caseId: regression!.id,
      provider: 'test-provider',
      model: 'subject-model',
      harnessVersion: 'v3',
      role: 'worker',
      evaluator: 'deterministic',
      passed: true,
      quality: 0.9,
      verification: 0.9,
      integrityFailure: false,
      evidence: ['historical-routing-retest'],
      recordedAt: '2026-09-01T13:00:00Z',
      protocolVersion: 3,
      variant: 'with-skill',
      caseCategory: 'regression',
      comparisonId: 'historical-routing-retest-pair',
      routing: { expectedSelection: true, selected: true },
      suiteId: 'skill-authoring-evaluation:v5.0.0:held-out',
      scenarioId: regression!.id,
      experimentId: 'historical-routing-retest:with-skill',
      regressionId: 'historical-routing-failure',
    });
    expect(evaluateSkillPromotion(root, skill.name, skill.hash).openRegressions).toBe(0);
  });

  test('treats paired qualification regressions as degradation against the no-skill arm', () => {
    const skill = listSkills(root).find((item) => item.name === 'skill-authoring-evaluation')!;
    const scenario = buildSkillEvaluationCard(root, skill).suite.categories.positive[0]!;
    const recordPair = (input: {
      id: string;
      candidateQuality: number;
      baselineQuality: number;
      recordedAt: string;
    }) => {
      for (const variant of ['with-skill', 'without-skill'] as const) {
        recordSkillEvaluationRun(root, {
          id: `${input.id}-${variant}`,
          skill: skill.name,
          revisionHash: skill.hash,
          caseId: scenario.id,
          provider: 'test-provider',
          model: 'subject-model',
          harnessVersion: 'paired-regression-v2',
          role: 'worker',
          evaluator: 'deterministic',
          passed: false,
          quality: variant === 'with-skill' ? input.candidateQuality : input.baselineQuality,
          verification: 1,
          integrityFailure: false,
          evidence: ['paired qualification evidence'],
          recordedAt: input.recordedAt,
          protocolVersion: 2,
          variant,
          caseCategory: 'positive',
          comparisonId: input.id,
          routing: { expectedSelection: true, selected: true },
        });
      }
    };

    recordPair({
      id: 'equal-failure',
      candidateQuality: 0.5,
      baselineQuality: 0.5,
      recordedAt: '2026-09-01T10:00:00Z',
    });
    expect(evaluateSkillPromotion(root, skill.name, skill.hash).openRegressions).toBe(0);

    recordPair({
      id: 'degraded-failure',
      candidateQuality: 0.4,
      baselineQuality: 0.5,
      recordedAt: '2026-09-01T11:00:00Z',
    });
    expect(evaluateSkillPromotion(root, skill.name, skill.hash).openRegressions).toBe(1);
  });

  test('does not treat supplemental blind quality scores as deterministic regressions', () => {
    const skill = listSkills(root).find((item) => item.name === 'skill-authoring-evaluation')!;
    ensureSkillSteward(root, skill.name);
    const scenario = buildSkillEvaluationCard(root, skill).suite.categories.positive[0]!;
    const base = {
      skill: skill.name,
      revisionHash: skill.hash,
      caseId: scenario.id,
      provider: 'test-provider',
      model: 'subject-model',
      harnessVersion: 'blind-regression-boundary-v1',
      role: 'worker' as const,
      passed: true,
      integrityFailure: false,
      evidence: ['paired artifact evidence'],
      recordedAt: '2026-09-01T12:00:00Z',
      protocolVersion: 3 as const,
      caseCategory: 'positive' as const,
      comparisonId: 'blind-regression-boundary-pair',
      routing: { expectedSelection: true, selected: true },
      suiteId: 'skill-authoring-evaluation:v5.0.0:held-out',
      scenarioId: scenario.id,
      experimentId: 'blind-regression-boundary-pair',
    };
    recordSkillEvaluationRun(root, {
      ...base,
      id: 'blind-regression-boundary-with-skill',
      evaluator: 'blind-review',
      quality: 0.5,
      verification: 0.5,
      evaluatorProvenance: {
        evaluatorId: 'independent-reviewer',
        kind: 'model',
        provider: 'independent-reviewer',
        model: 'reviewer-model-v1',
        agentId: 'blind-regression-boundary-agent',
        assignmentId: 'blind-regression-boundary-assignment',
        blindTo: ['skill-variant', 'expected-outcome'],
        evidence: ['blind assignment'],
      },
      variant: 'with-skill',
    });
    recordSkillEvaluationRun(root, {
      ...base,
      id: 'blind-regression-boundary-without-skill',
      evaluator: 'deterministic',
      quality: 1,
      verification: 1,
      variant: 'without-skill',
      experimentId: 'blind-regression-boundary-pair:without-skill',
    });
    recordSkillEvaluationRun(root, {
      ...base,
      id: 'blind-regression-boundary-deterministic-with-skill',
      evaluator: 'deterministic',
      quality: 1,
      verification: 1,
      variant: 'with-skill',
      experimentId: 'blind-regression-boundary-pair:deterministic-with-skill',
    });
    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(gate.openRegressions).toBe(0);
    expect(gate.passRate).toBe(1);
    expect(gate.quality).toBe(1);
    expect(gate.verification).toBe(1);
    expect(gate.provenancedBlindReviews).toBe(1);
  });

  test('blocks promotion when an active provenanced blind review fails semantic evaluation', () => {
    const skill = listSkills(root).find((item) => item.name === 'skill-authoring-evaluation')!;
    const steward = ensureSkillSteward(root, skill.name);
    const scenario = buildSkillEvaluationCard(root, skill).suite.categories.positive[0]!;
    recordSkillEvaluationRun(root, {
      id: 'blind-semantic-failure',
      skill: skill.name,
      revisionHash: skill.hash,
      caseId: scenario.id,
      provider: 'test-provider',
      model: 'judge-model',
      harnessVersion: 'v5-blind-semantic@99',
      role: 'critic',
      evaluator: 'blind-review',
      passed: false,
      quality: 0.7,
      verification: 0.7,
      integrityFailure: false,
      evidence: ['semantic review found a material quality failure'],
      recordedAt: '2026-09-01T12:30:00Z',
      protocolVersion: 3,
      variant: 'with-skill',
      caseCategory: 'positive',
      comparisonId: 'blind-semantic-failure-pair',
      routing: { expectedSelection: true, selected: true },
      evaluatorProvenance: {
        evaluatorId: 'independent-reviewer',
        kind: 'model',
        provider: 'chatgpt-web',
        model: 'chatgpt-web/pro',
        agentId: `${steward.agentId}:independent`,
        assignmentId: 'blind-semantic-failure-assignment',
        blindTo: ['skill-variant', 'expected-outcome'],
        evidence: ['blind assignment'],
      },
      suiteId: 'skill-authoring-evaluation:v5.0.0:held-out',
      scenarioId: scenario.id,
      experimentId: 'blind-semantic-failure',
    });
    for (const variant of ['with-skill', 'without-skill'] as const) {
      recordSkillEvaluationRun(root, {
        id: `blind-semantic-deterministic-${variant}`,
        skill: skill.name,
        revisionHash: skill.hash,
        caseId: scenario.id,
        provider: 'test-provider',
        model: 'subject-model',
        harnessVersion: 'blind-semantic-execution@1',
        role: 'worker',
        evaluator: 'deterministic',
        passed: true,
        quality: variant === 'with-skill' ? 1 : 0.9,
        verification: 1,
        integrityFailure: false,
        evidence: [`blind-semantic-deterministic-${variant}`],
        recordedAt: '2026-09-01T12:00:00Z',
        protocolVersion: 3,
        variant,
        caseCategory: 'positive',
        comparisonId: 'blind-semantic-failure-pair',
        routing: { expectedSelection: true, selected: true },
        suiteId: 'skill-authoring-evaluation:v5.0.0:held-out',
        scenarioId: scenario.id,
        experimentId: `blind-semantic-deterministic-${variant}`,
      });
    }
    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(gate.status).toBe('blocked');
    expect(gate.provenancedBlindReviews).toBe(1);
    expect(gate.reasons).toContain(
      '1 active provenanced blind review(s) failed semantic evaluation.',
    );
  });

  test('blocks promotion when an active provenanced blind review passes below the 0.9 quality bar', () => {
    const skill = listSkills(root).find((item) => item.name === 'skill-authoring-evaluation')!;
    const steward = ensureSkillSteward(root, skill.name);
    const scenario = buildSkillEvaluationCard(root, skill).suite.categories.positive[0]!;
    recordSkillEvaluationRun(root, {
      id: 'blind-sub-bar-pass',
      skill: skill.name,
      revisionHash: skill.hash,
      caseId: scenario.id,
      provider: 'test-provider',
      model: 'judge-model',
      harnessVersion: 'v5-blind-subbar@99',
      role: 'critic',
      evaluator: 'blind-review',
      passed: true,
      quality: 0.85,
      verification: 0.8,
      integrityFailure: false,
      evidence: ['review passed the pair but scored the with-skill artifact 0.85'],
      recordedAt: '2026-09-01T12:30:00Z',
      protocolVersion: 3,
      variant: 'with-skill',
      caseCategory: 'positive',
      comparisonId: 'blind-sub-bar-pair',
      routing: { expectedSelection: true, selected: true },
      evaluatorProvenance: {
        evaluatorId: 'independent-reviewer',
        kind: 'model',
        provider: 'independent-agent',
        model: 'beam/Beam-1.0-501B-A23B',
        agentId: `${steward.agentId}:independent`,
        assignmentId: 'blind-sub-bar-assignment',
        blindTo: ['skill-variant', 'expected-outcome'],
        evidence: ['blind assignment'],
      },
      suiteId: 'skill-authoring-evaluation:v5.0.0:held-out',
      scenarioId: scenario.id,
      experimentId: 'blind-sub-bar-pass',
    });
    for (const variant of ['with-skill', 'without-skill'] as const) {
      recordSkillEvaluationRun(root, {
        id: `blind-sub-bar-deterministic-${variant}`,
        skill: skill.name,
        revisionHash: skill.hash,
        caseId: scenario.id,
        provider: 'test-provider',
        model: 'subject-model',
        harnessVersion: 'blind-sub-bar-execution@1',
        role: 'worker',
        evaluator: 'deterministic',
        passed: true,
        quality: variant === 'with-skill' ? 1 : 0.9,
        verification: 1,
        integrityFailure: false,
        evidence: [`blind-sub-bar-deterministic-${variant}`],
        recordedAt: '2026-09-01T12:00:00Z',
        protocolVersion: 3,
        variant,
        caseCategory: 'positive',
        comparisonId: 'blind-sub-bar-pair',
        routing: { expectedSelection: true, selected: true },
        suiteId: 'skill-authoring-evaluation:v5.0.0:held-out',
        scenarioId: scenario.id,
        experimentId: `blind-sub-bar-deterministic-${variant}`,
      });
    }
    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(gate.status).toBe('blocked');
    expect(gate.provenancedBlindReviews).toBe(1);
    expect(gate.reasons).toContain(
      '1 active provenanced blind review(s) passed but scored below the 0.9 quality bar; rework the skill rather than re-grading the pair.',
    );
  });

  test.each([
    ['@', '@'],
    ['-v', '-v'],
    ['@', '-v'],
    ['-v', '@'],
  ])(
    'qualification excludes superseded protocol-v3 evaluator generations (%s to %s) even if they finish later',
    (oldSuffix, newSuffix) => {
      // Generic contracts still select the newest observed generation; V5 source
      // freshness has separate exact-registry coverage.
      const skill = {
        ...listSkills(root).find((item) => item.name === 'skill-authoring-evaluation')!,
        name: 'generic-contract-test',
      };
      const scenario = buildSkillEvaluationCard(root, skill).suite.categories['full-task'][0]!;

      const recordPair = (input: {
        generation: number;
        contractHash: string;
        candidatePassed: boolean;
        recordedAt: string;
      }) => {
        for (const variant of ['with-skill', 'without-skill'] as const) {
          recordSkillEvaluationRun(root, {
            id: `contract-${input.contractHash}-${variant}`,
            skill: skill.name,
            revisionHash: skill.hash,
            caseId: scenario.id,
            provider: 'test-provider',
            model: 'subject-model',
            harnessVersion: `v3:${input.contractHash}`,
            role: 'worker',
            evaluator: 'deterministic',
            passed: variant === 'with-skill' ? input.candidatePassed : false,
            quality: variant === 'with-skill' && input.candidatePassed ? 1 : 0,
            verification: 1,
            integrityFailure: false,
            evidence: [`contract-${input.generation}-${variant}`],
            recordedAt: input.recordedAt,
            protocolVersion: 3,
            variant,
            caseCategory: 'full-task',
            comparisonId: `contract-${input.contractHash}-pair`,
            routing: { expectedSelection: true, selected: variant === 'with-skill' },
            suiteId: 'skill-authoring-evaluation:v5.0.0:held-out',
            scenarioId: scenario.id,
            experimentId: `contract-${input.contractHash}-${variant}`,
            evaluationContractHash: input.contractHash,
            evaluationContractVersion: CURRENT_SKILL_EVAL_CONTRACT_VERSION,
            materializerId: `fixture${input.generation === 1 ? oldSuffix : newSuffix}${input.generation}`,
            deterministicScorerId: `scorer${input.generation === 1 ? oldSuffix : newSuffix}${input.generation}`,
          });
        }
      };

      recordPair({
        generation: 2,
        contractHash: '2222222222222222',
        candidatePassed: true,
        recordedAt: '2026-09-01T12:00:00Z',
      });
      // Simulate an older in-flight evaluator completing after the replacement.
      recordPair({
        generation: 1,
        contractHash: '1111111111111111',
        candidatePassed: false,
        recordedAt: '2026-09-01T13:00:00Z',
      });

      const ledgerPath = join(root, '.koryphaios', 'skills', 'evaluations.json');
      const ledgerBefore = readFileSync(ledgerPath, 'utf8');
      const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
      expect(gate.candidateRuns).toBe(1);
      expect(gate.baselineRuns).toBe(1);
      expect(gate.passRate).toBe(1);
      expect(gate.quality).toBe(1);
      expect(readFileSync(ledgerPath, 'utf8')).toBe(ledgerBefore);

      // Distinct hashes at the same newest generation still fail closed.
      recordPair({
        generation: 2,
        contractHash: '3333333333333333',
        candidatePassed: true,
        recordedAt: '2026-09-01T14:00:00Z',
      });
      const conflicting = evaluateSkillPromotion(root, skill.name, skill.hash);
      expect(conflicting.status).toBe('unmeasured');
      expect(conflicting.candidateRuns).toBe(0);
      expect(conflicting.reasons[0]).toContain('superseded or conflicting evaluation contracts');
    },
  );

  test('generic qualification prefers the newest global evaluation-contract epoch', () => {
    const skill = {
      ...listSkills(root).find((item) => item.name === 'skill-authoring-evaluation')!,
      name: 'generic-contract-test',
    };
    const scenario = buildSkillEvaluationCard(root, skill).suite.categories['full-task'][0]!;
    const recordPair = (version: number, hash: string, candidatePassed: boolean) => {
      for (const variant of ['with-skill', 'without-skill'] as const) {
        recordSkillEvaluationRun(root, {
          id: `contract-version-${version}-${variant}`,
          skill: skill.name,
          revisionHash: skill.hash,
          caseId: scenario.id,
          provider: 'test-provider',
          model: 'subject-model',
          harnessVersion: `v3:${hash}`,
          role: 'worker',
          evaluator: 'deterministic',
          passed: variant === 'with-skill' ? candidatePassed : false,
          quality: variant === 'with-skill' && candidatePassed ? 1 : 0,
          verification: 1,
          integrityFailure: false,
          evidence: [`contract-version-${version}-${variant}`],
          recordedAt: version === 3 ? '2026-09-01T12:00:00Z' : '2026-09-01T13:00:00Z',
          protocolVersion: 3,
          variant,
          caseCategory: 'full-task',
          comparisonId: `contract-version-${version}-pair`,
          routing: { expectedSelection: true, selected: variant === 'with-skill' },
          suiteId: 'skill-authoring-evaluation:v5.0.0:held-out',
          scenarioId: scenario.id,
          experimentId: `contract-version-${version}-${variant}`,
          evaluationContractHash: hash,
          evaluationContractVersion: version,
          materializerId: 'fixture@1',
          deterministicScorerId: 'scorer@1',
        });
      }
    };

    recordPair(3, '3333333333333333', true);
    recordPair(2, '2222222222222222', false);

    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(gate.candidateRuns).toBe(1);
    expect(gate.baselineRuns).toBe(1);
    expect(gate.passRate).toBe(1);
    expect(gate.quality).toBe(1);
  });

  test('generic qualification allows revision-bound contract hashes to differ across skill revisions', () => {
    const skill = {
      ...listSkills(root).find((item) => item.name === 'skill-authoring-evaluation')!,
      name: 'generic-contract-test',
    };
    const scenario = buildSkillEvaluationCard(root, skill).suite.categories['full-task'][0]!;
    const recordPair = (revisionHash: string, contractHash: string) => {
      for (const variant of ['with-skill', 'without-skill'] as const) {
        recordSkillEvaluationRun(root, {
          id: `revision-contract-${revisionHash}-${variant}`,
          skill: skill.name,
          revisionHash,
          caseId: scenario.id,
          provider: 'test-provider',
          model: 'subject-model',
          harnessVersion: `v3:${contractHash}`,
          role: 'worker',
          evaluator: 'deterministic',
          passed: variant === 'with-skill',
          quality: variant === 'with-skill' ? 1 : 0,
          verification: 1,
          integrityFailure: false,
          evidence: [`revision-contract-${revisionHash}-${variant}`],
          recordedAt: '2026-09-01T12:00:00Z',
          protocolVersion: 3,
          variant,
          caseCategory: 'full-task',
          comparisonId: `revision-contract-${revisionHash}-pair`,
          routing: { expectedSelection: true, selected: variant === 'with-skill' },
          suiteId: 'skill-authoring-evaluation:v5.0.0:held-out',
          scenarioId: scenario.id,
          experimentId: `revision-contract-${revisionHash}-${variant}`,
          evaluationContractHash: contractHash,
          evaluationContractVersion: CURRENT_SKILL_EVAL_CONTRACT_VERSION,
          materializerId: 'fixture@1',
          deterministicScorerId: 'scorer@1',
        });
      }
    };

    recordPair('historical-revision', '1111111111111111');
    recordPair(skill.hash, '2222222222222222');

    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(gate.candidateRuns).toBe(1);
    expect(gate.baselineRuns).toBe(1);
    expect(gate.reasons.some((reason) => reason.includes('Evaluation contract conflict'))).toBe(
      false,
    );
  });

  test.each(['@', '-v'])(
    'qualification excludes superseded blind-review harness generations (%s)',
    (suffix) => {
      const skill = listSkills(root).find((item) => item.name === 'skill-authoring-evaluation')!;
      const scenario = buildSkillEvaluationCard(root, skill).suite.categories['full-task'][0]!;
      const steward = ensureSkillSteward(root, skill.name);
      const recordBlind = (
        generation: number,
        passed: boolean,
        recordedAt: string,
        provenanceOverrides: Partial<NonNullable<SkillEvaluationRun['evaluatorProvenance']>> = {},
      ) =>
        recordSkillEvaluationRun(root, {
          id: `blind-generation-${generation}`,
          skill: skill.name,
          revisionHash: skill.hash,
          caseId: scenario.id,
          provider: 'test-provider',
          model: 'judge-model',
          harnessVersion: `v5-blind-semantic${suffix}${generation}`,
          role: 'critic',
          evaluator: 'blind-review',
          passed,
          quality: passed ? 0.9 : 0.4,
          verification: passed ? 0.9 : 0.4,
          integrityFailure: false,
          evidence: [`blind-generation-${generation}`],
          recordedAt,
          protocolVersion: 3,
          variant: 'with-skill',
          caseCategory: 'full-task',
          comparisonId: 'blind-generation-pair',
          routing: { expectedSelection: true, selected: true },
          evaluatorProvenance: {
            evaluatorId: `blind-evaluator-${generation}`,
            // Synthetic reviewer, distinct from the registered skill author.
            agentId: `test-blind-reviewer-${generation}`,
            kind: 'model',
            provider: 'independent-reviewer',
            model: 'reviewer-model-v1',
            assignmentId: `blind-assignment-${generation}`,
            blindTo: ['skill-variant', 'expected-outcome'],
            evidence: [`blind-assignment-${generation}`],
            ...provenanceOverrides,
          },
          suiteId: 'skill-authoring-evaluation:v5.0.0:held-out',
          scenarioId: scenario.id,
          experimentId: `blind-generation-${generation}`,
          ...currentTaskIdentity(skill.name, scenario.id),
        });

      // Keep the strict V5 recording boundary covered while testing generations.
      for (const invalid of [{ agentId: undefined }, { displayLabel: 'wrong skill' }]) {
        expect(() => recordBlind(3, true, '2026-09-01T14:00:00Z', invalid)).toThrow(
          'V5 blind-review evidence requires',
        );
      }
      for (const invalid of [{ provider: '' }, { model: '' }]) {
        expect(() => recordBlind(3, true, '2026-09-01T14:00:00Z', invalid)).toThrow(
          'Invalid skill evaluation run',
        );
      }

      for (const variant of ['with-skill', 'without-skill'] as const) {
        recordSkillEvaluationRun(root, {
          id: `blind-generation-execution-${variant}`,
          skill: skill.name,
          revisionHash: skill.hash,
          caseId: scenario.id,
          provider: 'test-provider',
          model: 'subject-model',
          harnessVersion: 'blind-generation-execution@1',
          role: 'worker',
          evaluator: 'deterministic',
          passed: true,
          quality: variant === 'with-skill' ? 1 : 0.9,
          verification: 1,
          integrityFailure: false,
          evidence: [`blind-generation-execution-${variant}`],
          recordedAt: '2026-09-01T11:00:00Z',
          protocolVersion: 3,
          variant,
          caseCategory: 'full-task',
          comparisonId: 'blind-generation-pair',
          routing: { expectedSelection: true, selected: true },
          suiteId: 'skill-authoring-evaluation:v5.0.0:held-out',
          scenarioId: scenario.id,
          experimentId: `blind-generation-execution-${variant}`,
          ...currentTaskIdentity(skill.name, scenario.id),
        });
      }

      recordBlind(2, true, '2026-09-01T12:00:00Z');
      // An obsolete blind evaluator may finish after its replacement; it must not
      // reopen a regression or dilute qualification under the current harness.
      recordBlind(1, false, '2026-09-01T13:00:00Z');

      const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
      expect(gate.candidateRuns).toBe(2);
      expect(gate.provenancedBlindReviews).toBe(1);
      expect(gate.passRate).toBe(1);
      expect(gate.openRegressions).toBe(0);

      // A valid provider identity is insufficient when the reviewer is the author.
      recordBlind(3, true, '2026-09-01T14:00:00Z', { agentId: steward.agentId });
      expect(evaluateSkillPromotion(root, skill.name, skill.hash).provenancedBlindReviews).toBe(0);
    },
  );

  test('qualification supersedes a failed blind retry when a newer current pair is reviewed', () => {
    const skill = listSkills(root).find((item) => item.name === 'skill-authoring-evaluation')!;
    const scenario = buildSkillEvaluationCard(root, skill).suite.categories['full-task'][0]!;
    ensureSkillSteward(root, skill.name);

    const recordPair = (pairId: string, recordedAt: string) => {
      for (const variant of ['with-skill', 'without-skill'] as const) {
        recordSkillEvaluationRun(root, {
          id: `${pairId}-${variant}`,
          skill: skill.name,
          revisionHash: skill.hash,
          caseId: scenario.id,
          provider: 'test-provider',
          model: 'subject-model',
          harnessVersion: 'v3:current-contract',
          role: 'worker',
          evaluator: 'deterministic',
          passed: variant === 'with-skill',
          quality: variant === 'with-skill' ? 1 : 0,
          verification: 1,
          integrityFailure: false,
          evidence: [`${pairId}-${variant}`],
          recordedAt,
          protocolVersion: 3,
          variant,
          caseCategory: 'full-task',
          comparisonId: pairId,
          routing: { expectedSelection: true, selected: variant === 'with-skill' },
          suiteId: 'skill-authoring-evaluation:v5.0.0:held-out',
          scenarioId: scenario.id,
          experimentId: `${pairId}-${variant}`,
          ...currentTaskIdentity(skill.name, scenario.id),
        });
      }
    };
    const recordBlind = (input: {
      id: string;
      pairId: string;
      passed: boolean;
      recordedAt: string;
      reviewer: string;
    }) =>
      recordSkillEvaluationRun(root, {
        id: input.id,
        skill: skill.name,
        revisionHash: skill.hash,
        caseId: scenario.id,
        provider: 'test-provider',
        model: 'judge-model',
        harnessVersion: 'v5-blind-semantic@4',
        role: 'critic',
        evaluator: 'blind-review',
        passed: input.passed,
        quality: input.passed ? 1 : 0,
        verification: input.passed ? 1 : 0,
        integrityFailure: false,
        evidence: [input.id],
        recordedAt: input.recordedAt,
        protocolVersion: 3,
        variant: 'with-skill',
        caseCategory: 'full-task',
        comparisonId: input.pairId,
        routing: { expectedSelection: true, selected: true },
        evaluatorProvenance: {
          evaluatorId: input.id,
          agentId: input.reviewer,
          kind: 'model',
          provider: 'chatgpt-web',
          model: 'chatgpt-web/high',
          assignmentId: `assignment-${input.id}`,
          blindTo: ['skill-variant', 'expected-outcome'],
          evidence: [input.id],
        },
        suiteId: 'skill-authoring-evaluation:v5.0.0:held-out',
        scenarioId: scenario.id,
        experimentId: input.id,
        ...currentTaskIdentity(skill.name, scenario.id),
      });

    recordPair('blind-retry-old-pair', '2026-09-01T12:00:00Z');
    recordPair('blind-retry-new-pair', '2026-09-01T13:00:00Z');
    // The obsolete review finishes last, but its deterministic pair is older.
    recordBlind({
      id: 'blind-retry-old-failure',
      pairId: 'blind-retry-old-pair',
      passed: false,
      recordedAt: '2026-09-01T15:00:00Z',
      reviewer: 'blind-retry-reviewer-old',
    });
    recordBlind({
      id: 'blind-retry-new-pass-a',
      pairId: 'blind-retry-new-pair',
      passed: true,
      recordedAt: '2026-09-01T14:00:00Z',
      reviewer: 'blind-retry-reviewer-new-a',
    });
    recordBlind({
      id: 'blind-retry-new-pass-b',
      pairId: 'blind-retry-new-pair',
      passed: true,
      recordedAt: '2026-09-01T14:05:00Z',
      reviewer: 'blind-retry-reviewer-new-b',
    });

    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(gate.provenancedBlindReviews).toBe(2);
    expect(
      gate.reasons.some((reason) => reason.includes('active provenanced blind review(s) failed')),
    ).toBe(false);
  });

  test('qualification excludes blind reviews tied to superseded structured evaluator contracts', () => {
    const skill = listSkills(root).find((item) => item.name === 'skill-authoring-evaluation')!;
    const scenario = buildSkillEvaluationCard(root, skill).suite.categories['full-task'][0]!;
    ensureSkillSteward(root, skill.name);

    for (const variant of ['with-skill', 'without-skill'] as const) {
      recordSkillEvaluationRun(root, {
        id: `structured-current-${variant}`,
        skill: skill.name,
        revisionHash: skill.hash,
        caseId: scenario.id,
        provider: 'test-provider',
        model: 'subject-model',
        harnessVersion: 'v3:structured-current',
        role: 'worker',
        evaluator: 'deterministic',
        passed: variant === 'with-skill',
        quality: variant === 'with-skill' ? 1 : 0,
        verification: 1,
        integrityFailure: false,
        evidence: [`structured-current-${variant}`],
        recordedAt: '2026-09-01T12:00:00Z',
        protocolVersion: 3,
        variant,
        caseCategory: 'full-task',
        comparisonId: 'structured-current-pair',
        routing: { expectedSelection: true, selected: variant === 'with-skill' },
        suiteId: 'skill-authoring-evaluation:v5.0.0:held-out',
        scenarioId: scenario.id,
        experimentId: `structured-current-${variant}`,
        ...currentTaskIdentity(skill.name, scenario.id),
      });
    }

    const recordBlind = (input: {
      id: string;
      passed: boolean;
      recordedAt: string;
      contractHash: string;
      materializerId: string;
      scorerId: string;
    }) =>
      recordSkillEvaluationRun(root, {
        id: input.id,
        skill: skill.name,
        revisionHash: skill.hash,
        caseId: scenario.id,
        provider: 'test-provider',
        model: 'judge-model',
        harnessVersion: 'v5-blind-semantic@4',
        role: 'critic',
        evaluator: 'blind-review',
        passed: input.passed,
        quality: input.passed ? 1 : 0,
        verification: input.passed ? 1 : 0,
        integrityFailure: false,
        evidence: [input.id],
        recordedAt: input.recordedAt,
        protocolVersion: 3,
        variant: 'with-skill',
        caseCategory: 'full-task',
        comparisonId: 'structured-current-pair',
        routing: { expectedSelection: true, selected: true },
        evaluatorProvenance: {
          evaluatorId: input.id,
          agentId: `reviewer-${input.id}`,
          kind: 'model',
          provider: 'chatgpt-web',
          model: 'chatgpt-web/high',
          assignmentId: `assignment-${input.id}`,
          blindTo: ['skill-variant', 'expected-outcome'],
          evidence: [input.id],
        },
        suiteId: 'skill-authoring-evaluation:v5.0.0:held-out',
        scenarioId: scenario.id,
        experimentId: input.id,
        evaluationContractHash: input.contractHash,
        evaluationContractVersion: CURRENT_SKILL_EVAL_CONTRACT_VERSION,
        materializerId: input.materializerId,
        deterministicScorerId: input.scorerId,
      });

    recordBlind({
      id: 'blind-superseded-structured',
      passed: false,
      recordedAt: '2026-09-01T12:30:00Z',
      contractHash: '1111111111111111',
      materializerId: 'fixture@1',
      scorerId: 'scorer@1',
    });
    recordBlind({
      id: 'blind-current-structured',
      passed: true,
      recordedAt: '2026-09-01T13:00:00Z',
      contractHash: currentTaskIdentity(skill.name, scenario.id).evaluationContractHash,
      materializerId: currentTaskIdentity(skill.name, scenario.id).materializerId,
      scorerId: currentTaskIdentity(skill.name, scenario.id).deterministicScorerId,
    });

    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(gate.provenancedBlindReviews).toBe(1);
    expect(gate.openRegressions).toBe(0);
  });
});
