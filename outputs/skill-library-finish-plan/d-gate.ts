import { resolve } from 'node:path';
import { evaluateSkillPromotion, listSkillEvaluationRuns, listOpenSkillRegressionSources } from '../../backend/src/kory/skill-evaluations';
import { listSkills } from '../../backend/src/kory/skills';

const root = resolve(import.meta.dir, '../..');
const group = [
  'react-engineering','nextjs-engineering','vue-engineering','svelte-engineering','angular-engineering',
  'web-interface','visual-interface-design','interaction-design','information-architecture',
  'accessibility-practice','accessibility-verification','novel-ui-toolkit','three-d-graphics',
  'terminal-interface','human-experience','usability-evaluation','visual-verification',
  'content-error-design','frontend-engineering','interface-usability-testing','user-research',
];
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const verbose = process.argv.includes('--verbose');
const revisions = new Map(
  listSkills(root)
    .filter((s) => s.state === 'active' && s.validation.valid)
    .map((s) => [s.name, s]),
);
const names = only.length ? only : group;
for (const name of names) {
  const revision = revisions.get(name);
  if (!revision) {
    console.log(`${name}: NO ACTIVE REVISION`);
    continue;
  }
  const gate = evaluateSkillPromotion(root, name, revision.hash);
  console.log(`\n=== ${name} rev ${revision.hash.slice(0, 12)} status=${gate.status}`);
  console.log(`  candidate=${gate.candidateRuns} baseline=${gate.baselineRuns} pass=${gate.passRate} quality=${gate.quality?.toFixed(3)} verify=${gate.verification?.toFixed(3)}`);
  console.log(`  routing p=${gate.routingPrecision} r=${gate.routingRecall} obs=${gate.routingObservations} blind=${gate.provenancedBlindReviews} openRegr=${gate.openRegressions}/${gate.regressionCases}`);
  console.log(`  pairs=${gate.pairedBaselineCases} cats=${gate.pairedBaselineCategories.join(',')} ft=${gate.categoryCoverage['full-task']}`);
  const d = [gate.skillBaselinePassRateDelta, gate.skillBaselineQualityDelta, gate.skillBaselineVerificationDelta];
  console.log(`  delta pass/qual/verify=${d.map((v) => (v === null ? 'null' : v.toFixed(3))).join('/')}`);
  for (const reason of gate.reasons) console.log(`  REASON: ${reason}`);
  if (verbose) {
    const runs = listSkillEvaluationRuns(root, name).filter((r) => r.revisionHash === revision.hash);
    for (const r of runs.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))) {
      console.log(`  run ${r.recordedAt} ${r.id} cat=${r.category ?? ''} scenario=${r.scenarioId ?? ''} variant=${r.variant} passed=${r.passed} q=${r.quality} v=${r.verification} infra=${r.infrastructureFailure} integ=${r.integrityFailure} eval=${r.evaluator} prov=${r.evaluationContractVersion ?? ''} m=${r.materializerId ?? ''} s=${r.deterministicScorerId ?? ''} src=${r.regressionId ?? ''}`);
    }
    const open = listOpenSkillRegressionSources(root, name);
    console.log('  openRegressionSources', JSON.stringify(open));
  }
}
