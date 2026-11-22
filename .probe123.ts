import { evaluateSkillPromotion } from './backend/src/kory/skill-evaluations';
import { listSkills } from './backend/src/kory/skills';
const root = process.cwd();
const rev = listSkills(root).find((s) => s.name === 'desktop-electron-tauri')!;
const g: any = evaluateSkillPromotion(root, rev.name, rev.hash);
console.log(rev.hash.slice(0, 8), g.status, 'rate', g.passRate && Number(g.passRate).toFixed(3), 'open', g.openRegressions);
for (const r of g.reasons ?? []) console.log('  -', String(r).slice(0, 140));
