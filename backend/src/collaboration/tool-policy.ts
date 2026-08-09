export interface CollaborationToolPolicy {
  commandAllowlist: string[];
  commandBlocklist: string[];
}

const activePolicies = new Map<string, CollaborationToolPolicy>();

export function setCollaborationToolPolicy(sessionId: string, policy: CollaborationToolPolicy) {
  activePolicies.set(sessionId, policy);
}

export function getCollaborationToolPolicy(sessionId: string) {
  return activePolicies.get(sessionId);
}

export function clearCollaborationToolPolicy(sessionId: string) {
  activePolicies.delete(sessionId);
}
