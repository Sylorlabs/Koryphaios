import type { ProviderName } from '@koryphaios/shared';
import { createHash } from 'node:crypto';
import { sandboxCapabilities } from '../collaboration/sandbox-runner';
import { getFreebuffRuntimeStatus } from './freebuff-runtime';

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
  'codex',
  'claude',
  'grok',
  'antigravity',
  'gemini-cli',
  'jules',
  'cursor',
  'devin',
  'kimicode',
]);

// These harnesses cannot invoke arbitrary Kory control-plane tools. Codebuff's
// supported filesystem/command overrides still use the Kory boundary, but SDK
// 0.10.7 cannot extend the pinned store agent's toolNames with Notes/delegation.
// Do not advertise a custom-tool option as a working bridge.
const PROVIDERS_WITHOUT_KORY_TOOL_BRIDGE = new Set(['gemini-cli', 'codebuff']);

export function supportsKoryControlPlaneTools(provider: ProviderName | string): boolean {
  return !PROVIDERS_WITHOUT_KORY_TOOL_BRIDGE.has(String(provider));
}

/** Runtime truth shared by prompt manifests, routing UI, and qualification evidence. */
export function getProviderHarnessCapabilities(
  provider: ProviderName | string,
): ProviderHarnessCapabilities {
  const freebuff = provider === 'freebuff' ? getFreebuffRuntimeStatus() : undefined;
  const native = NATIVE_PROVIDERS.has(provider) || !!freebuff;
  const isolation = freebuff
    ? {
        osIsolation: freebuff.available,
        mechanism: freebuff.available
          ? `${freebuff.kind}-linux-bubblewrap-disposable`
          : 'unverified-freebuff-runtime',
      }
    : sandboxCapabilities();
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
    limitations: [
      ...(native && !isolation.osIsolation
        ? ['OS filesystem isolation is unavailable; execution must be labeled unverified.']
        : []),
      ...(freebuff
        ? [
            'Native Freebuff tools remain enabled only inside a disposable Linux bubblewrap workspace; real workspace operations use authenticated Kory MCP tools.',
            ...(!freebuff.available
              ? [freebuff.reason ?? 'Freebuff isolation has not been verified.']
              : []),
          ]
        : []),
      ...(provider === 'codebuff'
        ? [
            'The pinned Codebuff store agent supports Kory filesystem/command overrides, not arbitrary Notes or delegation tools.',
          ]
        : []),
    ],
  };
  return {
    ...base,
    hash: createHash('sha256').update(JSON.stringify(base)).digest('hex'),
  };
}
