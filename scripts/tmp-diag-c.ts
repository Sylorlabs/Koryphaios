import { resolve } from 'node:path';
import { listOpenSkillRegressionSources } from '../backend/src/kory/skill-evaluations';
import { loadV5SkillPackages } from '../backend/src/kory/skill-packages';
import { BUILTIN_SKILL_EVAL_MATERIALIZERS, BUILTIN_SKILL_EVAL_SCORERS } from '../backend/src/eval/skills/skill-eval-fixtures';
import { listSkills } from '../backend/src/kory/skills';
import { skillEvaluationV5ContractHash } from '../backend/src/eval/skills/skill-eval-contract-hash';
import { CURRENT_SKILL_EVAL_CONTRACT_VERSION } from '../backend/src/kory/skill-evaluations';

const projectRoot = resolve(import.meta.dir, '..');
const group = ['backend-engineering','http-rest-engineering','graphql-engineering','grpc-protobuf','api-contract-design','in-process-backend','local-service-backend','network-service-backend','distributed-backend','event-driven-architecture','realtime-systems','stream-processing','webhook-integration','payment-integration'];
const pkgs = loadV5SkillPackages(resolve(projectRoot, 'skills-v5')).packages;
const revisions = new Map(listSkills(projectRoot).filter(s=>s.state==='active'&&s.validation.valid).map(s=>[s.name,s]));
for (const skill of group) {
  const p = pkgs.find(x=>x.sidecar.name===skill)!;
  const rev = revisions.get(skill)!;
  console.log(`\n## ${skill} rev=${rev.hash.slice(0,12)}`);
  for (const task of p.evaluation.tasks) {
    const scenario:any = { id: task.id, skill, category:'full-task', prompt: task.prompt, expectedSelection:true, expectedSkills:[], forbiddenSkills:[], heldOut:true, adjacentSkills:[], tags:['held-out','full-task'], environment:task.environment, falsifiableChecks:task.falsifiableChecks, scorers:task.scorers, requiredEvidence:task.requiredEvidence, requiredArtifacts:task.requiredArtifacts };
    const mats = BUILTIN_SKILL_EVAL_MATERIALIZERS.filter(m=>m.matches(scenario)).map(m=>m.id);
    const scos = BUILTIN_SKILL_EVAL_SCORERS.filter(s=>s.scenarioIds.includes(task.id)).map(s=>s.id);
    const hash = skillEvaluationV5ContractHash({contractVersion: CURRENT_SKILL_EVAL_CONTRACT_VERSION, skill, packageVersion: p.sidecar.version, scenario: task, materializerIds: mats.slice().sort(), scorerIds: scos.slice().sort()});
    console.log(`  ${task.id}: mats=${mats.join(',') || 'NONE'} scorers=${scos.join(',') || 'NONE'} hash=${hash.slice(0,16)}`);
  }
  const open = listOpenSkillRegressionSources(projectRoot, skill, rev.hash);
  for (const r of open) console.log(`   OPEN ${r.scenarioId} mat=${r.materializerId} sc=${r.deterministicScorerId} hash=${r.evaluationContractHash?.slice(0,16)} failed@${r.recordedAt}`);
}
