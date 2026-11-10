import { resolve } from 'node:path';
import { listSkillEvaluationRuns } from '../backend/src/kory/skill-evaluations';
const projectRoot = resolve(import.meta.dir, '..');
const skill = process.argv[2]!; const id = process.argv[3]!;
const run = listSkillEvaluationRuns(projectRoot, skill).find(r=>r.id===id)!;
console.log(JSON.stringify({id:run.id, artifacts:run.artifacts}, null, 1));
