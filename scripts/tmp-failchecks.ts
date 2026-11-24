import { resolve } from 'node:path';
import { listSkillEvaluationRuns } from '../backend/src/kory/skill-evaluations';
const root = resolve(import.meta.dir, '..');
const skill = process.argv[2]!;
const runs = listSkillEvaluationRuns(root, skill).filter(
  (r) => r.variant !== 'without-skill' && r.passed === false,
);
const seen = new Set<string>();
for (const r of runs.slice(-6)) {
  console.log(`\n-- ${r.scenarioId ?? r.caseId} ${r.recordedAt} q=${r.quality}`);
  for (const e of r.evidence) {
    const m = e.match(/^(?:E: )?([a-z][\w\/ ()-]{3,70}): fail/u);
    if (!m) continue;
    const key = m[1];
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`   FAILCHECK: ${e.replace(/\s+/gu, ' ').slice(0, 260)}`);
  }
  for (const e of r.evidence) {
    const m = e.match(/error: ([^\n]{0,140})/u);
    if (m) {
      console.log(`   ERROR: ${m[1]}`);
      break;
    }
  }
}
