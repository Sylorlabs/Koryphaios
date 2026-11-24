import { resolve } from 'node:path';
import { listSkillEvaluationRuns } from '../backend/src/kory/skill-evaluations';
const projectRoot = resolve(import.meta.dir, '..');
const skill = process.argv[2]!;
const runs = listSkillEvaluationRuns(projectRoot, skill)
  .filter((r) => r.evaluator === 'deterministic')
  .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
const last = runs.slice(-6);
for (const r of last) {
  console.log(`\n--- ${r.id}`);
  console.log(
    `  variant=${r.variant} passed=${r.passed} q=${r.quality} v=${r.verification} at=${r.recordedAt} provider=${r.provider} model=${r.model}`,
  );
  console.log(
    `  mat=${r.materializerId} scorer=${r.deterministicScorerId} hash=${r.evaluationContractHash}`,
  );
  console.log(`  harness=${r.harnessVersion}`);
  for (const e of (r.evidence || []).slice(0, 14)) console.log(`   E: ${e.slice(0, 300)}`);
  console.log(
    `  artifacts=${(r.artifacts || []).map((a) => a.location.split('/').slice(-2).join('/')).join(', ')}`,
  );
}
