import { listOpenSkillRegressionSources, listSkillEvaluationRuns } from '../../../backend/src/kory/skill-evaluations.ts';
import { listSkills } from '../../../backend/src/kory/skills.ts';
const root = process.cwd();
const revs = new Map(listSkills(root).filter((s) => s.state === 'active' && s.validation.valid).map((s) => [s.name, s.hash]));
for (const name of ['angular-engineering', 'react-engineering', 'literature-research']) {
  const rev = revs.get(name)!;
  const open = listOpenSkillRegressionSources(root, name, rev);
  console.log(`\n=== ${name} open=${open.length}`);
  for (const r of open) {
    const a = r as any;
    console.log('SOURCE', JSON.stringify({ id: a.id, at: a.recordedAt, protocol: a.protocolVersion, scenario: a.scenarioId, cv: a.evaluationContractVersion, mat: a.materializerId, scorer: a.deterministicScorerId, passed: a.passed, q: a.quality, v: a.verification }));
  }
  const runs = listSkillEvaluationRuns(root, name).filter((r) => r.evaluator === 'deterministic').sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt))).slice(-3);
  for (const r of runs) {
    const a = r as any;
    console.log('RUN', JSON.stringify({ id: a.id, at: a.recordedAt, variant: a.variant, passed: a.passed, q: a.quality, v: a.verification, reg: a.regressionId }));
  }
}
