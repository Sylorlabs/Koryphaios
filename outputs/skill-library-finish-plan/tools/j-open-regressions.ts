import { resolve } from 'node:path';
import {
  listOpenSkillRegressionSources,
  listSkillEvaluationRuns,
} from '../../../backend/src/kory/skill-evaluations';
import { listSkills } from '../../../backend/src/kory/skills';

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
const revisions = new Map(
  listSkills(projectRoot)
    .filter((skill) => skill.state === 'active' && skill.validation.valid)
    .map((skill) => [skill.name, skill]),
);

for (const name of GROUP) {
  const revision = revisions.get(name);
  if (!revision) continue;
  const all = listSkillEvaluationRuns(projectRoot, name);
  const sources = listOpenSkillRegressionSources(projectRoot, name, revision.hash);
  console.log(`\n== ${name} (revision ${revision.hash.slice(0, 12)}) open regression sources: ${sources.length}`);
  for (const run of sources) {
    console.log(JSON.stringify({
      id: run.id,
      scenarioId: run.scenarioId ?? run.caseId,
      revisionHash: run.revisionHash?.slice(0, 12),
      harnessVersion: run.harnessVersion,
      provider: run.provider,
      model: run.model,
      contractVersion: run.evaluationContractVersion,
      contractHash: run.evaluationContractHash?.slice(0, 16),
      recordedAt: run.recordedAt ?? run.timestamp ?? run.createdAt,
      passed: run.passed,
      quality: run.quality,
      verification: run.verification,
      integrityFailure: run.integrityFailure,
      evaluationNotes: run.evaluationNotes?.slice?.(0, 4),
    }));
  }
  const recent = all.slice(-3).map((run) => ({
    id: run.id,
    scenarioId: run.scenarioId ?? run.caseId,
    variant: run.variant,
    provider: run.provider,
    model: run.model,
    recordedAt: run.recordedAt ?? run.timestamp ?? run.createdAt,
    revision: run.revisionHash?.slice(0, 12),
  }));
  console.log('recent runs:', JSON.stringify(recent));
}
