import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
function projectKey(root: string): string {
  try {
    return realpathSync(resolve(root));
  } catch {
    return resolve(root);
  }
}
import type { ComputerUseSettings } from '@koryphaios/shared';

// Workspace configuration is agent-writable, so it is NEVER the authority for
// desktop grants. A human settings save must admit the exact policy this boot.
// Backend restart requires explicit re-enablement. This is not a boundary
// against processes with unrestricted access to backend credentials/memory.
const grants = new Map<string, string>();
let revision = randomUUID();
export function computerAuthorityRevision(): string {
  return revision;
}
export function admitComputerPolicy(root: string, policy: ComputerUseSettings): void {
  grants.set(projectKey(root), JSON.stringify(policy));
  revision = randomUUID();
}
export function revokeComputerAuthority(): void {
  grants.clear();
  revision = randomUUID();
}
export function effectiveComputerPolicy(
  root: string,
  policy: ComputerUseSettings,
): ComputerUseSettings {
  if (!policy.enabled || grants.get(projectKey(root)) === JSON.stringify(policy)) return policy;
  return { ...policy, enabled: false };
}
