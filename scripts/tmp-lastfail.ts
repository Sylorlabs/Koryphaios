import { resolve } from 'node:path';
import { listSkillEvaluationRuns } from '../backend/src/kory/skill-evaluations';
const root = resolve(import.meta.dir, '..');
for (const skill of process.argv.slice(2)) {
  const runs = listSkillEvaluationRuns(root, skill).filter(
    (r) => r.variant !== 'without-skill' && r.passed === false,
  );
  if (!runs.length) {
    console.log(`\n### ${skill}: no failing candidate runs`);
    continue;
  }
  const r = runs[runs.length - 1];
  console.log(
    `\n### ${skill} ${r.scenarioId ?? r.caseId} q=${Number(r.quality).toFixed(2)} ${r.recordedAt}`,
  );
  for (const e of r.evidence) {
    if (/(: fail\b|error:)/u.test(e)) {
      const one = e.replace(/\s+/gu, ' ');
      console.log('   ' + one.slice(0, 240));
      if (one.length > 240) break;
    }
  }
}
