import { resolve } from 'node:path';
import { evaluateSkillPromotion } from '../backend/src/kory/skill-evaluations';
import { listSkills } from '../backend/src/kory/skills';
const projectRoot = resolve(import.meta.dir, '..');
const group = ['backend-engineering','http-rest-engineering','graphql-engineering','grpc-protobuf','api-contract-design','in-process-backend','local-service-backend','network-service-backend','distributed-backend','event-driven-architecture','realtime-systems','stream-processing','webhook-integration','payment-integration'];
const revisions = new Map(listSkills(projectRoot).filter(s=>s.state==='active'&&s.validation.valid).map(s=>[s.name,s]));
for (const s of group) {
  const g = evaluateSkillPromotion(projectRoot, s, revisions.get(s)!.hash);
  console.log(`${s}\n  status=${g.status} pass=${g.passRate?.toFixed(3)} ver=${g.verification?.toFixed(3)} qual=${g.quality?.toFixed(3)} delta(pass/qual/ver)=${g.skillBaselinePassRateDelta?.toFixed(3)}/${g.skillBaselineQualityDelta?.toFixed(3)}/${g.skillBaselineVerificationDelta?.toFixed(3)} cases=${g.pairedBaselineCases} blind=${g.provenancedBlindReviews} openRegr=${g.openRegressions}\n  reasons: ${g.reasons.join(' | ')}`);
}
