import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  createIsolatedCodexSkillEvalExecutor,
  createTextOnlyPatchSkillEvalExecutor,
} from '../backend/src/kory/skill-eval-codex';
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
  type SkillEvaluationRun,
} from '../backend/src/kory/skill-evaluations';
import {
  loadV5SkillPackages,
  type V5CompiledSkillPackage,
  type V5FullTaskFixture,
} from '../backend/src/kory/skill-packages';
import { listSkills, type SkillRevision } from '../backend/src/kory/skills';

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
const textPatchMode =
  process.argv.includes('--text-patch') || process.env.KORY_SKILL_EVAL_TEXT_PATCH === '1';
const configuredConcurrency = Number(
  process.argv
    .find((argument) => argument.startsWith('--concurrency='))
    ?.slice('--concurrency='.length) ||
    process.env.KORY_SKILL_EVAL_CONCURRENCY?.trim() ||
    (textPatchMode ? '1' : '4'),
);
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
const model =
  process.argv
    .find((argument) => argument.startsWith('--model='))
    ?.slice('--model='.length)
    .trim() ||
  process.env.KORY_SKILL_EVAL_MODEL?.trim() ||
  'gpt-5.6-sol';
const executionMode = textPatchMode
  ? 'text-only-patch'
  : process.env.KORY_SKILL_EVAL_SINGLE_NATIVE_CALL === '1'
    ? 'single-native-call'
    : 'multi-turn';
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

const readiness = auditSkillEvalExecutionReadiness(
  selectedPackages,
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
);
const readinessByScenario = new Map(readiness.map((row) => [row.scenarioId, row]));
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function contractHash(skillPackage: V5CompiledSkillPackage, task: V5FullTaskFixture): string {
  const materializerIds = BUILTIN_SKILL_EVAL_MATERIALIZERS.filter((item) => item.matches(task))
    .map((item) => item.id)
    .sort();
  const scorerIds = BUILTIN_SKILL_EVAL_SCORERS.filter((item) => item.scenarioIds.includes(task.id))
    .map((item) => item.id)
    .sort();
  return sha256(
    JSON.stringify({
      contractVersion: evaluationContractVersion,
      skill: skillPackage.sidecar.name,
      packageVersion: skillPackage.sidecar.version,
      scenario: task,
      materializerIds,
      scorerIds,
    }),
  ).slice(0, 16);
}

function campaignHarnessVersion(evaluationContractHash: string): string {
  return `v5-campaign-2026-09-08:${executionMode}:${reasoningEffort}:${wallClockMs}ms:${evaluationContractHash}`;
}

function hasCompletePair(
  runs: readonly SkillEvaluationRun[],
  revisionHash: string,
  scenarioId: string,
  evaluationContractHash: string,
  harnessVersion: string,
): boolean {
  const byPair = new Map<string, Set<string>>();
  for (const run of runs) {
    if (
      run.revisionHash !== revisionHash ||
      run.protocolVersion !== 3 ||
      run.evaluator !== 'deterministic' ||
      run.caseCategory !== 'full-task' ||
      run.scenarioId !== scenarioId ||
      run.evaluationContractHash !== evaluationContractHash ||
      run.harnessVersion !== harnessVersion ||
      run.infrastructureFailure ||
      !run.comparisonId ||
      !run.variant
    ) {
      continue;
    }
    const pairKey = `${run.comparisonId}\u0000${run.provider}\u0000${run.model}`;
    const variants = byPair.get(pairKey) ?? new Set<string>();
    variants.add(run.variant);
    byPair.set(pairKey, variants);
  }
  return [...byPair.values()].some(
    (variants) => variants.has('with-skill') && variants.has('without-skill'),
  );
}

interface CampaignItem {
  skillPackage: V5CompiledSkillPackage;
  revision: SkillRevision;
  task: V5FullTaskFixture;
  evaluationContractHash: string;
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
  const openRegressionScenarioIds = openRegressionsOnly
    ? new Set(
        listOpenSkillRegressionSources(projectRoot, skillPackage.sidecar.name, revision.hash).map(
          (run) => run.scenarioId ?? run.caseId,
        ),
      )
    : null;
  for (const task of skillPackage.evaluation.tasks) {
    if (requestedScenarios.size && !requestedScenarios.has(task.id)) continue;
    if (openRegressionScenarioIds && !openRegressionScenarioIds.has(task.id)) continue;
    if (!readinessByScenario.get(task.id)?.ready) continue;
    const evaluationContractHash = contractHash(skillPackage, task);
    if (
      !force &&
      !openRegressionsOnly &&
      hasCompletePair(
        runs,
        revision.hash,
        task.id,
        evaluationContractHash,
        campaignHarnessVersion(evaluationContractHash),
      )
    ) {
      skippedComplete.push({ skill: skillPackage.sidecar.name, scenarioId: task.id });
      continue;
    }
    queued.push({ skillPackage, revision, task, evaluationContractHash });
  }
}

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        dryRun: true,
        mode: openRegressionsOnly ? 'open-regressions' : 'qualification',
        selectedSkills: selectedPackages.length,
        readyScenarios: readiness.filter((row) => row.ready).length,
        environmentBlockedScenarios: blocked.length,
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

const executor = textPatchMode
  ? createTextOnlyPatchSkillEvalExecutor({
      model,
      reasoningEffort,
      wallClockMs,
    })
  : createIsolatedCodexSkillEvalExecutor({
      model,
      reasoningEffort,
      wallClockMs,
    });
const completed: Array<{
  skill: string;
  scenarioId: string;
  pairId: string;
  withSkillPassed: boolean | null;
  withoutSkillPassed: boolean | null;
}> = [];
const failed: Array<{ skill: string; scenarioId: string; detail: string }> = [];
let cursor = 0;

async function runWorker(): Promise<void> {
  while (true) {
    const index = cursor;
    cursor += 1;
    const item = queued[index];
    if (!item) return;
    const { skillPackage, revision, task, evaluationContractHash } = item;
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
        harnessVersion: campaignHarnessVersion(evaluationContractHash),
        evaluationContractHash,
        evaluationContractVersion,
        executor,
        materializers: BUILTIN_SKILL_EVAL_MATERIALIZERS,
        scorers: BUILTIN_SKILL_EVAL_SCORERS,
        persist: true,
        executionOrder: priorPairCount % 2 === 0 ? 'without-skill-first' : 'with-skill-first',
      });
      try {
        const withInfrastructureFailure = Boolean(
          result.withSkill.observation.infrastructureFailure,
        );
        const withoutInfrastructureFailure = Boolean(
          result.withoutSkill.observation.infrastructureFailure,
        );
        if (withInfrastructureFailure || withoutInfrastructureFailure) {
          failed.push({
            skill: skillPackage.sidecar.name,
            scenarioId: task.id,
            detail: [
              result.withSkill.observation.infrastructureFailure?.detail,
              result.withoutSkill.observation.infrastructureFailure?.detail,
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
            infrastructureFailure: withInfrastructureFailure || withoutInfrastructureFailure,
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
    },
    null,
    2,
  ),
);

if (failed.length) process.exitCode = 1;
