import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { serverLog } from '../logger';
import type { SkillRevision } from './skills';
import { loadV5SkillPackages, type V5EvalEnvironment, type V5EvalScorer } from './skill-packages';
import {
  buildSkillStewardDisplayLabel,
  getSkillSteward,
  isChatGptWebSkillStewardIdentity,
} from './skill-stewards';

export type SkillEvaluationCaseCategory =
  'positive' | 'negative' | 'ambiguous' | 'adversarial' | 'full-task' | 'regression';

/** Current global epoch for protocol-v3 full-task evaluator semantics. */
export const CURRENT_SKILL_EVAL_CONTRACT_VERSION = 3;
const SKILL_EVALUATION_LOCK_STALE_MS = 5 * 60_000;
const SKILL_EVALUATION_LOCK_WAIT_MS = 30_000;
const SKILL_EVALUATION_LOCK_RETRY_MS = 25;
const SKILL_EVALUATION_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

export type SkillEvaluationVariant = 'with-skill' | 'without-skill';

export type SkillBlindDimension =
  'skill-variant' | 'revision' | 'expected-selection' | 'expected-outcome';

export interface SkillEvaluatorProvenance {
  evaluatorId: string;
  kind: 'human' | 'model';
  provider?: string;
  model?: string;
  agentId?: string;
  displayLabel?: string;
  assignmentId?: string;
  blindTo: SkillBlindDimension[];
  evidence: string[];
}

export interface SkillRoutingObservation {
  expectedSelection: boolean;
  selected: boolean;
  selectionScope?: 'direct' | 'bundle';
  selectedSkills?: string[];
  expectedSkills?: string[];
  forbiddenSkills?: string[];
}

export type SkillInfrastructureFailureKind =
  'setup' | 'provider' | 'tool' | 'timeout' | 'environment-drift' | 'artifact-capture';

export interface SkillInfrastructureFailure {
  kind: SkillInfrastructureFailureKind;
  retryable: boolean;
  evidence: string[];
  detail: string;
}

export interface SkillRuntimeArtifact {
  kind: 'log' | 'state' | 'screenshot' | 'trace' | 'report' | 'other';
  location: string;
  sha256?: string;
}

/** Evidence ledger for skills. It stores observed results; it never calls a model or invents a score. */
export interface SkillEvaluationCase {
  id: string;
  skill: string;
  category: SkillEvaluationCaseCategory;
  prompt: string;
  expectedSelection: boolean;
  selectionScope?: 'direct' | 'bundle';
  expectedSkills?: string[];
  forbiddenSkills?: string[];
  requiredEvidence: string[];
  heldOut?: boolean;
  adjacentSkills?: string[];
  tags?: string[];
  environment?: V5EvalEnvironment;
  scorers?: V5EvalScorer[];
  requiredArtifacts?: string[];
  originCaseId?: string;
  regressionOfRunId?: string;
}

export interface SkillEvaluationRun {
  id: string;
  skill: string;
  revisionHash: string;
  caseId: string;
  provider: string;
  model: string;
  harnessVersion: string;
  role: 'worker' | 'critic';
  medium?: string;
  evaluator: 'deterministic' | 'blind-review' | 'human-blind-review' | 'human-review';
  passed: boolean;
  quality: number;
  verification: number;
  integrityFailure: boolean;
  evidence: string[];
  notes?: string;
  recordedAt: string;
  /** Present on the stronger evidence protocol. Omitted legacy runs remain valid. */
  protocolVersion?: 2 | 3;
  /** Whether this run used the candidate skill or intentionally withheld it as a baseline. */
  variant?: SkillEvaluationVariant;
  /** Stored with the observation so promotion does not infer benchmark intent from a score. */
  caseCategory?: SkillEvaluationCaseCategory;
  /** Stable identifier for matching with-skill and without-skill observations. */
  comparisonId?: string;
  routing?: SkillRoutingObservation;
  evaluatorProvenance?: SkillEvaluatorProvenance;
  /** Source run identifier for an explicit regression retest. */
  regressionId?: string;
  suiteId?: string;
  scenarioId?: string;
  experimentId?: string;
  /** Immutable identity of the task/materializer/scorer contract used for this observation. */
  evaluationContractHash?: string;
  /** Global evaluation-contract epoch. Older protocol-v3 rows without this field are epoch 2. */
  evaluationContractVersion?: number;
  /** Concrete fixture implementation used by protocol-v3 deterministic runs. */
  materializerId?: string;
  /** Concrete deterministic evaluator used by protocol-v3 deterministic runs. */
  deterministicScorerId?: string;
  infrastructureFailure?: SkillInfrastructureFailure;
  artifacts?: SkillRuntimeArtifact[];
}

export interface SkillPairwiseRoutingConfusion {
  adjacentSkill: string;
  observations: number;
  correct: number;
  falsePositives: number;
  falseNegatives: number;
  errorRate: number;
}

export interface SkillPromotionGate {
  status: 'unmeasured' | 'insufficient-evidence' | 'blocked' | 'ready';
  candidateRuns: number;
  baselineRuns: number;
  distinctHarnesses: number;
  distinctProviders: number;
  distinctModels: number;
  humanBlindReviews: number;
  provenancedBlindReviews: number;
  passRate: number | null;
  quality: number | null;
  verification: number | null;
  /** Backward-compatible revision-to-revision comparison requested with baselineHash. */
  baselineDelta: number | null;
  pairedBaselineCases: number;
  pairedBaselineCategories: SkillEvaluationCaseCategory[];
  pairedBaselineCategoryCounts: Record<SkillEvaluationCaseCategory, number>;
  skillBaselinePassRateDelta: number | null;
  skillBaselineQualityDelta: number | null;
  skillBaselineVerificationDelta: number | null;
  routingObservations: number;
  routingPrecision: number | null;
  routingRecall: number | null;
  infrastructureFailures: number;
  regressionCases: number;
  openRegressions: number;
  categoryCoverage: Record<SkillEvaluationCaseCategory, number>;
  reasons: string[];
}

export interface SkillBenchmarkSuite {
  requiredCategories: SkillEvaluationCaseCategory[];
  categories: Record<SkillEvaluationCaseCategory, SkillEvaluationCase[]>;
}

export interface SkillEvaluationCard {
  skill: string;
  revisionHash: string;
  cases: SkillEvaluationCase[];
  suite: SkillBenchmarkSuite;
  routingConfusions: SkillPairwiseRoutingConfusion[];
  gate: SkillPromotionGate;
  runs: SkillEvaluationRun[];
}

const CASE_CATEGORIES: SkillEvaluationCaseCategory[] = [
  'positive',
  'negative',
  'ambiguous',
  'adversarial',
  'full-task',
  'regression',
];

const REQUIRED_BENCHMARK_CATEGORIES: SkillEvaluationCaseCategory[] = [
  'positive',
  'negative',
  'ambiguous',
  'adversarial',
  'full-task',
];

const BLIND_DIMENSIONS: SkillBlindDimension[] = [
  'skill-variant',
  'revision',
  'expected-selection',
  'expected-outcome',
];

const V5_PACKAGES_BY_NAME = new Map(
  loadV5SkillPackages().packages.map((skillPackage) => [skillPackage.sidecar.name, skillPackage]),
);

const ledgerPath = (projectRoot: string) =>
  join(resolve(projectRoot), '.koryphaios', 'skills', 'evaluations.json');

const validStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const validRouting = (value: unknown): value is SkillRoutingObservation => {
  const routing = value as SkillRoutingObservation;
  return Boolean(
    routing &&
    typeof routing.expectedSelection === 'boolean' &&
    typeof routing.selected === 'boolean' &&
    (routing.selectionScope === undefined ||
      routing.selectionScope === 'bundle' ||
      routing.selectionScope === 'direct') &&
    (routing.selectedSkills === undefined || validStringArray(routing.selectedSkills)) &&
    (routing.expectedSkills === undefined || validStringArray(routing.expectedSkills)) &&
    (routing.forbiddenSkills === undefined || validStringArray(routing.forbiddenSkills)),
  );
};

const validInfrastructureFailure = (value: unknown): value is SkillInfrastructureFailure => {
  const failure = value as SkillInfrastructureFailure;
  return Boolean(
    failure &&
    ['setup', 'provider', 'tool', 'timeout', 'environment-drift', 'artifact-capture'].includes(
      failure.kind,
    ) &&
    typeof failure.retryable === 'boolean' &&
    validStringArray(failure.evidence) &&
    typeof failure.detail === 'string' &&
    failure.detail,
  );
};

const validRuntimeArtifact = (value: unknown): value is SkillRuntimeArtifact => {
  const artifact = value as SkillRuntimeArtifact;
  return Boolean(
    artifact &&
    ['log', 'state', 'screenshot', 'trace', 'report', 'other'].includes(artifact.kind) &&
    typeof artifact.location === 'string' &&
    artifact.location &&
    (artifact.sha256 === undefined || /^[a-f0-9]{64}$/i.test(artifact.sha256)),
  );
};

const validEvaluatorProvenance = (value: unknown): value is SkillEvaluatorProvenance => {
  const provenance = value as SkillEvaluatorProvenance;
  if (
    !provenance ||
    typeof provenance.evaluatorId !== 'string' ||
    !provenance.evaluatorId ||
    !['human', 'model'].includes(provenance.kind) ||
    (provenance.agentId !== undefined &&
      (typeof provenance.agentId !== 'string' || !provenance.agentId)) ||
    (provenance.displayLabel !== undefined &&
      (typeof provenance.displayLabel !== 'string' || !provenance.displayLabel)) ||
    !Array.isArray(provenance.blindTo) ||
    !provenance.blindTo.every((item) => BLIND_DIMENSIONS.includes(item)) ||
    !validStringArray(provenance.evidence)
  ) {
    return false;
  }
  if (provenance.kind === 'model') {
    return Boolean(provenance.provider && provenance.model);
  }
  return true;
};

const validRun = (value: unknown): value is SkillEvaluationRun => {
  const run = value as SkillEvaluationRun;
  return Boolean(
    run &&
    typeof run.id === 'string' &&
    typeof run.skill === 'string' &&
    typeof run.revisionHash === 'string' &&
    typeof run.caseId === 'string' &&
    typeof run.provider === 'string' &&
    typeof run.model === 'string' &&
    typeof run.harnessVersion === 'string' &&
    (run.role === 'worker' || run.role === 'critic') &&
    ['deterministic', 'blind-review', 'human-blind-review', 'human-review'].includes(
      run.evaluator,
    ) &&
    typeof run.passed === 'boolean' &&
    typeof run.integrityFailure === 'boolean' &&
    typeof run.quality === 'number' &&
    run.quality >= 0 &&
    run.quality <= 1 &&
    typeof run.verification === 'number' &&
    run.verification >= 0 &&
    run.verification <= 1 &&
    validStringArray(run.evidence) &&
    typeof run.recordedAt === 'string' &&
    (run.protocolVersion === undefined || run.protocolVersion === 2 || run.protocolVersion === 3) &&
    (run.variant === undefined || ['with-skill', 'without-skill'].includes(run.variant)) &&
    (run.caseCategory === undefined || CASE_CATEGORIES.includes(run.caseCategory)) &&
    (run.comparisonId === undefined || typeof run.comparisonId === 'string') &&
    (run.routing === undefined || validRouting(run.routing)) &&
    (run.evaluatorProvenance === undefined || validEvaluatorProvenance(run.evaluatorProvenance)) &&
    (run.regressionId === undefined || typeof run.regressionId === 'string') &&
    (run.suiteId === undefined || typeof run.suiteId === 'string') &&
    (run.scenarioId === undefined || typeof run.scenarioId === 'string') &&
    (run.experimentId === undefined || typeof run.experimentId === 'string') &&
    (run.evaluationContractHash === undefined ||
      /^[a-f0-9]{16,64}$/iu.test(run.evaluationContractHash)) &&
    (run.evaluationContractVersion === undefined ||
      (Number.isInteger(run.evaluationContractVersion) && run.evaluationContractVersion >= 1)) &&
    (run.materializerId === undefined || typeof run.materializerId === 'string') &&
    (run.deterministicScorerId === undefined || typeof run.deterministicScorerId === 'string') &&
    (run.infrastructureFailure === undefined ||
      validInfrastructureFailure(run.infrastructureFailure)) &&
    (run.artifacts === undefined ||
      (Array.isArray(run.artifacts) && run.artifacts.every(validRuntimeArtifact))),
  );
};

const isBlindReview = (run: SkillEvaluationRun) =>
  run.evaluator === 'blind-review' || run.evaluator === 'human-blind-review';

const usesModernEvidenceProtocol = (run: SkillEvaluationRun) =>
  run.protocolVersion === 2 ||
  run.protocolVersion === 3 ||
  run.variant !== undefined ||
  run.caseCategory !== undefined ||
  run.comparisonId !== undefined ||
  run.routing !== undefined ||
  run.evaluatorProvenance !== undefined ||
  run.regressionId !== undefined ||
  run.suiteId !== undefined ||
  run.scenarioId !== undefined ||
  run.experimentId !== undefined ||
  run.evaluationContractHash !== undefined ||
  run.evaluationContractVersion !== undefined ||
  run.materializerId !== undefined ||
  run.deterministicScorerId !== undefined ||
  run.infrastructureFailure !== undefined ||
  run.artifacts !== undefined;

export function listSkillEvaluationRuns(projectRoot: string, skill?: string): SkillEvaluationRun[] {
  try {
    const data = JSON.parse(readFileSync(ledgerPath(projectRoot), 'utf8'));
    const runs = Array.isArray(data) ? data.filter(validRun) : [];
    return skill ? runs.filter((run) => run.skill === skill) : runs;
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to read skill evaluation ledger',
    );
    return [];
  }
}

function validateSkillEvaluationRunForRecording(run: SkillEvaluationRun): void {
  if (!validRun(run)) throw new Error('Invalid skill evaluation run');
  const contractIdentity = [
    run.evaluationContractHash,
    run.materializerId,
    run.deterministicScorerId,
  ];
  if (contractIdentity.some(Boolean) && !contractIdentity.every(Boolean)) {
    throw new Error(
      'Evaluation contract identity requires evaluationContractHash, materializerId, and deterministicScorerId together',
    );
  }
  if (!run.evidence.length && run.evaluator !== 'deterministic') {
    throw new Error('Human or blind evaluation requires at least one evidence artifact');
  }
  if (run.evaluator === 'blind-review' && !run.evaluatorProvenance) {
    throw new Error('Blind review requires evaluator provenance');
  }
  if (run.infrastructureFailure) {
    if (run.passed) throw new Error('Infrastructure-failed runs cannot be recorded as passed');
    if (!run.infrastructureFailure.evidence.length) {
      throw new Error('Infrastructure failure requires at least one evidence artifact');
    }
    if (run.integrityFailure) {
      throw new Error(
        'Infrastructure failure and skill integrity failure must be classified separately',
      );
    }
  }
  if (run.protocolVersion === 2 || run.protocolVersion === 3) {
    if (!run.variant || !run.caseCategory || !run.routing) {
      throw new Error(
        'Modern evidence runs require variant, caseCategory, and an observed routing decision',
      );
    }
    if (isBlindReview(run)) {
      if (
        !run.evaluatorProvenance ||
        !run.evaluatorProvenance.blindTo.includes('skill-variant') ||
        !run.evaluatorProvenance.evidence.length
      ) {
        throw new Error(
          'Protocol v2 blind reviews require provenance that is blind to the skill variant',
        );
      }
      if (run.protocolVersion === 3 && V5_PACKAGES_BY_NAME.has(run.skill)) {
        const provenance = run.evaluatorProvenance;
        if (
          !provenance.agentId ||
          provenance.displayLabel !== buildSkillStewardDisplayLabel(run.skill) ||
          !provenance.provider ||
          !provenance.model ||
          !isChatGptWebSkillStewardIdentity(provenance.provider, provenance.model)
        ) {
          throw new Error(
            'V5 blind-review evidence requires an actual ChatGPT Web reviewer agent id, exact skill display label, and chatgpt-web model provenance',
          );
        }
      }
    }
  }
  if (run.protocolVersion === 3) {
    if (!run.suiteId || !run.scenarioId || !run.experimentId) {
      throw new Error('Protocol v3 runs require suiteId, scenarioId, and experimentId');
    }
    if (run.scenarioId !== run.caseId) {
      throw new Error('Protocol v3 scenarioId must equal caseId for stable regression identity');
    }
    const skillPackage = V5_PACKAGES_BY_NAME.get(run.skill);
    if (skillPackage) {
      const scenarioIds = new Set([
        ...skillPackage.evaluation.routing.map((item) => item.id),
        ...skillPackage.evaluation.tasks.map((item) => item.id),
      ]);
      if (!scenarioIds.has(run.scenarioId) && run.caseCategory !== 'regression') {
        throw new Error(
          `Protocol v3 scenario ${run.scenarioId} is not in the held-out V5 package suite`,
        );
      }
    }
  }
}

export function recordSkillEvaluationRun(
  projectRoot: string,
  run: SkillEvaluationRun,
): SkillEvaluationRun {
  validateSkillEvaluationRunForRecording(run);
  const path = ledgerPath(projectRoot);
  withSkillEvaluationLedgerLock(path, () => {
    const existing = listSkillEvaluationRuns(projectRoot);
    const next = [...existing.filter((item) => item.id !== run.id), run];
    writeSkillEvaluationLedger(path, next);
  });
  return run;
}

/**
 * Persist a validated set of evaluation observations atomically. Large V5
 * routing campaigns can contain thousands of paired rows; rewriting the whole
 * ledger for each row is both slow and unnecessarily failure-prone.
 */
export function recordSkillEvaluationRuns(
  projectRoot: string,
  runs: readonly SkillEvaluationRun[],
): SkillEvaluationRun[] {
  for (const run of runs) validateSkillEvaluationRunForRecording(run);
  const replacementIds = new Set(runs.map((run) => run.id));
  if (replacementIds.size !== runs.length) {
    throw new Error('Evaluation run batch contains duplicate run IDs');
  }
  const path = ledgerPath(projectRoot);
  withSkillEvaluationLedgerLock(path, () => {
    const existing = listSkillEvaluationRuns(projectRoot).filter(
      (item) => !replacementIds.has(item.id),
    );
    const next = [...existing, ...runs];
    writeSkillEvaluationLedger(path, next);
  });
  return [...runs];
}

function writeSkillEvaluationLedger(path: string, runs: readonly SkillEvaluationRun[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(runs, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch (error: unknown) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

function withSkillEvaluationLedgerLock<T>(path: string, operation: () => T): T {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + SKILL_EVALUATION_LOCK_WAIT_MS;
  mkdirSync(dirname(path), { recursive: true });

  while (true) {
    try {
      const stat = lstatSync(lockPath);
      if (
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        Date.now() - stat.mtimeMs > SKILL_EVALUATION_LOCK_STALE_MS
      ) {
        try {
          unlinkSync(lockPath);
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
        }
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
    }

    let descriptor: number | undefined;
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
      writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
      fsyncSync(descriptor);
      return operation();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for skill evaluation ledger lock ${lockPath}`);
      }
      Atomics.wait(SKILL_EVALUATION_LOCK_SLEEP, 0, 0, SKILL_EVALUATION_LOCK_RETRY_MS);
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // Preserve the operation result or error.
        }
        try {
          unlinkSync(lockPath);
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
        }
      }
    }
  }
}

function baseSkillEvaluationCases(skill: SkillRevision): SkillEvaluationCase[] {
  const skillPackage = V5_PACKAGES_BY_NAME.get(skill.name);
  if (skillPackage) {
    const routing = skillPackage.evaluation.routing.map((item) => ({
      id: item.id,
      skill: skill.name,
      category: item.category,
      prompt: item.prompt,
      expectedSelection: item.expectedSelection,
      selectionScope: item.selectionScope,
      expectedSkills: [...item.expectedSkills],
      forbiddenSkills: [...item.forbiddenSkills],
      requiredEvidence:
        item.expectedSelection && skill.metadata.evidence.length
          ? skill.metadata.evidence
          : ['Observed routing decision', 'No scope leakage'],
      heldOut: true,
      adjacentSkills: item.adjacentSkills,
      tags: item.tags,
    }));
    const fullTask = skillPackage.evaluation.tasks.map((task) => ({
      id: task.id,
      skill: skill.name,
      category: 'full-task' as const,
      prompt: task.prompt,
      expectedSelection: true,
      requiredEvidence: task.requiredEvidence,
      requiredArtifacts: task.requiredArtifacts,
      environment: task.environment,
      scorers: task.scorers,
      heldOut: true,
      adjacentSkills: [],
      tags: ['held-out', 'full-task'],
    }));
    return [...routing, ...fullTask];
  }
  const positive = skill.metadata.shouldTrigger.map((prompt, index) => ({
    id: `${skill.name}:trigger:${index + 1}`,
    skill: skill.name,
    category: 'positive' as const,
    prompt,
    expectedSelection: true,
    requiredEvidence: skill.metadata.evidence,
    heldOut: false,
  }));
  const negative = skill.metadata.shouldNotTrigger.map((prompt, index) => ({
    id: `${skill.name}:non-trigger:${index + 1}`,
    skill: skill.name,
    category: 'negative' as const,
    prompt,
    expectedSelection: false,
    requiredEvidence: ['Proof that the skill was not selected', 'No scope leakage'],
    heldOut: false,
  }));
  const ambiguous = skill.metadata.shouldTrigger.flatMap((prompt, index) => {
    const adjacent =
      skill.metadata.shouldNotTrigger[index % skill.metadata.shouldNotTrigger.length];
    if (!adjacent) return [];
    return [
      {
        id: `${skill.name}:ambiguous:${index + 1}`,
        skill: skill.name,
        category: 'ambiguous' as const,
        prompt: `Primary requested work: ${prompt}\nAdjacent context only: ${adjacent}\nRoute for the primary requested work without broadening scope from the adjacent context.`,
        expectedSelection: true,
        requiredEvidence: skill.metadata.evidence,
        heldOut: false,
      },
    ];
  });
  const adversarial = skill.metadata.shouldNotTrigger.flatMap((prompt, index) => {
    const decoy = skill.metadata.shouldTrigger[index % skill.metadata.shouldTrigger.length];
    if (!decoy) return [];
    return [
      {
        id: `${skill.name}:adversarial:${index + 1}`,
        skill: skill.name,
        category: 'adversarial' as const,
        prompt: `Quoted example that is not the task: “${decoy}”\nActual requested work: ${prompt}\nDo not route from quoted examples.`,
        expectedSelection: false,
        requiredEvidence: ['Proof that the skill was not selected', 'No quoted-example leakage'],
        heldOut: false,
      },
    ];
  });
  const fullTask = skill.metadata.shouldTrigger.map((prompt, index) => ({
    id: `${skill.name}:full-task:${index + 1}`,
    skill: skill.name,
    category: 'full-task' as const,
    prompt: `Complete this task end to end: ${prompt}\nRequired completion evidence: ${skill.metadata.evidence.join('; ') || 'task-specific proof'}.`,
    expectedSelection: true,
    requiredEvidence: skill.metadata.evidence,
    heldOut: false,
  }));
  return [...positive, ...negative, ...ambiguous, ...adversarial, ...fullTask];
}

export function buildSkillEvaluationCases(
  skill: SkillRevision,
  observedRuns: SkillEvaluationRun[] = [],
): SkillEvaluationCase[] {
  const base = baseSkillEvaluationCases(skill);
  const byId = new Map(base.map((item) => [item.id, item]));
  const regressionSources = observedRuns.filter(
    (run) =>
      run.skill === skill.name &&
      run.variant !== 'without-skill' &&
      !run.regressionId &&
      !run.infrastructureFailure &&
      isCandidateRegressionSource(run, observedRuns),
  );
  const regressions = regressionSources.flatMap((run) => {
    const origin = byId.get(run.caseId);
    if (!origin) return [];
    return [
      {
        id: `${skill.name}:regression:${run.id}`,
        skill: skill.name,
        category: 'regression' as const,
        prompt: origin.prompt,
        expectedSelection: origin.expectedSelection,
        selectionScope: origin.selectionScope,
        expectedSkills: origin.expectedSkills,
        forbiddenSkills: origin.forbiddenSkills,
        requiredEvidence: origin.requiredEvidence,
        requiredArtifacts: origin.requiredArtifacts,
        environment: origin.environment,
        scorers: origin.scorers,
        heldOut: origin.heldOut,
        adjacentSkills: origin.adjacentSkills,
        tags: [...(origin.tags ?? []), 'regression'],
        originCaseId: origin.id,
        regressionOfRunId: run.id,
      },
    ];
  });
  return [...base, ...regressions];
}

export function buildSkillBenchmarkSuite(
  skill: SkillRevision,
  observedRuns: SkillEvaluationRun[] = [],
): SkillBenchmarkSuite {
  const cases = buildSkillEvaluationCases(skill, observedRuns);
  const categories = Object.fromEntries(
    CASE_CATEGORIES.map((category) => [
      category,
      cases.filter((item) => item.category === category),
    ]),
  ) as Record<SkillEvaluationCaseCategory, SkillEvaluationCase[]>;
  return {
    requiredCategories: [...REQUIRED_BENCHMARK_CATEGORIES],
    categories,
  };
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

const legacyComposite = (run: SkillEvaluationRun) =>
  (run.passed ? 0.5 : 0) + run.quality * 0.3 + run.verification * 0.2;

function pairedNoSkillBaseline(
  run: SkillEvaluationRun,
  runs: readonly SkillEvaluationRun[],
): SkillEvaluationRun | undefined {
  if (!run.comparisonId) return undefined;
  return runs.find(
    (candidate) =>
      candidate.comparisonId === run.comparisonId &&
      candidate.variant === 'without-skill' &&
      !candidate.infrastructureFailure,
  );
}

function regressesAgainstPairedBaseline(
  run: SkillEvaluationRun,
  baseline: SkillEvaluationRun,
): boolean {
  return (
    Number(run.passed) < Number(baseline.passed) ||
    run.quality < baseline.quality ||
    run.verification < baseline.verification
  );
}

function isCandidateRegressionSource(
  run: SkillEvaluationRun,
  runs: readonly SkillEvaluationRun[],
): boolean {
  if (run.integrityFailure) return true;
  const baseline = pairedNoSkillBaseline(run, runs);
  return baseline ? regressesAgainstPairedBaseline(run, baseline) : !run.passed;
}

function regressionAttemptPassed(
  run: SkillEvaluationRun,
  sourceId: string,
  runs: readonly SkillEvaluationRun[],
): boolean {
  if (run.integrityFailure) return false;
  if (run.regressionId === sourceId) return run.passed;
  const baseline = pairedNoSkillBaseline(run, runs);
  return baseline ? !regressesAgainstPairedBaseline(run, baseline) : run.passed;
}

const inferredCategory = (
  run: SkillEvaluationRun,
  skill: string,
): SkillEvaluationCaseCategory | undefined => {
  if (run.caseCategory) return run.caseCategory;
  const prefixes: Array<[string, SkillEvaluationCaseCategory]> = [
    [`${skill}:trigger:`, 'positive'],
    [`${skill}:non-trigger:`, 'negative'],
    [`${skill}:ambiguous:`, 'ambiguous'],
    [`${skill}:adversarial:`, 'adversarial'],
    [`${skill}:full-task:`, 'full-task'],
    [`${skill}:regression:`, 'regression'],
  ];
  return prefixes.find(([prefix]) => run.caseId.startsWith(prefix))?.[1];
};

const comparisonKey = (run: SkillEvaluationRun) =>
  run.comparisonId
    ? ['explicit', run.comparisonId, run.caseId].join('\0')
    : [
        'auto',
        run.caseId,
        run.provider,
        run.model,
        run.harnessVersion,
        run.role,
        run.medium ?? '',
      ].join('\0');

const comparisonSeriesKey = (run: SkillEvaluationRun) =>
  [run.caseId, run.provider, run.model, run.harnessVersion, run.role, run.medium ?? ''].join('\0');

interface SkillBaselineComparison {
  pairedCases: number;
  pairedCategories: SkillEvaluationCaseCategory[];
  pairedCategoryCounts: Record<SkillEvaluationCaseCategory, number>;
  passRateDelta: number | null;
  qualityDelta: number | null;
  verificationDelta: number | null;
}

function compareWithSkillToWithoutSkill(
  skill: string,
  candidateRuns: SkillEvaluationRun[],
  baselineRuns: SkillEvaluationRun[],
): SkillBaselineComparison {
  const candidateGroups = new Map<string, SkillEvaluationRun[]>();
  const baselineGroups = new Map<string, SkillEvaluationRun[]>();
  // Skill/no-skill uplift is a paired execution comparison. Blind and human
  // reviews are supplemental judgments over those artifacts, not another arm
  // of the deterministic experiment. Mixing a critic score into one side of
  // the pair makes unlike evaluator scales look like a behavioral regression.
  for (const run of candidateRuns.filter(
    (item) => item.evaluator === 'deterministic' && inferredCategory(item, skill) !== 'regression',
  )) {
    const key = comparisonKey(run);
    candidateGroups.set(key, [...(candidateGroups.get(key) ?? []), run]);
  }
  for (const run of baselineRuns.filter(
    (item) => item.evaluator === 'deterministic' && inferredCategory(item, skill) !== 'regression',
  )) {
    const key = comparisonKey(run);
    baselineGroups.set(key, [...(baselineGroups.get(key) ?? []), run]);
  }
  const latestCompletePairs = new Map<
    string,
    {
      key: string;
      candidates: SkillEvaluationRun[];
      baselines: SkillEvaluationRun[];
      recordedAt: string;
    }
  >();
  for (const [key, candidates] of candidateGroups) {
    const baselines = baselineGroups.get(key);
    if (!baselines?.length || !candidates.length) continue;
    const seriesKey = comparisonSeriesKey(candidates[0]!);
    const recordedAt = [...candidates, ...baselines].reduce(
      (latest, run) => (run.recordedAt > latest ? run.recordedAt : latest),
      '',
    );
    const current = latestCompletePairs.get(seriesKey);
    if (
      !current ||
      recordedAt > current.recordedAt ||
      (recordedAt === current.recordedAt && key > current.key)
    ) {
      latestCompletePairs.set(seriesKey, { key, candidates, baselines, recordedAt });
    }
  }
  const passDeltas: number[] = [];
  const qualityDeltas: number[] = [];
  const verificationDeltas: number[] = [];
  const categories = new Set<SkillEvaluationCaseCategory>();
  const categoryCounts = Object.fromEntries(
    CASE_CATEGORIES.map((category) => [category, 0]),
  ) as Record<SkillEvaluationCaseCategory, number>;
  for (const { candidates, baselines } of latestCompletePairs.values()) {
    passDeltas.push(
      mean(candidates.map((run) => (run.passed ? 1 : 0))) -
        mean(baselines.map((run) => (run.passed ? 1 : 0))),
    );
    qualityDeltas.push(
      mean(candidates.map((run) => run.quality)) - mean(baselines.map((run) => run.quality)),
    );
    verificationDeltas.push(
      mean(candidates.map((run) => run.verification)) -
        mean(baselines.map((run) => run.verification)),
    );
    const pairedCategories = new Set(
      candidates
        .map((run) => inferredCategory(run, skill))
        .filter((category): category is SkillEvaluationCaseCategory => Boolean(category)),
    );
    for (const category of pairedCategories) {
      categories.add(category);
      categoryCounts[category] += 1;
    }
  }
  return {
    pairedCases: passDeltas.length,
    pairedCategories: CASE_CATEGORIES.filter((category) => categories.has(category)),
    pairedCategoryCounts: categoryCounts,
    passRateDelta: passDeltas.length ? mean(passDeltas) : null,
    qualityDelta: qualityDeltas.length ? mean(qualityDeltas) : null,
    verificationDelta: verificationDeltas.length ? mean(verificationDeltas) : null,
  };
}

function routingSignals(candidateRuns: SkillEvaluationRun[]) {
  const observations = candidateRuns.flatMap((run) => (run.routing ? [run.routing] : []));
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  for (const observation of observations) {
    const hasBundleAssertions =
      (observation.expectedSkills?.length ?? 0) > 0 ||
      (observation.forbiddenSkills?.length ?? 0) > 0;
    if (hasBundleAssertions) {
      const selectedSkills = new Set(observation.selectedSkills ?? []);
      for (const skill of observation.expectedSkills ?? []) {
        if (selectedSkills.has(skill)) truePositives += 1;
        else falseNegatives += 1;
      }
      for (const skill of observation.forbiddenSkills ?? []) {
        if (selectedSkills.has(skill)) falsePositives += 1;
      }
      continue;
    }
    if (observation.expectedSelection && observation.selected) truePositives += 1;
    if (!observation.expectedSelection && observation.selected) falsePositives += 1;
    if (observation.expectedSelection && !observation.selected) falseNegatives += 1;
  }
  const precisionDenominator = truePositives + falsePositives;
  const recallDenominator = truePositives + falseNegatives;
  return {
    observations: observations.length,
    precision: precisionDenominator ? truePositives / precisionDenominator : null,
    recall: recallDenominator ? truePositives / recallDenominator : null,
  };
}

export function buildPairwiseRoutingConfusionMatrix(
  cases: SkillEvaluationCase[],
  runs: SkillEvaluationRun[],
): SkillPairwiseRoutingConfusion[] {
  const byId = new Map(cases.map((item) => [item.id, item]));
  const buckets = new Map<
    string,
    Omit<SkillPairwiseRoutingConfusion, 'adjacentSkill' | 'errorRate'>
  >();
  for (const run of runs) {
    if (run.variant === 'without-skill' || run.infrastructureFailure || !run.routing) continue;
    const testCase = byId.get(run.caseId);
    if (!testCase?.adjacentSkills?.length) continue;
    for (const adjacentSkill of testCase.adjacentSkills) {
      const hasBundleAssertion =
        (testCase.expectedSkills?.includes(adjacentSkill) ?? false) ||
        (testCase.forbiddenSkills?.includes(adjacentSkill) ?? false);
      const expected = hasBundleAssertion
        ? (testCase.expectedSkills?.includes(adjacentSkill) ?? false)
        : run.routing.expectedSelection;
      const selected = hasBundleAssertion
        ? (run.routing.selectedSkills?.includes(adjacentSkill) ?? false)
        : run.routing.selected;
      const bucket = buckets.get(adjacentSkill) ?? {
        observations: 0,
        correct: 0,
        falsePositives: 0,
        falseNegatives: 0,
      };
      bucket.observations += 1;
      if (expected === selected) bucket.correct += 1;
      if (!expected && selected) bucket.falsePositives += 1;
      if (expected && !selected) bucket.falseNegatives += 1;
      buckets.set(adjacentSkill, bucket);
    }
  }
  return [...buckets.entries()]
    .map(([adjacentSkill, bucket]) => ({
      adjacentSkill,
      ...bucket,
      errorRate: bucket.observations
        ? (bucket.falsePositives + bucket.falseNegatives) / bucket.observations
        : 0,
    }))
    .sort(
      (left, right) =>
        right.errorRate - left.errorRate ||
        right.observations - left.observations ||
        left.adjacentSkill.localeCompare(right.adjacentSkill),
    );
}

function regressionSignals(
  skill: string,
  candidateRuns: SkillEvaluationRun[],
  historicalRuns: SkillEvaluationRun[] = candidateRuns,
) {
  // Blind semantic reviews judge the completed artifacts independently; they
  // are supplemental to the deterministic skill/no-skill pair and must not be
  // converted into regression signals by comparing unlike score scales.
  // Deterministic qualification runs are the only observations that can open
  // or close a paired behavioral regression.
  const deterministicCandidateRuns = candidateRuns.filter(
    (run) => run.evaluator === 'deterministic',
  );
  const deterministicHistoricalRuns = historicalRuns.filter(
    (run) => run.evaluator === 'deterministic',
  );
  const activePackage = V5_PACKAGES_BY_NAME.get(skill);
  const activeScenarioIds = activePackage
    ? new Set([
        ...activePackage.evaluation.routing.map((item) => item.id),
        ...activePackage.evaluation.tasks.map((item) => item.id),
      ])
    : null;
  const historicalById = new Map(deterministicHistoricalRuns.map((run) => [run.id, run]));
  const sourceIds = new Set<string>();
  const latestStructuredSourceByContract = new Map<string, SkillEvaluationRun>();
  for (const run of deterministicHistoricalRuns.filter(
    (candidate) =>
      candidate.variant !== 'without-skill' &&
      !candidate.regressionId &&
      !candidate.infrastructureFailure &&
      !(
        activeScenarioIds &&
        candidate.protocolVersion === 3 &&
        candidate.scenarioId &&
        !activeScenarioIds.has(candidate.scenarioId)
      ) &&
      inferredCategory(candidate, skill) !== 'regression' &&
      isCandidateRegressionSource(candidate, deterministicHistoricalRuns),
  )) {
    if (
      run.protocolVersion !== 3 ||
      !run.scenarioId ||
      !run.materializerId ||
      !run.deterministicScorerId
    ) {
      sourceIds.add(run.id);
      continue;
    }
    const semanticContractKey = [
      run.scenarioId,
      run.evaluationContractVersion ?? 2,
      run.materializerId,
      run.deterministicScorerId,
      run.role,
      run.medium ?? '',
    ].join('\0');
    const current = latestStructuredSourceByContract.get(semanticContractKey);
    if (
      !current ||
      run.recordedAt > current.recordedAt ||
      (run.recordedAt === current.recordedAt && run.id > current.id)
    ) {
      latestStructuredSourceByContract.set(semanticContractKey, run);
    }
  }
  for (const run of latestStructuredSourceByContract.values()) sourceIds.add(run.id);
  for (const run of deterministicCandidateRuns) {
    if (run.regressionId) sourceIds.add(run.regressionId);
  }
  let open = 0;
  const openSourceIds: string[] = [];
  for (const sourceId of sourceIds) {
    const source = historicalById.get(sourceId);
    const compatibleV3Reruns = source
      ? deterministicCandidateRuns.filter(
          (run) =>
            !run.regressionId &&
            source.protocolVersion === 3 &&
            run.protocolVersion === 3 &&
            source.evaluator === 'deterministic' &&
            run.evaluator === 'deterministic' &&
            Boolean(source.scenarioId) &&
            run.scenarioId === source.scenarioId &&
            run.evaluationContractVersion === source.evaluationContractVersion &&
            run.materializerId === source.materializerId &&
            run.deterministicScorerId === source.deterministicScorerId &&
            (run.evaluationContractHash === source.evaluationContractHash ||
              run.revisionHash !== source.revisionHash) &&
            run.role === source.role &&
            (run.medium ?? '') === (source.medium ?? '') &&
            inferredCategory(run, skill) !== 'regression' &&
            run.recordedAt > source.recordedAt,
        )
      : [];
    // Protocol-v3 qualification retries already re-run the same sealed task under
    // the current revision. Package revisions intentionally change the contract hash,
    // so the stable scenario plus materializer/scorer identities define semantic
    // compatibility across revisions. Provider and model identify the execution that
    // produced a historical observation, but they do not make that observation a
    // permanent gate once the current revision has a newer paired execution of the
    // same sealed evaluator generation. Treat those later observations as regression
    // attempts rather than requiring a duplicate invocation of an obsolete subject
    // model. A scorer or materializer generation change remains a different contract
    // and cannot silently close old evidence.
    // A later failure still re-opens the regression because we select the latest
    // compatible attempt below. Older protocols retain explicit regressionId closure
    // semantics.
    const attempts = [
      ...deterministicCandidateRuns.filter((run) => run.regressionId === sourceId),
      ...compatibleV3Reruns,
    ].sort((left, right) =>
      left.recordedAt === right.recordedAt
        ? left.id.localeCompare(right.id)
        : left.recordedAt.localeCompare(right.recordedAt),
    );
    const latest = attempts.at(-1);
    if (!latest || !regressionAttemptPassed(latest, sourceId, deterministicHistoricalRuns)) {
      open += 1;
      openSourceIds.push(sourceId);
    }
  }
  return { total: sourceIds.size, open, openSourceIds };
}

function contractGeneration(id: string | undefined): number {
  const match = id?.match(/@(\d+)$/u);
  return match ? Number(match[1]) : 0;
}

function dominatesContractGeneration(
  left: { contract: number; materializer: number; scorer: number },
  right: { contract: number; materializer: number; scorer: number },
): boolean {
  return (
    left.contract >= right.contract &&
    left.materializer >= right.materializer &&
    left.scorer >= right.scorer &&
    (left.contract > right.contract ||
      left.materializer > right.materializer ||
      left.scorer > right.scorer)
  );
}

/**
 * Protocol-v3 deterministic evidence is only comparable inside one evaluator contract.
 * Keep historical rows in the ledger, but qualification prefers the newest versioned
 * materializer/scorer generation for each scenario. Incomparable generations or more
 * than one contract hash at the newest generation fail closed instead of being averaged.
 */
function selectQualificationContractRuns(
  runs: SkillEvaluationRun[],
  relevantRevisionHashes: ReadonlySet<string> = new Set(),
): {
  runs: SkillEvaluationRun[];
  conflicts: string[];
} {
  const structuredByScenario = new Map<string, SkillEvaluationRun[]>();
  for (const run of runs) {
    if (
      run.protocolVersion !== 3 ||
      run.evaluator !== 'deterministic' ||
      !run.scenarioId ||
      !run.evaluationContractHash ||
      !run.materializerId ||
      !run.deterministicScorerId
    ) {
      continue;
    }
    if ((run.evaluationContractVersion ?? 2) !== CURRENT_SKILL_EVAL_CONTRACT_VERSION) {
      continue;
    }
    structuredByScenario.set(run.scenarioId, [
      ...(structuredByScenario.get(run.scenarioId) ?? []),
      run,
    ]);
  }

  const activeIds = new Set<string>();
  const activeStructuredGenerationByScenario = new Map<
    string,
    { contract: number; materializer: number; scorer: number }
  >();
  const conflicts: string[] = [];
  for (const [scenarioId, scenarioRuns] of structuredByScenario) {
    const generations = new Map<
      string,
      { contract: number; materializer: number; scorer: number; runs: SkillEvaluationRun[] }
    >();
    for (const run of scenarioRuns) {
      const generation = {
        contract: run.evaluationContractVersion ?? 2,
        materializer: contractGeneration(run.materializerId),
        scorer: contractGeneration(run.deterministicScorerId),
      };
      const key = `${generation.contract}:${generation.materializer}:${generation.scorer}`;
      const current = generations.get(key);
      generations.set(key, {
        ...generation,
        runs: [...(current?.runs ?? []), run],
      });
    }
    const generationList = [...generations.values()];
    const maximal = generationList.filter(
      (candidate) => !generationList.some((other) => dominatesContractGeneration(other, candidate)),
    );
    if (maximal.length !== 1) {
      conflicts.push(scenarioId);
      continue;
    }
    const active = maximal[0]!;
    activeStructuredGenerationByScenario.set(scenarioId, {
      contract: active.contract,
      materializer: active.materializer,
      scorer: active.scorer,
    });
    const runsByRevision = new Map<string, SkillEvaluationRun[]>();
    for (const run of active.runs) {
      runsByRevision.set(run.revisionHash, [...(runsByRevision.get(run.revisionHash) ?? []), run]);
    }
    for (const [revisionHash, revisionRuns] of runsByRevision) {
      const hashes = new Set(revisionRuns.map((run) => run.evaluationContractHash));
      if (hashes.size !== 1) {
        if (!relevantRevisionHashes.size || relevantRevisionHashes.has(revisionHash)) {
          conflicts.push(scenarioId);
        }
        continue;
      }
      for (const run of revisionRuns) activeIds.add(run.id);
    }
  }

  // Blind semantic judging is independently versioned from the deterministic
  // materializer/scorer contract. When a blind harness is corrected or
  // strengthened, only the newest generation for that scenario is eligible
  // for qualification. Historical reviews remain in the ledger for audit.
  const blindByScenario = new Map<string, SkillEvaluationRun[]>();
  for (const run of runs) {
    if (run.evaluator !== 'blind-review' || !run.scenarioId) continue;
    blindByScenario.set(run.scenarioId, [...(blindByScenario.get(run.scenarioId) ?? []), run]);
  }
  const activeBlindIds = new Set<string>();
  for (const [scenarioId, scenarioRuns] of blindByScenario) {
    const newestGeneration = Math.max(
      ...scenarioRuns.map((run) => contractGeneration(run.harnessVersion)),
    );
    for (const run of scenarioRuns) {
      if (contractGeneration(run.harnessVersion) !== newestGeneration) continue;
      const activeStructuredGeneration = activeStructuredGenerationByScenario.get(scenarioId);
      const hasStructuredContractIdentity = Boolean(
        run.materializerId && run.deterministicScorerId && run.evaluationContractHash,
      );
      if (activeStructuredGeneration && hasStructuredContractIdentity) {
        const runGeneration = {
          contract: run.evaluationContractVersion ?? 2,
          materializer: contractGeneration(run.materializerId),
          scorer: contractGeneration(run.deterministicScorerId),
        };
        if (
          runGeneration.contract !== activeStructuredGeneration.contract ||
          runGeneration.materializer !== activeStructuredGeneration.materializer ||
          runGeneration.scorer !== activeStructuredGeneration.scorer
        ) {
          continue;
        }
      }
      activeBlindIds.add(run.id);
    }
  }

  return {
    runs: runs.filter((run) => {
      if (run.evaluator === 'blind-review' && run.scenarioId) {
        return activeBlindIds.has(run.id);
      }
      const hasStructuredContractIdentity =
        run.protocolVersion === 3 &&
        run.evaluator === 'deterministic' &&
        Boolean(run.scenarioId) &&
        Boolean(run.evaluationContractHash) &&
        Boolean(run.materializerId) &&
        Boolean(run.deterministicScorerId);
      if (
        hasStructuredContractIdentity &&
        (run.evaluationContractVersion ?? 2) !== CURRENT_SKILL_EVAL_CONTRACT_VERSION
      ) {
        return false;
      }
      if (run.protocolVersion !== 3 || run.evaluator !== 'deterministic' || !run.scenarioId) {
        return true;
      }
      if (!structuredByScenario.has(run.scenarioId)) return true;
      return activeIds.has(run.id);
    }),
    conflicts: [...new Set(conflicts)].sort(),
  };
}

export function listOpenSkillRegressionSources(
  projectRoot: string,
  skill: string,
  revisionHash: string,
): SkillEvaluationRun[] {
  const allRuns = listSkillEvaluationRuns(projectRoot, skill);
  const qualificationRuns = selectQualificationContractRuns(allRuns, new Set([revisionHash])).runs;
  const candidateRuns = qualificationRuns.filter(
    (run) =>
      run.revisionHash === revisionHash &&
      run.variant !== 'without-skill' &&
      !run.infrastructureFailure,
  );
  const { openSourceIds } = regressionSignals(skill, candidateRuns, qualificationRuns);
  const byId = new Map(qualificationRuns.map((run) => [run.id, run]));
  return openSourceIds.flatMap((id) => {
    const run = byId.get(id);
    return run ? [run] : [];
  });
}

export function evaluateSkillPromotion(
  projectRoot: string,
  skill: string,
  revisionHash: string,
  baselineHash?: string,
): SkillPromotionGate {
  const allRuns = listSkillEvaluationRuns(projectRoot, skill);
  const rawRevisionRuns = allRuns.filter((run) => run.revisionHash === revisionHash);
  const relevantRevisionHashes = new Set([revisionHash, ...(baselineHash ? [baselineHash] : [])]);
  const qualificationContracts = selectQualificationContractRuns(allRuns, relevantRevisionHashes);
  const qualificationRuns = qualificationContracts.runs;
  const revisionRuns = qualificationRuns.filter((run) => run.revisionHash === revisionHash);
  if (!revisionRuns.length) {
    return {
      status: 'unmeasured',
      candidateRuns: 0,
      baselineRuns: 0,
      distinctHarnesses: 0,
      distinctProviders: 0,
      distinctModels: 0,
      humanBlindReviews: 0,
      provenancedBlindReviews: 0,
      passRate: null,
      quality: null,
      verification: null,
      baselineDelta: null,
      pairedBaselineCases: 0,
      pairedBaselineCategories: [],
      pairedBaselineCategoryCounts: Object.fromEntries(
        CASE_CATEGORIES.map((category) => [category, 0]),
      ) as Record<SkillEvaluationCaseCategory, number>,
      skillBaselinePassRateDelta: null,
      skillBaselineQualityDelta: null,
      skillBaselineVerificationDelta: null,
      routingObservations: 0,
      routingPrecision: null,
      routingRecall: null,
      infrastructureFailures: 0,
      regressionCases: 0,
      openRegressions: 0,
      categoryCoverage: Object.fromEntries(
        CASE_CATEGORIES.map((category) => [category, 0]),
      ) as Record<SkillEvaluationCaseCategory, number>,
      reasons: [
        rawRevisionRuns.length
          ? 'Recorded runs exist only under superseded or conflicting evaluation contracts; rerun the current evaluator contract.'
          : 'No observed evaluation runs have been recorded.',
      ],
    };
  }

  const infrastructureFailures = revisionRuns.filter((run) => run.infrastructureFailure).length;
  const observedRuns = revisionRuns.filter((run) => !run.infrastructureFailure);
  const candidateRuns = observedRuns.filter((run) => run.variant !== 'without-skill');
  const noSkillRuns = observedRuns.filter((run) => run.variant === 'without-skill');
  const deterministicCandidateRuns = candidateRuns.filter(
    (run) => run.evaluator === 'deterministic',
  );
  const modernProtocol = revisionRuns.some(usesModernEvidenceProtocol);
  const v5Package = V5_PACKAGES_BY_NAME.get(skill);
  const isV5Package = Boolean(v5Package);
  const passRate = deterministicCandidateRuns.length
    ? deterministicCandidateRuns.filter((run) => run.passed).length /
      deterministicCandidateRuns.length
    : null;
  const quality = deterministicCandidateRuns.length
    ? mean(deterministicCandidateRuns.map((run) => run.quality))
    : null;
  const verification = deterministicCandidateRuns.length
    ? mean(deterministicCandidateRuns.map((run) => run.verification))
    : null;
  const humanBlindReviews = candidateRuns.filter(
    (run) => run.evaluator === 'human-blind-review',
  ).length;
  const skillSteward = isV5Package ? getSkillSteward(projectRoot, skill) : undefined;
  const provenancedBlindReviewRuns = candidateRuns.filter((run) => {
    if (
      !isBlindReview(run) ||
      !run.evaluatorProvenance?.blindTo.includes('skill-variant') ||
      !run.evaluatorProvenance.evidence.length
    ) {
      return false;
    }
    if (!isV5Package) return true;
    const provenance = run.evaluatorProvenance;
    return Boolean(
      skillSteward &&
      provenance.agentId &&
      provenance.agentId !== skillSteward.agentId &&
      provenance.displayLabel === buildSkillStewardDisplayLabel(skill) &&
      provenance.provider &&
      provenance.model &&
      isChatGptWebSkillStewardIdentity(provenance.provider, provenance.model),
    );
  });
  const provenancedBlindReviews = provenancedBlindReviewRuns.length;
  const failedProvenancedBlindReviews = provenancedBlindReviewRuns.filter(
    (run) => !run.passed,
  ).length;
  const distinctHarnesses = new Set(
    candidateRuns.map((run) => `${run.provider}:${run.model}:${run.harnessVersion}`),
  ).size;
  const distinctProviders = new Set(candidateRuns.map((run) => run.provider)).size;
  const distinctModels = new Set(candidateRuns.map((run) => `${run.provider}:${run.model}`)).size;
  const baseline = baselineHash
    ? qualificationRuns.filter(
        (run) =>
          run.revisionHash === baselineHash &&
          run.variant !== 'without-skill' &&
          run.evaluator === 'deterministic',
      )
    : [];
  const baselineScore = baseline.length ? mean(baseline.map(legacyComposite)) : null;
  const candidateScore = deterministicCandidateRuns.length
    ? mean(deterministicCandidateRuns.map(legacyComposite))
    : null;
  const baselineDelta =
    baselineScore === null || candidateScore === null ? null : candidateScore - baselineScore;
  const withWithout = compareWithSkillToWithoutSkill(skill, candidateRuns, noSkillRuns);
  const routing = routingSignals(deterministicCandidateRuns);
  const regressions = regressionSignals(skill, candidateRuns, qualificationRuns);
  const categoryCoverage = Object.fromEntries(
    CASE_CATEGORIES.map((category) => [
      category,
      new Set(
        deterministicCandidateRuns
          .filter((run) => inferredCategory(run, skill) === category)
          .map((run) => run.scenarioId ?? run.caseId),
      ).size,
    ]),
  ) as Record<SkillEvaluationCaseCategory, number>;

  const reasons: string[] = [];
  if (qualificationContracts.conflicts.length) {
    reasons.push(
      `Evaluation contract conflict for scenario(s): ${qualificationContracts.conflicts.join(', ')}. Increment the materializer/scorer version for semantic changes before qualification.`,
    );
  }
  if (v5Package?.evaluation.tasks.some((task) => task.maturity !== 'individual')) {
    reasons.push(
      'V5 promotion requires individually authored concrete full-task scenarios; migration scaffolds cannot qualify a skill.',
    );
  }
  if (observedRuns.some((run) => run.integrityFailure)) {
    reasons.push('At least one run recorded an integrity failure.');
  }
  if (!observedRuns.length && infrastructureFailures) {
    reasons.push(
      'Only infrastructure-failed runs are recorded; no skill outcome has been observed.',
    );
  }
  if (deterministicCandidateRuns.length < 3)
    reasons.push('At least three observed candidate runs are required.');
  if (modernProtocol) {
    if (!provenancedBlindReviews) {
      reasons.push('At least one blind review with persisted evaluator provenance is required.');
    } else if (failedProvenancedBlindReviews) {
      reasons.push(
        `${failedProvenancedBlindReviews} active provenanced blind review(s) failed semantic evaluation.`,
      );
    }
  } else if (!humanBlindReviews) {
    reasons.push('At least one blinded human review is required.');
  }
  if (passRate === null || passRate < 0.8) reasons.push('Observed pass rate is below 80%.');
  if (verification === null || verification < 0.8) {
    reasons.push('Observed verification score is below 80%.');
  }
  if (baselineDelta !== null && baselineDelta < 0) {
    reasons.push('Candidate regressed against its recorded revision baseline.');
  }

  if (modernProtocol) {
    const missingCategories = REQUIRED_BENCHMARK_CATEGORIES.filter(
      (category) => categoryCoverage[category] === 0,
    );
    if (missingCategories.length) {
      reasons.push(`Benchmark coverage is missing: ${missingCategories.join(', ')}.`);
    }
    if (routing.precision === null || routing.recall === null) {
      reasons.push(
        'Routing precision and recall require observed positive and negative decisions.',
      );
    } else {
      const routingThreshold = isV5Package ? 0.95 : 0.8;
      const routingPercent = Math.round(routingThreshold * 100);
      if (routing.precision < routingThreshold) {
        reasons.push(`Observed routing precision is below ${routingPercent}%.`);
      }
      if (routing.recall < routingThreshold) {
        reasons.push(`Observed routing recall is below ${routingPercent}%.`);
      }
    }
    if (isV5Package && categoryCoverage['full-task'] < 2) {
      reasons.push('V5 promotion requires at least two observed full-task candidate evaluations.');
    }
    const missingBaselineCategories = REQUIRED_BENCHMARK_CATEGORIES.filter(
      (category) => !withWithout.pairedCategories.includes(category),
    );
    if (missingBaselineCategories.length) {
      reasons.push(
        `Skill-vs-no-skill baselines are missing for: ${missingBaselineCategories.join(', ')}.`,
      );
    } else {
      if (isV5Package && withWithout.pairedCategoryCounts['full-task'] < 2) {
        reasons.push('V5 promotion requires two paired full-task skill-vs-no-skill baselines.');
      }
      const deltas = [
        withWithout.passRateDelta,
        withWithout.qualityDelta,
        withWithout.verificationDelta,
      ];
      if (deltas.some((delta) => delta !== null && delta < 0)) {
        reasons.push('Candidate regressed against the matched no-skill baseline.');
      } else if (deltas.every((delta) => delta === null || delta === 0)) {
        reasons.push('Candidate did not measurably improve on the matched no-skill baseline.');
      }
    }
    if (regressions.open) {
      reasons.push(`${regressions.open} recorded regression case(s) remain open.`);
    }
  }

  const blocked =
    qualificationContracts.conflicts.length > 0 ||
    observedRuns.some((run) => run.integrityFailure) ||
    failedProvenancedBlindReviews > 0 ||
    (baselineDelta !== null && baselineDelta < 0) ||
    (modernProtocol &&
      ((withWithout.passRateDelta !== null && withWithout.passRateDelta < 0) ||
        (withWithout.qualityDelta !== null && withWithout.qualityDelta < 0) ||
        (withWithout.verificationDelta !== null && withWithout.verificationDelta < 0) ||
        regressions.open > 0));
  const ready = !reasons.length;
  return {
    status: ready ? 'ready' : blocked ? 'blocked' : 'insufficient-evidence',
    candidateRuns: candidateRuns.length,
    baselineRuns: noSkillRuns.length,
    distinctHarnesses,
    distinctProviders,
    distinctModels,
    humanBlindReviews,
    provenancedBlindReviews,
    passRate,
    quality,
    verification,
    baselineDelta,
    pairedBaselineCases: withWithout.pairedCases,
    pairedBaselineCategories: withWithout.pairedCategories,
    pairedBaselineCategoryCounts: withWithout.pairedCategoryCounts,
    skillBaselinePassRateDelta: withWithout.passRateDelta,
    skillBaselineQualityDelta: withWithout.qualityDelta,
    skillBaselineVerificationDelta: withWithout.verificationDelta,
    routingObservations: routing.observations,
    routingPrecision: routing.precision,
    routingRecall: routing.recall,
    infrastructureFailures,
    regressionCases: regressions.total,
    openRegressions: regressions.open,
    categoryCoverage,
    reasons,
  };
}

export function buildSkillEvaluationCard(
  projectRoot: string,
  skill: SkillRevision,
  baselineHash?: string,
): SkillEvaluationCard {
  const allRuns = listSkillEvaluationRuns(projectRoot, skill.name);
  const runs = allRuns.filter((run) => run.revisionHash === skill.hash);
  const suite = buildSkillBenchmarkSuite(skill, allRuns);
  const cases = CASE_CATEGORIES.flatMap((category) => suite.categories[category]);
  return {
    skill: skill.name,
    revisionHash: skill.hash,
    cases,
    suite,
    routingConfusions: buildPairwiseRoutingConfusionMatrix(cases, runs),
    gate: evaluateSkillPromotion(projectRoot, skill.name, skill.hash, baselineHash),
    runs,
  };
}
