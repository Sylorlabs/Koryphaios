import { resolve } from 'node:path';
import { listSkills } from './backend/src/kory/skills';
import { evaluateSkillPromotion } from './backend/src/kory/skill-evaluations';

const root = resolve(import.meta.dir);
const wanted = new Set(process.argv.slice(2));
for (const revision of listSkills(root)) {
  if (wanted.size && !wanted.has(revision.name)) continue;
  const gate = evaluateSkillPromotion(root, revision.name, revision.hash);
  console.log(JSON.stringify({
    skill: revision.name,
    revisionHash: revision.hash.slice(0, 8),
    status: gate.status,
    passRate: gate.passRate,
    paired: gate.pairedEvaluations,
    dPass: gate.pairedPassDelta,
    blind: gate.blindReviews,
    openRegr: gate.openRegressions,
    reasons: gate.reasons,
  }));
}
