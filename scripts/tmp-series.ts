import { resolve } from 'node:path';
import { listSkillEvaluationRuns, evaluateSkillPromotion } from '../backend/src/kory/skill-evaluations';
import { listSkills } from '../backend/src/kory/skills';
const projectRoot = resolve(import.meta.dir, '..');
const skill = process.argv[2]!;
const rev = listSkills(projectRoot).filter(s=>s.state==='active'&&s.validation.valid).find(s=>s.name===skill)!;
const runs = listSkillEvaluationRuns(projectRoot, skill).filter(r=>r.evaluator==='deterministic' && r.revisionHash===rev.hash && !r.infrastructureFailure);
const byPair = new Map<string, any[]>();
for (const r of runs) { if (!r.comparisonId) continue; byPair.set(r.comparisonId, [...(byPair.get(r.comparisonId)??[]), r]); }
const series = new Map<string, {key:string; cand:any[]; base:any[]; at:string}>();
for (const [key, group] of byPair) {
  const cand = group.filter(r=>r.variant==='with-skill');
  const base = group.filter(r=>r.variant==='without-skill');
  if (!cand.length || !base.length) continue;
  if (cand.some((r:any)=>r.caseCategory==='regression')) continue;
  const r0 = cand[0];
  const sk = [r0.caseId, r0.provider, r0.model, r0.harnessVersion, r0.role, r0.medium??''].join('|');
  const at = [...cand,...base].reduce((a:any,b:any)=>b.recordedAt>a?b.recordedAt:a,'');
  const cur = series.get(sk);
  if (!cur || at > cur.at || (at===cur.at && key>cur.key)) series.set(sk, {key, cand, base, at});
}
const mean=(a:number[])=>a.reduce((x,y)=>x+y,0)/a.length;
let sp=0,sq=0,sv=0;
for (const s of series.values()) {
  const dp = mean(s.cand.map((r:any)=>r.passed?1:0)) - mean(s.base.map((r:any)=>r.passed?1:0));
  const dq = mean(s.cand.map((r:any)=>r.quality)) - mean(s.base.map((r:any)=>r.quality));
  const dv = mean(s.cand.map((r:any)=>r.verification)) - mean(s.base.map((r:any)=>r.verification));
  sp+=dp; sq+=dq; sv+=dv;
  console.log(`${dp>=0&&dq>=0&&dv>=0?'OK  ':'NEG '} d=${dp.toFixed(2)}/${dq.toFixed(2)}/${dv.toFixed(2)} ${s.cand[0].caseId.replace(skill+'-','')} harness=${s.cand[0].harnessVersion.split(':').slice(0,3).join(':')}...${s.cand[0].harnessVersion.split(':').slice(-2).join(':')} ${s.at}`);
}
console.log(`\nseries=${series.size} sums pass=${sp.toFixed(2)} qual=${sq.toFixed(2)} ver=${sv.toFixed(2)} means=${(sp/series.size).toFixed(3)}/${(sq/series.size).toFixed(3)}/${(sv/series.size).toFixed(3)}`);
