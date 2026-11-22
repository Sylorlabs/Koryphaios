import { resolve } from 'node:path';
import { listSkillEvaluationRuns } from '../../../backend/src/kory/skill-evaluations';

const GROUP = [
  'architecture-planning',
  'planning',
  'feature-implementation',
  'refactor-implementation',
  'implementation',
  'integration-implementation',
  'developer-experience',
  'repository-environment-discovery',
  'repository-research',
  'research',
  'literature-research',
  'factual-research',
  'market-competitive-research',
];
const projectRoot = resolve(import.meta.dir, '../../..');

for (const name of GROUP) {
  const runs = listSkillEvaluationRuns(projectRoot, name).filter(
    (run) => run.evaluator === 'blind-review' || run.evaluator === 'human-blind-review',
  );
  if (!runs.length) {
    console.log(`${name}: no blind review runs`);
    continue;
  }
  console.log(`\n== ${name}: ${runs.length} blind runs`);
  for (const run of runs.slice(-4)) {
    console.log(JSON.stringify({
      id: run.id,
      evaluator: run.evaluator,
      scenarioId: run.scenarioId ?? run.caseId,
      revision: run.revisionHash?.slice(0, 12),
      provider: run.provider,
      model: run.model,
      harnessVersion: run.harnessVersion,
      passed: run.passed,
      quality: run.quality,
      verification: run.verification,
      recordedAt: run.recordedAt,
      provenance: run.evaluatorProvenance,
      notes: (run.evaluationNotes ?? []).slice(0, 5),
      evidence: (run.evidence ?? []).slice(0, 5),
    }, null, 1));
  }
}
