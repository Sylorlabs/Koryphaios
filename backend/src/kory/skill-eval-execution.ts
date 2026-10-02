import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createPairedSkillExperimentsV3,
  validatePairedSkillExperimentsV3,
  type SkillEvalBudget,
  type SkillEvalExperimentV3,
  type SkillEvalScenarioV3,
  type SkillEvalSubject,
} from './skill-eval-harness';
import {
  recordSkillEvaluationRun,
  type SkillInfrastructureFailure,
  type SkillRuntimeArtifact,
} from './skill-evaluations';
import type { V5CompiledSkillPackage } from './skill-packages';

export interface SkillEvalFixtureMaterializer {
  id: string;
  /** A runnable component exercise is not necessarily a complete full-task environment. */
  readinessBlockers?: readonly string[];
  /**
   * The fixture drives a real external runtime (bounded child processes, real browser sessions)
   * rather than an in-process simulation. Such fixtures own dedicated red/green end-to-end tests,
   * and the generic "every ready fixture starts red" sweep skips them so that a single-process
   * sweep does not accumulate process/browser spawn churn.
   */
  realRuntime?: boolean;
  matches: (scenario: SkillEvalScenarioV3) => boolean;
  materialize: (destination: string, scenario: SkillEvalScenarioV3) => void | Promise<void>;
}

export interface SkillEvalExecutionObservation {
  output: string;
  evidence: string[];
  artifacts: SkillRuntimeArtifact[];
  durationMs: number;
  infrastructureFailure?: SkillInfrastructureFailure;
  /** The model failed its execution contract, without a proven host failure. */
  taskFailure?: string;
}

export interface SkillEvalExecutor {
  id: string;
  subject: SkillEvalSubject;
  provider: string;
  model: string;
  runtimeIdentity: string;
  tools: string[];
  budget: SkillEvalBudget;
  execute: (input: {
    experiment: SkillEvalExperimentV3;
    scenario: SkillEvalScenarioV3;
    workingDirectory: string;
    taskPrompt: string;
    /** Portable target skill text. Null means the no-skill baseline. */
    skillContext: string | null;
  }) => Promise<SkillEvalExecutionObservation>;
}

export interface SkillEvalDeterministicScore {
  passed: boolean;
  quality: number;
  verification: number;
  integrityFailure: boolean;
  evidence: string[];
}

export interface SkillEvalDeterministicScorer {
  id: string;
  scenarioIds: string[];
  score: (input: {
    scenario: SkillEvalScenarioV3;
    experiment: SkillEvalExperimentV3;
    workingDirectory: string;
    observation: SkillEvalExecutionObservation;
  }) => SkillEvalDeterministicScore | Promise<SkillEvalDeterministicScore>;
}

export interface SkillEvalExecutionReadiness {
  skill: string;
  scenarioId: string;
  startingState: string;
  materializerId: string | null;
  deterministicScorerId: string | null;
  ready: boolean;
  reasons: string[];
}

export interface SkillEvalPairRunResult {
  pairId: string;
  scenarioId: string;
  initialFingerprint: string;
  executionOrder: Array<'with-skill' | 'without-skill'>;
  withSkill: {
    experiment: SkillEvalExperimentV3;
    workspace: string;
    observation: SkillEvalExecutionObservation;
    score: SkillEvalDeterministicScore | null;
  };
  withoutSkill: {
    experiment: SkillEvalExperimentV3;
    workspace: string;
    observation: SkillEvalExecutionObservation;
    score: SkillEvalDeterministicScore | null;
  };
  cleanup: () => void;
}

function boundedUnit(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Skill evaluation score must be in [0, 1], received ${value}`);
  }
  return value;
}

function matchingMaterializer(
  scenario: SkillEvalScenarioV3,
  materializers: readonly SkillEvalFixtureMaterializer[],
): SkillEvalFixtureMaterializer | undefined {
  return materializers.find((materializer) => materializer.matches(scenario));
}

function matchingScorer(
  scenario: SkillEvalScenarioV3,
  scorers: readonly SkillEvalDeterministicScorer[],
): SkillEvalDeterministicScorer | undefined {
  return scorers.find((scorer) => scorer.scenarioIds.includes(scenario.id));
}

export function auditSkillEvalExecutionReadiness(
  skillPackages: readonly V5CompiledSkillPackage[],
  materializers: readonly SkillEvalFixtureMaterializer[],
  scorers: readonly SkillEvalDeterministicScorer[],
): SkillEvalExecutionReadiness[] {
  return skillPackages.flatMap((skillPackage) =>
    skillPackage.evaluation.tasks.map((task) => {
      const scenario: SkillEvalScenarioV3 = {
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
        falsifiableChecks: task.falsifiableChecks,
        scorers: task.scorers,
        requiredEvidence: task.requiredEvidence,
        requiredArtifacts: task.requiredArtifacts,
      };
      const materializer = matchingMaterializer(scenario, materializers);
      const scorer = matchingScorer(scenario, scorers);
      const reasons: string[] = [];
      reasons.push(...(materializer?.readinessBlockers ?? []));
      if (!materializer) reasons.push(`no materializer for ${scenario.environment.startingState}`);
      if (!scorer) reasons.push('no registered deterministic scorer');
      if (!scenario.falsifiableChecks.length) reasons.push('no falsifiable checks');
      if (!scenario.scorers.some((item) => item.kind === 'deterministic')) {
        reasons.push('fixture declares no deterministic scorer');
      }
      return {
        skill: skillPackage.sidecar.name,
        scenarioId: scenario.id,
        startingState: scenario.environment.startingState,
        materializerId: materializer?.id ?? null,
        deterministicScorerId: scorer?.id ?? null,
        ready: reasons.length === 0,
        reasons,
      };
    }),
  );
}

function workspaceEntries(root: string, current = root): string[] {
  if (!existsSync(current)) return [];
  const stat = lstatSync(current);
  if (stat.isSymbolicLink() || stat.isFile()) return [current];
  if (!stat.isDirectory()) return [];
  return readdirSync(current)
    .filter((name) => name !== '.git')
    .sort()
    .flatMap((name) => workspaceEntries(root, join(current, name)));
}

function workspaceHashes(root: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const path of workspaceEntries(root)) {
    const relativePath = relative(root, path).replaceAll('\\', '/');
    const stat = lstatSync(path);
    const hash = createHash('sha256');
    if (stat.isSymbolicLink()) {
      hash.update('symlink\0');
      hash.update(readlinkSync(path));
    } else if (stat.isFile()) {
      hash.update('file\0');
      hash.update(readFileSync(path));
    }
    hashes.set(relativePath, hash.digest('hex'));
  }
  return hashes;
}

export function fingerprintSkillEvalWorkspace(root: string): string {
  const hash = createHash('sha256');
  for (const path of workspaceEntries(root)) {
    const relativePath = relative(root, path).replaceAll('\\', '/');
    const stat = lstatSync(path);
    hash.update(relativePath);
    hash.update('\0');
    if (stat.isSymbolicLink()) {
      hash.update('symlink\0');
      hash.update(readlinkSync(path));
    } else if (stat.isFile()) {
      hash.update('file\0');
      hash.update(readFileSync(path));
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

function safeArtifactSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180);
}

function persistArmEvidence(input: {
  projectRoot: string;
  pairId: string;
  variant: 'with-skill' | 'without-skill';
  scenario: SkillEvalScenarioV3;
  materializerId: string;
  deterministicScorerId: string;
  harnessVersion: string;
  evaluationContractHash?: string;
  evaluationContractVersion?: number;
  baseRoot: string;
  workingDirectory: string;
  observation: SkillEvalExecutionObservation;
  score: SkillEvalDeterministicScore | null;
}): SkillRuntimeArtifact[] {
  const artifactRoot = join(
    input.projectRoot,
    '.koryphaios',
    'skills',
    'eval-artifacts',
    safeArtifactSegment(input.pairId),
    input.variant,
  );
  mkdirSync(artifactRoot, { recursive: true });
  const before = workspaceHashes(input.baseRoot);
  const after = workspaceHashes(input.workingDirectory);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes = paths.flatMap((path) => {
    const left = before.get(path);
    const right = after.get(path);
    if (left === right) return [];
    const change = left === undefined ? 'added' : right === undefined ? 'deleted' : 'modified';
    if (left !== undefined) {
      const source = join(input.baseRoot, path);
      const destination = join(artifactRoot, 'before-files', path);
      mkdirSync(
        destination.slice(0, Math.max(destination.lastIndexOf('/'), destination.lastIndexOf('\\'))),
        {
          recursive: true,
        },
      );
      cpSync(source, destination, { recursive: true, dereference: false });
    }
    if (right !== undefined) {
      const source = join(input.workingDirectory, path);
      const destination = join(artifactRoot, 'files', path);
      mkdirSync(
        destination.slice(0, Math.max(destination.lastIndexOf('/'), destination.lastIndexOf('\\'))),
        {
          recursive: true,
        },
      );
      cpSync(source, destination, { recursive: true, dereference: false });
    }
    return [{ path, change, beforeSha256: left ?? null, afterSha256: right ?? null }];
  });
  const outputPath = join(artifactRoot, 'final-output.txt');
  writeFileSync(outputPath, input.observation.output);
  const manifestPath = join(artifactRoot, 'run-manifest.json');
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        artifactSchemaVersion: 2,
        pairId: input.pairId,
        variant: input.variant,
        scenario: input.scenario,
        materializerId: input.materializerId,
        deterministicScorerId: input.deterministicScorerId,
        harnessVersion: input.harnessVersion,
        evaluationContractHash: input.evaluationContractHash ?? null,
        evaluationContractVersion: input.evaluationContractVersion ?? null,
        initialFingerprint: fingerprintSkillEvalWorkspace(input.baseRoot),
        finalFingerprint: fingerprintSkillEvalWorkspace(input.workingDirectory),
        durationMs: input.observation.durationMs,
        changes,
        score: input.score,
        evidence: input.observation.evidence,
        infrastructureFailure: input.observation.infrastructureFailure ?? null,
      },
      null,
      2,
    )}\n`,
  );
  return [
    {
      kind: 'report',
      location: manifestPath,
      sha256: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),
    },
    {
      kind: 'report',
      location: outputPath,
      sha256: createHash('sha256').update(readFileSync(outputPath)).digest('hex'),
    },
  ];
}

function scenarioFromPackage(
  skillPackage: V5CompiledSkillPackage,
  scenarioId: string,
): SkillEvalScenarioV3 {
  const task = skillPackage.evaluation.tasks.find((item) => item.id === scenarioId);
  if (!task)
    throw new Error(`Full-task scenario ${scenarioId} not found for ${skillPackage.sidecar.name}`);
  return {
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
    falsifiableChecks: task.falsifiableChecks,
    scorers: task.scorers,
    requiredEvidence: task.requiredEvidence,
    requiredArtifacts: task.requiredArtifacts,
  };
}

function infrastructureObservation(
  kind: SkillInfrastructureFailure['kind'],
  detail: string,
  evidence: string[],
): SkillEvalExecutionObservation {
  return {
    output: '',
    evidence,
    artifacts: [],
    durationMs: 0,
    infrastructureFailure: { kind, retryable: false, evidence, detail },
  };
}

export async function runPairedSkillEvaluationV3(input: {
  projectRoot: string;
  skillPackage: V5CompiledSkillPackage;
  scenarioId: string;
  skillRevisionHash: string;
  harnessVersion: string;
  evaluationContractHash?: string;
  evaluationContractVersion?: number;
  executor: SkillEvalExecutor;
  materializers: readonly SkillEvalFixtureMaterializer[];
  scorers: readonly SkillEvalDeterministicScorer[];
  pairId?: string;
  persist?: boolean;
  executionOrder?: 'with-skill-first' | 'without-skill-first';
}): Promise<SkillEvalPairRunResult> {
  const scenario = scenarioFromPackage(input.skillPackage, input.scenarioId);
  const materializer = matchingMaterializer(scenario, input.materializers);
  const scorer = matchingScorer(scenario, input.scorers);
  if (!materializer) {
    throw new Error(
      `Cannot execute ${scenario.id}: no materializer for ${scenario.environment.startingState}`,
    );
  }
  if (!scorer) throw new Error(`Cannot execute ${scenario.id}: no registered deterministic scorer`);
  if (materializer.readinessBlockers?.length) {
    throw new Error(`Cannot execute ${scenario.id}: ${materializer.readinessBlockers.join('; ')}`);
  }

  const pairId = input.pairId ?? `${scenario.id}:${randomUUID()}`;
  const suiteId = `${input.skillPackage.sidecar.name}:v${input.skillPackage.sidecar.version}:held-out`;
  const experiments = createPairedSkillExperimentsV3({
    pairId,
    suiteId,
    skill: input.skillPackage.sidecar.name,
    skillRevisionHash: input.skillRevisionHash,
    subject: input.executor.subject,
    provider: input.executor.provider,
    model: input.executor.model,
    harnessVersion: input.harnessVersion,
    role: 'worker',
    runtimeIdentity: input.executor.runtimeIdentity,
    tools: input.executor.tools,
    budget: input.executor.budget,
  });
  const pairValidation = validatePairedSkillExperimentsV3(
    experiments.withSkill,
    experiments.withoutSkill,
  );
  if (!pairValidation.valid) {
    throw new Error(`Invalid skill evaluation pair: ${pairValidation.reasons.join('; ')}`);
  }

  const pairRoot = mkdtempSync(join(tmpdir(), 'kory-skill-eval-pair-'));
  const baseRoot = join(pairRoot, 'base');
  const withSkillRoot = join(pairRoot, 'with-skill');
  const withoutSkillRoot = join(pairRoot, 'without-skill');
  mkdirSync(baseRoot, { recursive: true });
  let cleanupCalled = false;
  const cleanup = () => {
    if (cleanupCalled) return;
    cleanupCalled = true;
    rmSync(pairRoot, { recursive: true, force: true });
  };

  try {
    await materializer.materialize(baseRoot, scenario);
    const initialFingerprint = fingerprintSkillEvalWorkspace(baseRoot);
    cpSync(baseRoot, withSkillRoot, { recursive: true });
    cpSync(baseRoot, withoutSkillRoot, { recursive: true });
    if (
      fingerprintSkillEvalWorkspace(withSkillRoot) !== initialFingerprint ||
      fingerprintSkillEvalWorkspace(withoutSkillRoot) !== initialFingerprint
    ) {
      throw new Error('Paired evaluation workspaces diverged before execution');
    }

    const runOne = async (
      experiment: SkillEvalExperimentV3,
      workingDirectory: string,
      skillContext: string | null,
    ) => {
      let observation: SkillEvalExecutionObservation;
      try {
        observation = await input.executor.execute({
          experiment,
          scenario,
          workingDirectory,
          taskPrompt: scenario.prompt,
          skillContext,
        });
      } catch (error: unknown) {
        observation = infrastructureObservation(
          'provider',
          error instanceof Error ? error.message : String(error),
          ['executor threw before producing a complete observation'],
        );
      }
      const score: SkillEvalDeterministicScore | null = observation.infrastructureFailure
        ? null
        : observation.taskFailure
          ? {
              passed: false,
              quality: 0,
              verification: 0,
              integrityFailure: false,
              evidence: [observation.taskFailure],
            }
          : await scorer.score({ scenario, experiment, workingDirectory, observation });
      if (score) {
        boundedUnit(score.quality);
        boundedUnit(score.verification);
      }
      if (input.persist) {
        const durableArtifacts = persistArmEvidence({
          projectRoot: input.projectRoot,
          pairId,
          variant: experiment.variant,
          scenario,
          materializerId: materializer.id,
          deterministicScorerId: scorer.id,
          harnessVersion: experiment.harnessVersion,
          evaluationContractHash: input.evaluationContractHash,
          evaluationContractVersion: input.evaluationContractVersion,
          baseRoot,
          workingDirectory,
          observation,
          score,
        });
        recordSkillEvaluationRun(input.projectRoot, {
          id: experiment.id,
          skill: input.skillPackage.sidecar.name,
          revisionHash: input.skillRevisionHash,
          caseId: scenario.id,
          provider: experiment.provider,
          model: experiment.model,
          harnessVersion: experiment.harnessVersion,
          role: experiment.role,
          evaluator: 'deterministic',
          passed: score?.passed ?? false,
          quality: score?.quality ?? 0,
          verification: score?.verification ?? 0,
          integrityFailure: score?.integrityFailure ?? false,
          evidence: [...observation.evidence, ...(score?.evidence ?? [])],
          recordedAt: new Date().toISOString(),
          protocolVersion: 3,
          variant: experiment.variant,
          caseCategory: 'full-task',
          comparisonId: pairId,
          routing: {
            expectedSelection: true,
            selected: experiment.variant === 'with-skill',
            selectedSkills:
              experiment.variant === 'with-skill' ? [input.skillPackage.sidecar.name] : [],
            expectedSkills: [],
            forbiddenSkills: [],
          },
          suiteId,
          scenarioId: scenario.id,
          experimentId: experiment.id,
          evaluationContractHash: input.evaluationContractHash,
          evaluationContractVersion: input.evaluationContractVersion,
          materializerId: materializer.id,
          deterministicScorerId: scorer.id,
          infrastructureFailure: observation.infrastructureFailure,
          artifacts: [...observation.artifacts, ...durableArtifacts],
        });
      }
      return { experiment, workspace: workingDirectory, observation, score };
    };

    const runWithSkill = () =>
      runOne(experiments.withSkill, withSkillRoot, input.skillPackage.sourceContent);
    const runWithoutSkill = () => runOne(experiments.withoutSkill, withoutSkillRoot, null);
    const executionOrder: Array<'with-skill' | 'without-skill'> =
      input.executionOrder === 'without-skill-first'
        ? ['without-skill', 'with-skill']
        : ['with-skill', 'without-skill'];
    let withSkill: Awaited<ReturnType<typeof runWithSkill>>;
    let withoutSkill: Awaited<ReturnType<typeof runWithoutSkill>>;
    if (executionOrder[0] === 'with-skill') {
      withSkill = await runWithSkill();
      withoutSkill = await runWithoutSkill();
    } else {
      withoutSkill = await runWithoutSkill();
      withSkill = await runWithSkill();
    }
    return {
      pairId,
      scenarioId: scenario.id,
      initialFingerprint,
      executionOrder,
      withSkill,
      withoutSkill,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
