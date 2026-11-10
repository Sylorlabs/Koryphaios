import { resolve } from 'node:path';
import { evaluateSkillPromotion } from '../backend/src/kory/skill-evaluations';
import { listSkills } from '../backend/src/kory/skills';
const root = resolve(import.meta.dir, '..');
const pkgs = listSkills(root).filter(s=>s.state==='active'&&s.validation.valid);
const oneReview: string[] = [];
const reviewPlusRegr: Array<[string, number]> = [];
const reviewPlusCoverage: string[] = [];
const other: string[] = [];
for (const s of pkgs) {
  const g = evaluateSkillPromotion(root, s.name, s.hash);
  if (g.status === 'ready') continue;
  const reasons = (g.reasons ?? []).map(r=>r.replace(/\d+/gu,'<n>'));
  const onlyReview = reasons.length === 1 && reasons[0].startsWith('At least one blind review');
  const reviewRegr = reasons.every(r=>r.startsWith('At least one blind review') || r.includes('regression case'));
  const reviewCov = reasons.every(r=>r.startsWith('At least one blind review') || r.includes('regression case') || r.includes('at least two observed full-task') || r.includes('Benchmark coverage is missing') || r.includes('baselines are missing') || r.includes('two paired full-task'));
  if (onlyReview) oneReview.push(s.name);
  else if (reviewRegr) reviewPlusRegr.push([s.name, g.openRegressions ?? 0]);
  else if (reviewCov) reviewPlusCoverage.push(s.name);
  else other.push(s.name);
}
console.log(`ONE REVIEW AWAY (${oneReview.length}): ${oneReview.join(', ')}`);
console.log(`\nREVIEW + CLOSE REGRESSIONS (${reviewPlusRegr.length}):`);
for (const [n, r] of reviewPlusRegr.sort((a,b)=>a[1]-b[1])) console.log(`  ${n} regr=${r}`);
console.log(`\nREVIEW + REGRESSIONS + FULL ROUND (${reviewPlusCoverage.length}): ${reviewPlusCoverage.join(', ')}`);
console.log(`\nOTHER (${other.length}): ${other.join(', ')}`);
