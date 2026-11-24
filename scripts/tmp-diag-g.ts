import { resolve } from 'node:path';
import { listSkillEvaluationRuns } from '../backend/src/kory/skill-evaluations';
const projectRoot = resolve(import.meta.dir, '..');
const skill = process.argv[2]!;
const ids = process.argv.slice(3);
for (const r of listSkillEvaluationRuns(projectRoot, skill)) {
  if (ids.some((id) => r.id.includes(id)))
    console.log(
      r.id,
      '| rev',
      r.revisionHash.slice(0, 12),
      '| mat',
      r.materializerId,
      '| sc',
      r.deterministicScorerId,
      '|',
      r.recordedAt,
    );
}
