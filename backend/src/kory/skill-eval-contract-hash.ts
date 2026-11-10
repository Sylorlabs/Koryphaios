import { createHash } from 'node:crypto';
import type { V5FullTaskFixture } from './skill-packages';

export interface V5SkillEvaluationContract {
  contractVersion: number;
  skill: string;
  packageVersion: string;
  scenario: V5FullTaskFixture;
  materializerIds: readonly string[];
  scorerIds: readonly string[];
}

// Both qualification and blind review must bind to the same execution policy.
// A change here invalidates the relevant current public-web run pairs.
const PUBLIC_WEB_EXECUTION_NETWORK_POLICY = 'codex-public-web-https-v1';

export function skillEvaluationV5ContractHash(input: V5SkillEvaluationContract): string {
  const payload = {
    contractVersion: input.contractVersion,
    skill: input.skill,
    packageVersion: input.packageVersion,
    scenario: input.scenario,
    materializerIds: [...input.materializerIds].sort(),
    scorerIds: [...input.scorerIds].sort(),
    ...(input.scenario.environment.kind === 'public-web'
      ? { executionNetworkPolicy: PUBLIC_WEB_EXECUTION_NETWORK_POLICY }
      : {}),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}
