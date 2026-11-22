import { resolve } from 'node:path';
import { listSkillEvaluationRuns } from '../../../backend/src/kory/skill-evaluations';

const skill = process.argv[2];
const scenario = process.argv[3];
if (!skill) throw new Error('usage: j-run-dump.ts <skill> [scenarioId]');
const projectRoot = resolve(import.meta.dir, '../../..');
const runs = listSkillEvaluationRuns(projectRoot, skill).filter(
  (run) => !scenario || (run.scenarioId ?? run.caseId) === scenario,
);
const SKIP = new Set(['observation', 'score', 'artifacts', 'artifactSummary', 'transcript', 'output']);
const seen = new Set<string>();
for (const run of runs) {
  const key = `${run.evaluationContractHash}|${run.revisionHash}|${run.skillVersion ?? ''}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const flat: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(run)) {
    if (SKIP.has(field)) continue;
    if (typeof value === 'string' && value.length > 220) flat[field] = `${value.slice(0, 220)}…`;
    else if (Array.isArray(value) && value.length > 4) flat[field] = value.slice(0, 4);
    else flat[field] = value;
  }
  console.log(JSON.stringify(flat));
}
console.log(`distinct contract cohorts: ${seen.size} of ${runs.length} runs`);
