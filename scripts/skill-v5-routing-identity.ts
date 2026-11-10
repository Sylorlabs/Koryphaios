import { randomUUID } from 'node:crypto';

/** A rerun is a new observation, never a replacement for a historical result. */
export function routingComparisonId(
  skill: string,
  caseId: string,
  revisionHash: string,
  campaignId: string,
): string {
  return `v5-routing@1:${skill}:${caseId}:${revisionHash}:${campaignId}`;
}

export const newRoutingCampaignId = (): string => randomUUID();
