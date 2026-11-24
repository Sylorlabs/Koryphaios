import { resolve } from 'node:path';
import { listSkillEvaluationRuns } from '../backend/src/kory/skill-evaluations';
import { listSkills } from '../backend/src/kory/skills';
const projectRoot = resolve(import.meta.dir, '..');
const skill = process.argv[2]!;
const rev = listSkills(projectRoot)
  .filter((s) => s.state === 'active' && s.validation.valid)
  .find((s) => s.name === skill)!;
const runs = listSkillEvaluationRuns(projectRoot, skill).filter(
  (r) =>
    r.evaluator === 'deterministic' &&
    r.revisionHash === rev.hash &&
    !r.infrastructureFailure &&
    r.variant !== 'without-skill',
);
console.log(`total candidate runs at current revision: ${runs.length}`);
for (const r of runs.filter((r) => r.verification < 0.8 || !r.passed)) {
  console.log(
    `FAIL ${r.caseId} var=${r.variant} p=${r.passed} q=${r.quality} v=${r.verification} at=${r.recordedAt} cat=${r.caseCategory} regression=${r.regressionId ?? '-'}`,
  );
  console.log(`   harness=${r.harnessVersion}`);
}
