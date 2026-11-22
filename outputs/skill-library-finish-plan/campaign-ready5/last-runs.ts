import { listSkillEvaluationRuns } from '../../../backend/src/kory/skill-evaluations.ts';
import { listSkills } from '../../../backend/src/kory/skills.ts';
const root = process.cwd();
const revs = new Map(listSkills(root).filter((s) => s.state === 'active' && s.validation.valid).map((s) => [s.name, s.hash]));
const targets: Record<string, string[]> = {
  'factual-research': ['factual-research-full-task-2-individual'],
  'secure-authentication': ['secure-authentication-full-task-2'],
  'terminal-interface': ['terminal-interface-full-task-1-individual'],
  'angular-engineering': ['angular-engineering-full-task-2-individual'],
};
for (const [skill, scenarios] of Object.entries(targets)) {
  const rev = revs.get(skill)!;
  const runs = listSkillEvaluationRuns(root, skill)
    .filter((r) => scenarios.includes(r.scenarioId ?? r.caseId ?? ''))
    .sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)));
  console.log(`\n${skill} rev=${rev.slice(0, 12)} runs=${runs.length}`);
  for (const r of runs.slice(-6)) {
    const any = r as unknown as Record<string, unknown>;
    console.log('  ', JSON.stringify({ at: any.recordedAt, variant: any.variant, passed: any.passed, q: any.quality, v: any.verification, model: any.model, rev: String(any.revisionHash).slice(0, 8), infra: any.infrastructureFailure, integrity: any.integrityFailure }));
  }
}
