import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createIsolatedCodexSkillEvalExecutor } from '../backend/src/kory/skill-eval-codex';
import { runPairedSkillEvaluationV3 } from '../backend/src/kory/skill-eval-execution';
import {
  CURRENT_SKILL_EVAL_CONTRACT_VERSION,
  listSkillEvaluationRuns,
} from '../backend/src/kory/skill-evaluations';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../backend/src/kory/skill-eval-fixtures';
import { loadV5SkillPackages } from '../backend/src/kory/skill-packages';
import { listSkills } from '../backend/src/kory/skills';

const projectRoot = resolve(import.meta.dir, '..');
const evaluationContractVersion = CURRENT_SKILL_EVAL_CONTRACT_VERSION;
const allPackages = loadV5SkillPackages(resolve(projectRoot, 'skills-v5')).packages;
const representativePilotSkills = [
  'interaction-design',
  'backend-engineering',
  'deterministic-debugging',
  'agentic-systems',
  'data-analysis',
  'application-security',
] as const;
const requestedSkills = process.argv.includes('--pilot')
  ? [...representativePilotSkills]
  : process.argv
      .filter((argument) => argument.startsWith('--skill='))
      .map((argument) => argument.slice('--skill='.length).trim())
      .filter(Boolean);
if (!requestedSkills.length) requestedSkills.push('deterministic-debugging');
const requestedScenarios = new Set(
  process.argv
    .filter((argument) => argument.startsWith('--scenario='))
    .map((argument) => argument.slice('--scenario='.length).trim())
    .filter(Boolean),
);
const skillPackages = requestedSkills.map((name) => {
  const skillPackage = allPackages.find((item) => item.sidecar.name === name);
  if (!skillPackage) throw new Error(`${name} V5 package is missing`);
  return skillPackage;
});
const runtimeSkills = listSkills(projectRoot);
const runtimeSkillByName = new Map(
  skillPackages.map((skillPackage) => {
    const runtimeSkill = runtimeSkills.find(
      (item) =>
        item.name === skillPackage.sidecar.name && item.state === 'active' && item.validation.valid,
    );
    if (!runtimeSkill) {
      throw new Error(`${skillPackage.sidecar.name} has no active valid runtime skill revision`);
    }
    if (!runtimeSkill.sourceContent.includes(skillPackage.instructions.trim())) {
      throw new Error(
        `${skillPackage.sidecar.name} runtime revision does not contain the current V5 package instructions; sync the package before evaluating it`,
      );
    }
    return [skillPackage.sidecar.name, runtimeSkill] as const;
  }),
);
const configuredWallClockMs = Number(
  process.env.KORY_SKILL_EVAL_WALL_CLOCK_MS?.trim() ||
    process.argv
      .find((argument) => argument.startsWith('--wall-clock-ms='))
      ?.slice('--wall-clock-ms='.length) ||
    '180000',
);
if (!Number.isFinite(configuredWallClockMs) || configuredWallClockMs < 10_000) {
  throw new Error(`Invalid skill-eval wall-clock budget: ${String(configuredWallClockMs)}`);
}
const executor = createIsolatedCodexSkillEvalExecutor({
  model: process.env.KORY_SKILL_EVAL_MODEL?.trim() || 'gpt-5.6-sol',
  wallClockMs: configuredWallClockMs,
});
const results = [];
const evaluationContractHashes: Record<string, string> = {};

for (const skillPackage of skillPackages) {
  const runtimeSkill = runtimeSkillByName.get(skillPackage.sidecar.name);
  if (!runtimeSkill) throw new Error(`${skillPackage.sidecar.name} runtime revision disappeared`);
  const revisionHash = runtimeSkill.hash;
  const scenarios = skillPackage.evaluation.tasks.filter(
    (scenario) => !requestedScenarios.size || requestedScenarios.has(scenario.id),
  );
  if (!scenarios.length) {
    throw new Error(`No requested scenarios matched ${skillPackage.sidecar.name}`);
  }
  for (const scenario of scenarios) {
    const materializerIds = BUILTIN_SKILL_EVAL_MATERIALIZERS.filter((item) =>
      item.matches(scenario),
    )
      .map((item) => item.id)
      .sort();
    const scorerIds = BUILTIN_SKILL_EVAL_SCORERS.filter((item) =>
      item.scenarioIds.includes(scenario.id),
    )
      .map((item) => item.id)
      .sort();
    const evaluationContractHash = createHash('sha256')
      .update(
        JSON.stringify({
          contractVersion: evaluationContractVersion,
          skill: skillPackage.sidecar.name,
          packageVersion: skillPackage.sidecar.version,
          scenario,
          materializerIds,
          scorerIds,
        }),
      )
      .digest('hex')
      .slice(0, 16);
    evaluationContractHashes[scenario.id] = evaluationContractHash;
    const priorPairCount = listSkillEvaluationRuns(projectRoot, skillPackage.sidecar.name).filter(
      (run) =>
        run.revisionHash === revisionHash &&
        run.scenarioId === scenario.id &&
        run.variant === 'with-skill' &&
        Boolean(run.comparisonId),
    ).length;
    const result = await runPairedSkillEvaluationV3({
      projectRoot,
      skillPackage,
      scenarioId: scenario.id,
      skillRevisionHash: revisionHash,
      harnessVersion: `v5-pilot-2026-09-05:${configuredWallClockMs}ms:${evaluationContractHash}`,
      evaluationContractHash,
      evaluationContractVersion,
      executor,
      materializers: BUILTIN_SKILL_EVAL_MATERIALIZERS,
      scorers: BUILTIN_SKILL_EVAL_SCORERS,
      persist: true,
      executionOrder: priorPairCount % 2 === 0 ? 'without-skill-first' : 'with-skill-first',
    });
    results.push({
      skill: skillPackage.sidecar.name,
      packageVersion: skillPackage.sidecar.version,
      revisionHash,
      pairId: result.pairId,
      scenarioId: result.scenarioId,
      evaluationContractHash,
      executionOrder: result.executionOrder,
      initialFingerprint: result.initialFingerprint,
      withSkill: {
        passed: result.withSkill.score?.passed ?? null,
        quality: result.withSkill.score?.quality ?? null,
        verification: result.withSkill.score?.verification ?? null,
        infrastructureFailure: result.withSkill.observation.infrastructureFailure ?? null,
        durationMs: result.withSkill.observation.durationMs,
      },
      withoutSkill: {
        passed: result.withoutSkill.score?.passed ?? null,
        quality: result.withoutSkill.score?.quality ?? null,
        verification: result.withoutSkill.score?.verification ?? null,
        infrastructureFailure: result.withoutSkill.observation.infrastructureFailure ?? null,
        durationMs: result.withoutSkill.observation.durationMs,
      },
    });
    result.cleanup();
  }
}

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      skills: skillPackages.map((item) => item.sidecar.name),
      executor: {
        provider: executor.provider,
        model: executor.model,
        runtimeIdentity: executor.runtimeIdentity,
        tools: executor.tools,
        budget: executor.budget,
      },
      evaluationContractHashes,
      results,
    },
    null,
    2,
  ),
);
