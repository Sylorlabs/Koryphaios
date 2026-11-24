import { resolve } from 'node:path';
import { listOpenSkillRegressionSources } from '../backend/src/kory/skill-evaluations';
import { listSkills } from '../backend/src/kory/skills';
const projectRoot = resolve(import.meta.dir, '..');
const group = [
  'backend-engineering',
  'http-rest-engineering',
  'graphql-engineering',
  'grpc-protobuf',
  'api-contract-design',
  'in-process-backend',
  'local-service-backend',
  'network-service-backend',
  'distributed-backend',
  'event-driven-architecture',
  'realtime-systems',
  'stream-processing',
  'webhook-integration',
  'payment-integration',
];
const revisions = new Map(
  listSkills(projectRoot)
    .filter((s) => s.state === 'active' && s.validation.valid)
    .map((s) => [s.name, s]),
);
for (const skill of group) {
  for (const r of listOpenSkillRegressionSources(projectRoot, skill, revisions.get(skill)!.hash)) {
    console.log(
      `\n### ${skill} | ${r.scenarioId} | ${r.recordedAt} | q=${r.quality} v=${r.verification} | model=${r.model}`,
    );
    const ev = r.evidence || [];
    for (const e of ev) {
      const lines = e
        .split('\n')
        .filter((l) => /fail|Fail|error|Error|Expected|Received|not |missing/.test(l))
        .slice(0, 6);
      if (lines.length) console.log('  ' + lines.join('\n  ').slice(0, 900));
    }
  }
}
