import { resolve } from 'node:path';
import { evaluateSkillPromotion } from '../backend/src/kory/skill-evaluations';
import { listSkills } from '../backend/src/kory/skills';
const root = resolve(import.meta.dir, '..');
for (const n of process.argv.slice(2)) {
  const s = listSkills(root).find(x=>x.name===n && x.state==='active' && x.validation.valid);
  if (!s) { console.log(`${n}: not active/valid`); continue; }
  const g = evaluateSkillPromotion(root, n, s.hash);
  console.log(`\n${n} [${g.status}] pass=${(g.passRate??0).toFixed(3)} qual=${(g.qualityRate??0).toFixed(3)} ver=${(g.verificationRate??0).toFixed(3)} blind=${g.blindReviews??0} regr=${g.openRegressions??0} ver_suff=${g.verificationSufficient} qual_suff=${g.qualitySufficient} cases=${(g as any).cases ?? (g as any).evaluatedCases ?? '?'}`);
  for (const r of (g.reasons ?? [])) console.log('   - '+r.slice(0,160));
}
