import { resolve } from 'node:path';
import {
  evaluateSkillPromotion,
  listOpenSkillRegressionSources,
} from '../backend/src/kory/skill-evaluations';
import { loadV5SkillPackages } from '../backend/src/kory/skill-packages';
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
const out: any = {};
for (const skill of group) {
  const rev = revisions.get(skill)!;
  const gate = evaluateSkillPromotion(projectRoot, skill, rev.hash);
  const open = listOpenSkillRegressionSources(projectRoot, skill, rev.hash);
  out[skill] = {
    revision: rev.hash,
    openRegressions: gate.openRegressions,
    reasons: gate.reasons,
    sources: open.map((r) => ({
      id: r.id,
      scenarioId: r.scenarioId,
      recordedAt: r.recordedAt,
      provider: r.provider,
      model: r.model,
      harnessVersion: r.harnessVersion?.slice(0, 60),
      passed: r.passed,
      quality: r.quality,
      verification: r.verification,
      materializerId: r.materializerId,
      scorerId: r.deterministicScorerId,
      contractVersion: r.evaluationContractVersion,
      contractHash: r.evaluationContractHash,
      revisionHash: r.revisionHash,
      variant: r.variant,
      role: r.role,
    })),
  };
}
console.log(JSON.stringify(out, null, 1));
