import { resolve } from 'node:path';
import {
  QualificationDispatch,
  qualificationInfrastructureStatus,
} from './skill-v5-qualification-dispatch';
import {
  applySkillEvalExecutorReadiness,
  resolveSkillEvalExecutor,
  parseSkillEvalExecutorMode,
  skillEvalCampaignHarnessVersion,
  type SkillEvalExecutorDescriptor,
} from './skill-v5-qualification-executor';
import {
  auditSkillEvalExecutionReadiness,
  runPairedSkillEvaluationV3,
} from '../backend/src/kory/skill-eval-execution';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../backend/src/kory/skill-eval-fixtures';
import {
  CURRENT_SKILL_EVAL_CONTRACT_VERSION,
  listOpenSkillRegressionSources,
  listSkillEvaluationRuns,
} from '../backend/src/kory/skill-evaluations';
import { hasCompleteCurrentSkillPair } from '../backend/src/kory/skill-eval-campaign-resume';
import { skillEvaluationV5ContractHash } from '../backend/src/kory/skill-eval-contract-hash';
import {
  loadV5SkillPackages,
  type V5CompiledSkillPackage,
  type V5FullTaskFixture,
} from '../backend/src/kory/skill-packages';
import { listSkills, type SkillRevision } from '../backend/src/kory/skills';
import type { SkillEvalScenarioV3 } from '../backend/src/kory/skill-eval-harness';

const projectRoot = resolve(import.meta.dir, '..');
const evaluationContractVersion = CURRENT_SKILL_EVAL_CONTRACT_VERSION;
const packages = loadV5SkillPackages(resolve(projectRoot, 'skills-v5')).packages;
const revisions = new Map(
  listSkills(projectRoot)
    .filter((skill) => skill.state === 'active' && skill.validation.valid)
    .map((skill) => [skill.name, skill]),
);

const requestedSkills = new Set(
  process.argv
    .filter((argument) => argument.startsWith('--skill='))
    .map((argument) => argument.slice('--skill='.length).trim())
    .filter(Boolean),
);
const requestedScenarios = new Set(
  process.argv
    .filter((argument) => argument.startsWith('--scenario='))
    .map((argument) => argument.slice('--scenario='.length).trim())
    .filter(Boolean),
);
const force = process.argv.includes('--force');
const openRegressionsOnly = process.argv.includes('--open-regressions');
const dryRun = process.argv.includes('--dry-run');
const requestedExecutorMode = parseSkillEvalExecutorMode(process.argv);
const wallClockMs = Number(
  process.argv
    .find((argument) => argument.startsWith('--wall-clock-ms='))
    ?.slice('--wall-clock-ms='.length) ||
    process.env.KORY_SKILL_EVAL_WALL_CLOCK_MS?.trim() ||
    '180000',
);
const reasoningEffort =
  process.argv
    .find((argument) => argument.startsWith('--reasoning-effort='))
    ?.slice('--reasoning-effort='.length)
    .trim() ||
  process.env.KORY_SKILL_EVAL_REASONING_EFFORT?.trim() ||
  'none';
const requestedModel =
  process.argv
    .find((argument) => argument.startsWith('--model='))
    ?.slice('--model='.length)
    .trim() || undefined;
const executorSelection = resolveSkillEvalExecutor({
  mode: requestedExecutorMode,
  model: requestedModel,
  reasoningEffort,
  wallClockMs,
  dryRun,
});
const executorDescriptor = executorSelection.descriptor;
const executionMode = !executorDescriptor
  ? 'unverified'
  : executorDescriptor.mode.endsWith('text-patch')
    ? 'text-only-patch'
    : process.env.KORY_SKILL_EVAL_SINGLE_NATIVE_CALL === '1'
      ? 'single-native-call'
      : 'multi-turn';
const configuredConcurrency = Number(
  process.argv
    .find((argument) => argument.startsWith('--concurrency='))
    ?.slice('--concurrency='.length) ||
    process.env.KORY_SKILL_EVAL_CONCURRENCY?.trim() ||
    (executorDescriptor?.mode.endsWith('text-patch') ? '1' : '4'),
);
if (
  !Number.isInteger(configuredConcurrency) ||
  configuredConcurrency < 1 ||
  configuredConcurrency > 8
) {
  throw new Error(
    `Invalid qualification concurrency ${String(configuredConcurrency)}; expected 1-8`,
  );
}
if (!Number.isFinite(wallClockMs) || wallClockMs < 10_000) {
  throw new Error(`Invalid qualification wall-clock budget ${String(wallClockMs)}`);
}

const selectedPackages = requestedSkills.size
  ? [...requestedSkills].map((name) => {
      const skillPackage = packages.find((item) => item.sidecar.name === name);
      if (!skillPackage) throw new Error(`Unknown V5 skill package ${name}`);
      return skillPackage;
    })
  : packages;

const fixtureReadiness = auditSkillEvalExecutionReadiness(
  selectedPackages,
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
);
const readiness = applySkillEvalExecutorReadiness(
  fixtureReadiness,
  selectedPackages.flatMap((skillPackage) =>
    skillPackage.evaluation.tasks.map((task) => ({
      skill: skillPackage.sidecar.name,
      id: task.id,
      environmentKind: task.environment.kind,
    })),
  ),
  executorSelection,
);
const readinessByScenario = new Map(readiness.map((row) => [row.scenarioId, row]));
function contractHash(skillPackage: V5CompiledSkillPackage, task: V5FullTaskFixture): string {
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
  const materializerIds = BUILTIN_SKILL_EVAL_MATERIALIZERS.filter((item) => item.matches(scenario))
    .map((item) => item.id)
    .sort();
  const scorerIds = BUILTIN_SKILL_EVAL_SCORERS.filter((item) => item.scenarioIds.includes(task.id))
    .map((item) => item.id)
    .sort();
  return skillEvaluationV5ContractHash({
    contractVersion: evaluationContractVersion,
    skill: skillPackage.sidecar.name,
    packageVersion: skillPackage.sidecar.version,
    scenario: task,
    materializerIds,
    scorerIds,
  });
}

function campaignHarnessVersion(
  evaluationContractHash: string,
  descriptor: SkillEvalExecutorDescriptor,
): string {
  return skillEvalCampaignHarnessVersion({
    descriptor,
    executionMode,
    reasoningEffort,
    wallClockMs,
    evaluationContractHash,
  });
}

interface CampaignItem {
  skillPackage: V5CompiledSkillPackage;
  revision: SkillRevision;
  task: V5FullTaskFixture;
  evaluationContractHash: string;
  regressionId?: string;
}

const queued: CampaignItem[] = [];
const skippedComplete: Array<{ skill: string; scenarioId: string }> = [];
const blocked = readiness
  .filter((row) => !row.ready)
  .map((row) => ({ skill: row.skill, scenarioId: row.scenarioId, reasons: [...row.reasons] }));

for (const skillPackage of selectedPackages) {
  const revision = revisions.get(skillPackage.sidecar.name);
  if (!revision)
    throw new Error(`${skillPackage.sidecar.name} has no active valid runtime revision`);
  if (!revision.sourceContent.includes(skillPackage.instructions.trim())) {
    throw new Error(
      `${skillPackage.sidecar.name} runtime revision does not contain the current V5 package instructions`,
    );
  }
  const runs = listSkillEvaluationRuns(projectRoot, skillPackage.sidecar.name);
  const openRegressionSources = openRegressionsOnly
    ? listOpenSkillRegressionSources(projectRoot, skillPackage.sidecar.name, revision.hash)
    : null;
  for (const task of skillPackage.evaluation.tasks) {
    if (requestedScenarios.size && !requestedScenarios.has(task.id)) continue;
    const sources = openRegressionSources?.filter((run) => (run.scenarioId ?? run.caseId) === task.id);
    if (sources && !sources.length) continue;
    if (!readinessByScenario.get(task.id)?.ready) continue;
    const evaluationContractHash = contractHash(skillPackage, task);
    if (
      !force &&
      !openRegressionsOnly &&
      executorDescriptor &&
      hasCompleteCurrentSkillPair(runs, {
        skill: skillPackage.sidecar.name,
        revisionHash: revision.hash,
        scenarioId: task.id,
        evaluationContractHash,
        evaluationContractVersion,
        harnessVersion: campaignHarnessVersion(evaluationContractHash, executorDescriptor),
        provider: executorDescriptor.provider,
        model: executorDescriptor.model,
      })
    ) {
      skippedComplete.push({ skill: skillPackage.sidecar.name, scenarioId: task.id });
      continue;
    }
    for (const source of sources ?? [undefined]) {
      queued.push({ skillPackage, revision, task, evaluationContractHash, regressionId: source?.id });
    }
  }
}

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        dryRun: true,
        executor: executorDescriptor
          ? {
              status: 'available',
              requestedMode: requestedExecutorMode,
              ...executorDescriptor,
              executionMode,
            }
          : {
              status: 'unavailable',
              verification: 'unverified',
              requestedMode: requestedExecutorMode,
              descriptor: null,
              reason:
                executorSelection.status === 'unavailable' ? executorSelection.reason : undefined,
            },
        mode: openRegressionsOnly ? 'open-regressions' : 'qualification',
        selectedSkills: selectedPackages.length,
        readyScenarios: readiness.filter((row) => row.ready).length,
        environmentBlockedScenarios: blocked.length,
        blockedScenarios: blocked,
        skippedComplete: skippedComplete.length,
        queued: queued.length,
        queuedBySkill: Object.fromEntries(
          [...new Set(queued.map((item) => item.skillPackage.sidecar.name))]
            .sort()
            .map((skill) => [
              skill,
              queued
                .filter((item) => item.skillPackage.sidecar.name === skill)
                .map((item) => item.task.id),
            ]),
        ),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (executorSelection.status !== 'available' || !executorDescriptor) {
  throw new Error('Cannot dispatch qualification with an unavailable/unverified executor.');
}
const executor = executorSelection.executor;
const dispatchExecutorDescriptor = executorSelection.descriptor;
const completed: Array<{
  skill: string;
  scenarioId: string;
  pairId: string;
  withSkillPassed: boolean | null;
  withoutSkillPassed: boolean | null;
}> = [];
const failed: Array<{ skill: string; scenarioId: string; detail: string }> = [];
const dispatch = new QualificationDispatch(queued.length);

async function runWorker(): Promise<void> {
  while (true) {
    const index = dispatch.take();
    if (index === undefined) return;
    const item = queued[index];
    if (!item) return;
    const { skillPackage, revision, task, evaluationContractHash, regressionId } = item;
    const existingRuns = listSkillEvaluationRuns(projectRoot, skillPackage.sidecar.name);
    const priorPairCount = existingRuns.filter(
      (run) =>
        run.revisionHash === revision.hash &&
        run.scenarioId === task.id &&
        run.evaluationContractHash === evaluationContractHash &&
        run.variant === 'with-skill' &&
        Boolean(run.comparisonId),
    ).length;
    try {
      const result = await runPairedSkillEvaluationV3({
        projectRoot,
        skillPackage,
        scenarioId: task.id,
        skillRevisionHash: revision.hash,
        harnessVersion: campaignHarnessVersion(
          evaluationContractHash,
          dispatchExecutorDescriptor,
        ),
        evaluationContractHash,
        evaluationContractVersion,
        regressionId,
        executor,
        materializers: BUILTIN_SKILL_EVAL_MATERIALIZERS,
        scorers: BUILTIN_SKILL_EVAL_SCORERS,
        persist: true,
        executionOrder: priorPairCount % 2 === 0 ? 'without-skill-first' : 'with-skill-first',
      });
      try {
        dispatch.observe([
          result.withSkill.observation.infrastructureFailure,
          result.withoutSkill.observation.infrastructureFailure,
        ]);
        const infrastructure = qualificationInfrastructureStatus(
          result.withSkill.observation.infrastructureFailure,
          result.withoutSkill.observation.infrastructureFailure,
        );
        const withIntegrityFailure = Boolean(result.withSkill.score?.integrityFailure);
        const withoutIntegrityFailure = Boolean(result.withoutSkill.score?.integrityFailure);
        const integrityEvidence = (evidence: readonly string[] | undefined): string =>
          (evidence ?? [])
            .filter((entry) =>
              /integrity|protected|modified|mutation|unexpected|scope/iu.test(entry),
            )
            .slice(0, 3)
            .join(' | ')
            .slice(0, 700) || 'scorer reported an integrity failure';
        if (
          infrastructure.infrastructureFailure ||
          withIntegrityFailure ||
          withoutIntegrityFailure
        ) {
          failed.push({
            skill: skillPackage.sidecar.name,
            scenarioId: task.id,
            ...(regressionId ? { regressionId } : {}),
            detail: [
              infrastructure.detail,
              withIntegrityFailure
                ? `with-skill evaluator integrity failure: ${integrityEvidence(result.withSkill.score?.evidence)}`
                : null,
              withoutIntegrityFailure
                ? `without-skill evaluator integrity failure: ${integrityEvidence(result.withoutSkill.score?.evidence)}`
                : null,
            ]
              .filter(Boolean)
              .join(' | '),
          });
        } else {
          completed.push({
            skill: skillPackage.sidecar.name,
            scenarioId: task.id,
            pairId: result.pairId,
            withSkillPassed: result.withSkill.score?.passed ?? null,
            withoutSkillPassed: result.withoutSkill.score?.passed ?? null,
          });
        }
        console.log(
          JSON.stringify({
            type: 'progress',
            complete: completed.length,
            failed: failed.length,
            totalQueued: queued.length,
            skill: skillPackage.sidecar.name,
            scenarioId: task.id,
            pairId: result.pairId,
            withSkill: result.withSkill.score?.passed ?? null,
            withoutSkill: result.withoutSkill.score?.passed ?? null,
            withSkillInfrastructureFailure: infrastructure.withSkillInfrastructureFailure,
            withoutSkillInfrastructureFailure: infrastructure.withoutSkillInfrastructureFailure,
            infrastructureFailure: infrastructure.infrastructureFailure,
            integrityFailure: withIntegrityFailure || withoutIntegrityFailure,
            ...(withIntegrityFailure
              ? { withSkillIntegrityEvidence: integrityEvidence(result.withSkill.score?.evidence) }
              : {}),
            ...(withoutIntegrityFailure
              ? {
                  withoutSkillIntegrityEvidence: integrityEvidence(
                    result.withoutSkill.score?.evidence,
                  ),
                }
              : {}),
          }),
        );
      } finally {
        result.cleanup();
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      failed.push({ skill: skillPackage.sidecar.name, scenarioId: task.id, detail });
      console.log(
        JSON.stringify({
          type: 'progress',
          complete: completed.length,
          failed: failed.length,
          totalQueued: queued.length,
          skill: skillPackage.sidecar.name,
          scenarioId: task.id,
          error: detail,
        }),
      );
    }
  }
}

await Promise.all(
  Array.from({ length: Math.min(configuredConcurrency, Math.max(queued.length, 1)) }, () =>
    runWorker(),
  ),
);

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      executor: {
        mode: executorDescriptor.mode,
        id: executor.id,
        subject: executor.subject,
        provider: executor.provider,
        model: executor.model,
        runtimeIdentity: executor.runtimeIdentity,
        executionMode,
        reasoningEffort,
        concurrency: configuredConcurrency,
        wallClockMs,
      },
      selectedSkills: selectedPackages.length,
      readyScenarios: readiness.filter((row) => row.ready).length,
      environmentBlockedScenarios: blocked.length,
      skippedComplete: skippedComplete.length,
      queued: queued.length,
      completed: completed.length,
      failed: failed.length,
      failedScenarios: failed,
      stoppedReason: dispatch.stopReason,
      notStarted: dispatch.notStarted,
    },
    null,
    2,
  ),
);

// The summary must be flushed before the one-shot process exits. Provider
// adapters are responsible for closing their own resources; forcing exit here
// can truncate piped JSON and hide the final campaign state.
process.exitCode = failed.length ? 1 : 0;
