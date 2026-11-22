// Whole-library promotion inventory. Uses the active revision from listSkills and
// the real gate function, so the summary cannot drift from the evaluator that
// actually decides promotion.
import { resolve } from 'node:path';
import { evaluateSkillPromotion, listOpenSkillRegressionSources } from '../../backend/src/kory/skill-evaluations';
import { listSkills } from '../../backend/src/kory/skills';

const root = resolve(import.meta.dir, '../..');
const skills = listSkills(root);
const rows: string[] = [];
const byStatus: Record<string, number> = {};

for (const skill of skills) {
  if (skill.state !== 'active' || !skill.validation.valid) {
    const status = skill.state !== 'active' ? `state:${skill.state}` : 'invalid';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    rows.push(JSON.stringify({ skill: skill.name, status }));
    continue;
  }
  try {
    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    const open = listOpenSkillRegressionSources(root, skill.name, skill.hash).length;
    byStatus[gate.status] = (byStatus[gate.status] ?? 0) + 1;
    rows.push(
      JSON.stringify({
        skill: skill.name,
        rev: skill.hash.slice(0, 12),
        status: gate.status,
        cand: gate.candidateRuns,
        base: gate.baselineRuns,
        pass: gate.passRate == null ? null : Number(gate.passRate.toFixed(3)),
        verify: gate.verification == null ? null : Number(gate.verification.toFixed(3)),
        blind: gate.provenancedBlindReviews,
        open,
        delta: gate.delta?.passRate == null ? null : Number(gate.delta.passRate.toFixed(3)),
        reasons: gate.ready ? undefined : (gate.reasons ?? []).slice(0, 3),
      }),
    );
  } catch (error) {
    byStatus.error = (byStatus.error ?? 0) + 1;
    rows.push(
      JSON.stringify({
        skill: skill.name,
        status: 'error',
        reasons: [error instanceof Error ? error.message.split('\n')[0] : String(error)],
      }),
    );
  }
}

for (const row of rows) console.log(row);
console.log(
  JSON.stringify({
    total: skills.length,
    byStatus: Object.fromEntries(Object.entries(byStatus).sort((a, b) => b[1] - a[1])),
  }),
);
