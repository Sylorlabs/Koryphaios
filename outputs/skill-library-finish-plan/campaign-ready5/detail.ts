import { listOpenSkillRegressionSources, listSkillEvaluationRuns } from '../../../backend/src/kory/skill-evaluations.ts';
import { listSkills } from '../../../backend/src/kory/skills.ts';
const root = process.cwd();
const revs = new Map(listSkills(root).filter((s) => s.state === 'active' && s.validation.valid).map((s) => [s.name, s.hash]));
for (const name of ['container-engineering', 'application-security']) {
  const rev = revs.get(name)!;
  console.log(`\n=== ${name} current=${rev.slice(0, 12)}`);
  const open = listOpenSkillRegressionSources(root, name, rev);
  for (const r of open) {
    const a = r as any;
    console.log('SOURCE', JSON.stringify({ id: a.id, at: a.recordedAt, rev: String(a.revisionHash).slice(0, 8), passed: a.passed, q: a.quality, v: a.verification, model: a.model, provider: a.provider, eval: a.evaluator, cv: a.evaluationContractVersion, mat: a.materializerId, scorer: a.deterministicScorerId, hash: a.evaluationContractHash, role: a.role, medium: a.medium, reg: a.regressionId }));
  }
  const runs = listSkillEvaluationRuns(root, name).filter((r) => r.evaluator === 'deterministic').sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt))).slice(-6);
  for (const r of runs) {
    const a = r as any;
    console.log('RUN   ', JSON.stringify({ id: a.id, at: a.recordedAt, rev: String(a.revisionHash).slice(0, 8), variant: a.variant, passed: a.passed, q: a.quality, v: a.verification, model: a.model, provider: a.provider, cv: a.evaluationContractVersion, mat: a.materializerId, scorer: a.deterministicScorerId, role: a.role, medium: a.medium, reg: a.regressionId }));
  }
}
