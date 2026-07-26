import type { ProviderName } from '@koryphaios/shared';
import { createHash } from 'node:crypto';
import { sandboxCapabilities } from '../collaboration/sandbox-runner';

export type HarnessRole = 'manager' | 'worker' | 'critic';

export interface ProviderHarnessCapabilities {
  version: 'provider-harness-v1';
  hash: string;
  provider: string;
  mode: 'managed' | 'native-passthrough';
  roles: HarnessRole[];
  hardRoleToolPolicy: boolean;
  filesystemIsolation: boolean;
  isolationMechanism: string;
  edit: boolean;
  shell: boolean;
  browser: boolean;
  verificationEligible: boolean;
  limitations: string[];
}

const NATIVE_PROVIDERS = new Set([
  'claude',
  'grok',
  'antigravity',
  'gemini-cli',
  'jules',
  'cursor',
  'devin',
  'cline',
]);

/** Runtime truth shared by prompt manifests, routing UI, and qualification evidence. */
export function getProviderHarnessCapabilities(
  provider: ProviderName | string,
): ProviderHarnessCapabilities {
  const native = NATIVE_PROVIDERS.has(provider);
  const isolation = sandboxCapabilities();
  const base = {
    version: 'provider-harness-v1' as const,
    provider: String(provider),
    mode: native ? ('native-passthrough' as const) : ('managed' as const),
    roles: ['manager', 'worker', 'critic'] as HarnessRole[],
    // Native adapters translate roles into CLI plan/read-only modes; managed
    // providers only receive Kory-owned role-filtered tool definitions.
    hardRoleToolPolicy: true,
    filesystemIsolation: native ? isolation.osIsolation : true,
    isolationMechanism: native ? isolation.mechanism : 'kory-tool-boundary',
    edit: true,
    shell: true,
    browser: false,
    verificationEligible: !native || isolation.osIsolation,
    limitations:
      native && !isolation.osIsolation
        ? ['OS filesystem isolation is unavailable; execution must be labeled unverified.']
        : [],
  };
  return {
    ...base,
    hash: createHash('sha256').update(JSON.stringify(base)).digest('hex'),
  };
}
