import { resolve } from 'node:path';
import {
  listSkillEvaluationRuns,
  evaluateSkillPromotion,
} from '../backend/src/kory/skill-evaluations';
import { listSkills } from '../backend/src/kory/skills';
const root = resolve(import.meta.dir, '..');
for (const skill of process.argv.slice(2)) {
  const s = listSkills(root).find(
    (x) => x.name === skill && x.state === 'active' && x.validation.valid,
  );
  if (!s) {
    console.log(`${skill}: invalid`);
    continue;
  }
  const g = evaluateSkillPromotion(root, skill, s.hash);
  const rows = listSkillEvaluationRuns(root, skill).filter(
    (r) => r.revisionHash === s.hash && r.variant !== 'without-skill',
  );
  const ft = rows.filter((r) => r.caseCategory === 'full-task');
  const ftp = ft.filter((r) => r.passed);
  const paired = new Set(
    rows.filter((r) => r.caseCategory === 'full-task').map((r) => r.comparisonId),
  );
  console.log(
    `${skill.padEnd(24)} ${g.status.padEnd(22)} cand=${rows.length} pass=${rows.filter((r) => r.passed).length} ft=${ftp.length}/${ft.length} ftPairs=${paired.size} regr=${g.openRegressions}`,
  );
}
