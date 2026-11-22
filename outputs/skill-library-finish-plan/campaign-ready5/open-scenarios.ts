import { listOpenSkillRegressionSources, listSkillEvaluationRuns } from '../../../backend/src/kory/skill-evaluations.ts';
import { listSkills } from '../../../backend/src/kory/skills.ts';
const root = process.cwd();
const revs = new Map(listSkills(root).filter((s) => s.state === 'active' && s.validation.valid).map((s) => [s.name, s.hash]));
for (const name of ['angular-engineering', 'react-engineering', 'literature-research', 'container-engineering', 'application-security']) {
  const rev = revs.get(name)!;
  const open = listOpenSkillRegressionSources(root, name, rev);
  const scenarios = [...new Set(open.map((r) => String((r as any).scenarioId ?? (r as any).caseId)))];
  console.log(`\n${name} open=${open.length} scenarios=${JSON.stringify(scenarios)}`);
  for (const sc of scenarios) {
    const runs = listSkillEvaluationRuns(root, name)
      .filter((r) => String(r.scenarioId ?? r.caseId) === sc)
      .sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)))
      .slice(-4);
    for (const r of runs) {
      const a = r as any;
      console.log('  ', JSON.stringify({ sc, at: a.recordedAt, variant: a.variant, passed: a.passed, q: a.quality, v: a.verification, model: a.model }));
    }
  }
}
