import { resolve } from 'node:path';
import {
  CURRENT_SKILL_EVAL_CONTRACT_VERSION,
  listSkillEvaluationRuns,
} from '../../../backend/src/kory/skill-evaluations';
import { BUILTIN_SKILL_EVAL_MATERIALIZERS, BUILTIN_SKILL_EVAL_SCORERS } from '../../../backend/src/kory/skill-eval-fixtures';
import { skillEvaluationV5ContractHash } from '../../../backend/src/kory/skill-eval-contract-hash';
import { loadV5SkillPackages } from '../../../backend/src/kory/skill-packages';
import { listSkills } from '../../../backend/src/kory/skills';

// Read-only diagnosis: current contract identity per full-task scenario versus
// the contract identity recorded on every ledger run for that scenario.
const GROUP = [
  'architecture-planning',
  'planning',
  'feature-implementation',
  'refactor-implementation',
  'integration-implementation',
  'research',
  'literature-research',
  'factual-research',
  'market-competitive-research',
];

const projectRoot = resolve(import.meta.dir, '../../..');
const catalog = loadV5SkillPackages(resolve(projectRoot, 'skills-v5'));
const revisions = new Map(
  listSkills(projectRoot)
    .filter((skill) => skill.state === 'active' && skill.validation.valid)
    .map((skill) => [skill.name, skill]),
);

for (const name of GROUP) {
  const pkg = catalog.packages.find((item) => item.sidecar.name === name);
  const revision = revisions.get(name);
  if (!pkg || !revision) continue;
  const runs = listSkillEvaluationRuns(projectRoot, name);
  console.log(`\n== ${name} pkg ${pkg.sidecar.version} revision ${revision.hash.slice(0, 12)}`);
  for (const task of pkg.evaluation.tasks) {
    const scenario = {
      id: task.id,
      skill: name,
      category: 'full-task' as const,
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
    const current = skillEvaluationV5ContractHash({
      contractVersion: CURRENT_SKILL_EVAL_CONTRACT_VERSION,
      skill: name,
      packageVersion: pkg.sidecar.version,
      scenario: task,
      materializerIds,
      scorerIds,
    });
    console.log(`  task ${task.id}`);
    console.log(`    current hash=${current.hash} materializers=${materializerIds.join(',')} scorers=${scorerIds.join(',')}`);
    const observed = new Map<string, number>();
    for (const run of runs) {
      if ((run.scenarioId ?? '') !== task.id) continue;
      const key = `${run.evaluationContractVersion ?? '?'}|${run.evaluationContractHash?.slice(0, 12) ?? 'none'}|${run.materializerId ?? 'none'}|${run.deterministicScorerId ?? 'none'}|rev=${run.revisionHash.slice(0, 8)}`;
      observed.set(key, (observed.get(key) ?? 0) + 1);
    }
    for (const [key, count] of observed) console.log(`    ledger x${count} ${key}`);
  }
}
