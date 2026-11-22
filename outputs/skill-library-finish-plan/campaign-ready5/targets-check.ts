import { listOpenSkillRegressionSources } from '../../../backend/src/kory/skill-evaluations.ts';
import { listSkills } from '../../../backend/src/kory/skills.ts';
const root = process.cwd();
const revs = new Map(listSkills(root).filter((s) => s.state === 'active' && s.validation.valid).map((s) => [s.name, s.hash]));
for (const name of ['visual-verification', 'android-compose']) {
  const rev = revs.get(name)!;
  const open = listOpenSkillRegressionSources(root, name, rev);
  console.log(`=== ${name} open=${open.length}`);
  for (const r of open) {
    const a = r as any;
    console.log('SOURCE', JSON.stringify({ id: a.id, protocol: a.protocolVersion, scenario: a.scenarioId, cv: a.evaluationContractVersion, mat: a.materializerId, scorer: a.deterministicScorerId, passed: a.passed, q: a.quality, v: a.verification }));
  }
}
