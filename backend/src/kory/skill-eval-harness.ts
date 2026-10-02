import type {
  SkillBlindDimension,
  SkillEvaluationCase,
  SkillEvaluationCaseCategory,
  SkillEvaluationVariant,
  SkillEvaluatorProvenance,
} from './skill-evaluations';
import type {
  V5CompiledSkillPackage,
  V5EvalEnvironment,
  V5EvalScorer,
  V5FullTaskFixture,
} from './skill-packages';

export type SkillEvalSubject = 'kory' | 'codex' | 'claude' | 'other';

export interface SkillEvalBudget {
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  wallClockMs?: number;
  costLimitUsd?: number;
}

export interface SkillEvalScenarioV3 {
  id: string;
  skill: string;
  category: SkillEvaluationCaseCategory;
  prompt: string;
  expectedSelection: boolean;
  selectionScope?: 'direct' | 'bundle';
  expectedSkills: string[];
  forbiddenSkills: string[];
  heldOut: boolean;
  adjacentSkills: string[];
  tags: string[];
  environment: V5EvalEnvironment;
  falsifiableChecks: V5FullTaskFixture['falsifiableChecks'];
  scorers: V5EvalScorer[];
  requiredEvidence: string[];
  requiredArtifacts: string[];
  regressionOfRunId?: string;
}

export interface SkillEvalSuiteV3 {
  schemaVersion: 3;
  id: string;
  skill: string;
  packageVersion: string;
  heldOut: true;
  scenarios: SkillEvalScenarioV3[];
  regressionScenarioIds: string[];
}

export interface SkillEvalExperimentV3 {
  schemaVersion: 3;
  id: string;
  pairId: string;
  suiteId: string;
  skill: string;
  subject: SkillEvalSubject;
  provider: string;
  model: string;
  harnessVersion: string;
  role: 'worker' | 'critic';
  variant: SkillEvaluationVariant;
  skillRevisionHash: string | null;
  runtimeIdentity: string;
  tools: string[];
  budget: SkillEvalBudget;
  createdAt: string;
}

export interface SkillEvalPairValidation {
  valid: boolean;
  reasons: string[];
}

export interface SkillBlindSemanticJudgeAssignment {
  id: string;
  suiteId: string;
  scenarioId: string;
  pairId: string;
  artifactA: string[];
  artifactB: string[];
  dimensions: string[];
  blindTo: SkillBlindDimension[];
}

export interface SkillBlindSemanticJudgeResult {
  assignmentId: string;
  evaluator: SkillEvaluatorProvenance;
  winner: 'a' | 'b' | 'tie';
  scores: Record<string, { a: number; b: number }>;
  evidence: string[];
}

const stableJson = (value: unknown) => JSON.stringify(value, Object.keys(value as object).sort());

const routingScorer = (): V5EvalScorer => ({
  id: 'routing-selection',
  kind: 'deterministic',
  weight: 1,
  evidence: ['selected skill set', 'expected selection decision'],
});

function caseToRegressionScenario(
  skill: string,
  testCase: SkillEvaluationCase,
): SkillEvalScenarioV3 {
  return {
    id: testCase.id,
    skill,
    category: 'regression',
    prompt: testCase.prompt,
    expectedSelection: testCase.expectedSelection,
    selectionScope: testCase.selectionScope,
    expectedSkills: [...(testCase.expectedSkills ?? [])],
    forbiddenSkills: [...(testCase.forbiddenSkills ?? [])],
    heldOut: testCase.heldOut ?? true,
    adjacentSkills: [...(testCase.adjacentSkills ?? [])],
    tags: [...(testCase.tags ?? []), 'regression'],
    environment:
      testCase.environment ??
      ({ kind: 'synthetic', startingState: 'none', requirements: [] } satisfies V5EvalEnvironment),
    falsifiableChecks: [],
    scorers: testCase.scorers?.length ? [...testCase.scorers] : [routingScorer()],
    requiredEvidence: [...testCase.requiredEvidence],
    requiredArtifacts: [...(testCase.requiredArtifacts ?? [])],
    regressionOfRunId: testCase.regressionOfRunId,
  };
}

export function buildSkillEvalSuiteV3(
  skillPackage: V5CompiledSkillPackage,
  regressionCases: SkillEvaluationCase[] = [],
): SkillEvalSuiteV3 {
  const routingScenarios: SkillEvalScenarioV3[] = skillPackage.evaluation.routing.map((item) => ({
    id: item.id,
    skill: skillPackage.sidecar.name,
    category: item.category,
    prompt: item.prompt,
    expectedSelection: item.expectedSelection,
    selectionScope: item.selectionScope,
    expectedSkills: [...item.expectedSkills],
    forbiddenSkills: [...item.forbiddenSkills],
    heldOut: true,
    adjacentSkills: [...item.adjacentSkills],
    tags: [...item.tags],
    environment: { kind: 'synthetic', startingState: 'none', requirements: [] },
    falsifiableChecks: [],
    scorers: [routingScorer()],
    requiredEvidence: ['selected skill set', 'expected selection decision'],
    requiredArtifacts: [],
  }));
  const taskScenarios: SkillEvalScenarioV3[] = skillPackage.evaluation.tasks.map((task) => ({
    id: task.id,
    skill: skillPackage.sidecar.name,
    category: 'full-task',
    prompt: task.prompt,
    expectedSelection: true,
    expectedSkills: [],
    forbiddenSkills: [],
    heldOut: true,
    adjacentSkills: [],
    tags: ['held-out', 'full-task'],
    environment: task.environment,
    falsifiableChecks: [...task.falsifiableChecks],
    scorers: task.scorers,
    requiredEvidence: task.requiredEvidence,
    requiredArtifacts: task.requiredArtifacts,
  }));
  const regressions = regressionCases
    .filter((item) => item.category === 'regression')
    .map((item) => caseToRegressionScenario(skillPackage.sidecar.name, item));
  const scenarios = [...routingScenarios, ...taskScenarios, ...regressions];
  if (new Set(scenarios.map((item) => item.id)).size !== scenarios.length) {
    throw new Error(
      `V5 evaluation suite for ${skillPackage.sidecar.name} contains duplicate scenario IDs`,
    );
  }
  return {
    schemaVersion: 3,
    id: `${skillPackage.sidecar.name}:v${skillPackage.sidecar.version}:held-out`,
    skill: skillPackage.sidecar.name,
    packageVersion: skillPackage.sidecar.version,
    heldOut: true,
    scenarios,
    regressionScenarioIds: regressions.map((item) => item.id),
  };
}

export function createPairedSkillExperimentsV3(input: {
  pairId: string;
  suiteId: string;
  skill: string;
  skillRevisionHash: string;
  subject?: SkillEvalSubject;
  provider: string;
  model: string;
  harnessVersion: string;
  role?: 'worker' | 'critic';
  runtimeIdentity: string;
  tools: string[];
  budget?: SkillEvalBudget;
  createdAt?: string;
}): { withSkill: SkillEvalExperimentV3; withoutSkill: SkillEvalExperimentV3 } {
  const shared = {
    schemaVersion: 3 as const,
    pairId: input.pairId,
    suiteId: input.suiteId,
    skill: input.skill,
    subject: input.subject ?? ('kory' as const),
    provider: input.provider,
    model: input.model,
    harnessVersion: input.harnessVersion,
    role: input.role ?? ('worker' as const),
    runtimeIdentity: input.runtimeIdentity,
    tools: [...input.tools].sort(),
    budget: { ...(input.budget ?? {}) },
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  return {
    withSkill: {
      ...shared,
      id: `${input.pairId}:with-skill`,
      variant: 'with-skill',
      skillRevisionHash: input.skillRevisionHash,
    },
    withoutSkill: {
      ...shared,
      id: `${input.pairId}:without-skill`,
      variant: 'without-skill',
      skillRevisionHash: null,
    },
  };
}

export function validatePairedSkillExperimentsV3(
  left: SkillEvalExperimentV3,
  right: SkillEvalExperimentV3,
): SkillEvalPairValidation {
  const reasons: string[] = [];
  if (left.pairId !== right.pairId) reasons.push('pairId differs');
  if (left.suiteId !== right.suiteId) reasons.push('suiteId differs');
  if (left.skill !== right.skill) reasons.push('skill differs');
  if (left.subject !== right.subject) reasons.push('subject differs');
  if (left.provider !== right.provider) reasons.push('provider differs');
  if (left.model !== right.model) reasons.push('model differs');
  if (left.harnessVersion !== right.harnessVersion) reasons.push('harnessVersion differs');
  if (left.role !== right.role) reasons.push('role differs');
  if (left.runtimeIdentity !== right.runtimeIdentity) reasons.push('runtime identity differs');
  if (left.tools.join('\0') !== right.tools.join('\0')) reasons.push('available tools differ');
  if (stableJson(left.budget) !== stableJson(right.budget)) reasons.push('budget differs');
  if (new Set([left.variant, right.variant]).size !== 2) {
    reasons.push('pair must contain one with-skill and one without-skill experiment');
  }
  const withSkill = left.variant === 'with-skill' ? left : right;
  const withoutSkill = left.variant === 'without-skill' ? left : right;
  if (!withSkill.skillRevisionHash) reasons.push('with-skill experiment lacks revision hash');
  if (withoutSkill.skillRevisionHash !== null) {
    reasons.push('without-skill experiment must withhold the skill revision');
  }
  return { valid: reasons.length === 0, reasons };
}

export function compareCompetitiveExperimentControls(
  reference: SkillEvalExperimentV3,
  competitor: SkillEvalExperimentV3,
): string[] {
  const mismatches: string[] = [];
  if (reference.suiteId !== competitor.suiteId) mismatches.push('suite');
  if (reference.role !== competitor.role) mismatches.push('role');
  if (reference.runtimeIdentity !== competitor.runtimeIdentity) mismatches.push('runtime');
  if (reference.tools.join('\0') !== competitor.tools.join('\0')) mismatches.push('tools');
  if (stableJson(reference.budget) !== stableJson(competitor.budget)) mismatches.push('budget');
  return mismatches;
}

export function validateBlindSemanticJudgeAssignment(
  assignment: SkillBlindSemanticJudgeAssignment,
): SkillEvalPairValidation {
  const reasons: string[] = [];
  if (!assignment.artifactA.length || !assignment.artifactB.length) {
    reasons.push('both randomized artifact sets are required');
  }
  if (!assignment.dimensions.length) reasons.push('at least one judge dimension is required');
  if (!assignment.blindTo.includes('skill-variant'))
    reasons.push('judge must be blind to skill-variant');
  if (!assignment.blindTo.includes('expected-outcome')) {
    reasons.push('judge must be blind to expected-outcome');
  }
  return { valid: reasons.length === 0, reasons };
}
