// Read-only per-skill promotion gate readout for the K group.
// Usage: bun --no-env-file outputs/skill-library-finish-plan/campaign-k/gate.ts <skill> [...]
import { evaluateSkillPromotion } from '../../../backend/src/kory/skill-evaluations.ts';
import { listSkills } from '../../../backend/src/kory/skills.ts';

const root = process.cwd();
const revisions = new Map(
  listSkills(root)
    .filter((skill) => skill.state === 'active' && skill.validation.valid)
    .map((skill) => [skill.name, skill]),
);
for (const name of process.argv.slice(2)) {
  const revision = revisions.get(name);
  if (!revision) {
    console.log(`${name}: NO ACTIVE REVISION`);
    continue;
  }
  const gate = evaluateSkillPromotion(root, name, revision.hash);
  console.log(
    JSON.stringify({
      skill: name,
      revision: revision.hash.slice(0, 12),
      status: gate.status,
      candidateRuns: gate.candidateRuns,
      passRate: gate.passRate,
      verification: gate.verification,
      routing: [gate.routingPrecision, gate.routingRecall],
      fullTask: gate.categoryCoverage['full-task'],
      pairs: gate.pairedBaselineCategoryCounts['full-task'],
      blind: gate.provenancedBlindReviews,
      openRegressions: gate.openRegressions,
      uplift: [
        gate.skillBaselinePassRateDelta,
        gate.skillBaselineQualityDelta,
        gate.skillBaselineVerificationDelta,
      ],
      exclusions: gate.excludedEvidence.length,
      reasons: gate.reasons,
    }),
  );
}
