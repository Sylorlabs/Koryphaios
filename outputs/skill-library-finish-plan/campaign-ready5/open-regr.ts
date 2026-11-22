import { listOpenSkillRegressionSources } from '../../../backend/src/kory/skill-evaluations.ts';
import { listSkills } from '../../../backend/src/kory/skills.ts';
const root = process.cwd();
const revs = new Map(listSkills(root).filter((s) => s.state === 'active' && s.validation.valid).map((s) => [s.name, s.hash]));
for (const name of ['factual-research', 'secure-authentication', 'terminal-interface', 'angular-engineering']) {
  const rev = revs.get(name)!;
  const runs = listOpenSkillRegressionSources(root, name, rev);
  console.log(`${name} rev=${rev.slice(0, 12)} open=${runs.length}`);
  for (const r of runs) {
    const any = r as unknown as Record<string, unknown>;
    console.log('  ', JSON.stringify({ id: any.id, scenario: any.scenarioId, caseId: any.caseId, passed: any.passed, variant: any.variant, score: any.verification ?? any.quality, at: any.recordedAt }));
  }
}
