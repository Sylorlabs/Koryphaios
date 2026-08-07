import type { ProviderName } from '@koryphaios/shared';

export interface CliResearchBoundary {
  eligible: boolean;
  nativeTools: readonly string[];
  reason: string;
}

/** A native research answer is usable only when it carries an inspectable source URL. */
export function hasResearchCitation(output: string): boolean {
  return /https?:\/\/[^\s<>()\[\]{}]+/i.test(output);
}

/**
 * Deny-by-default registry for subscription-backed native research.
 *
 * A provider is eligible only when its CLI has a machine-enforced tool
 * visibility allowlist. A prompt, plan mode, temporary cwd, or read-only
 * workspace is not sufficient: an unknown future native tool would otherwise
 * become a capability escape hatch.
 */
export function cliResearchBoundary(provider: ProviderName | string): CliResearchBoundary {
  switch (provider) {
    case 'grok':
      return {
        eligible: true,
        nativeTools: ['web_search', 'web_fetch'],
        reason: 'grok --tools exposes an exact built-in tool allowlist',
      };
    case 'claude':
      return {
        eligible: true,
        nativeTools: ['WebSearch', 'WebFetch'],
        reason: 'claude --tools exposes an exact built-in tool allowlist',
      };
    case 'devin':
      return {
        eligible: true,
        nativeTools: ['WebSearch', 'WebFetch', 'Browser'],
        reason: 'Devin strict agent-config controls tool visibility and permission scopes',
      };
    case 'codex':
      return {
        eligible: false,
        nativeTools: ['web_search'],
        reason: 'Codex --search enables web search but does not disable its other native tools',
      };
    case 'antigravity':
      return {
        eligible: false,
        nativeTools: [],
        reason: 'Antigravity exposes no exact native tool visibility allowlist',
      };
    case 'cursor':
      return {
        eligible: false,
        nativeTools: [],
        reason: 'Cursor exposes no exact native tool visibility allowlist',
      };
    case 'cline':
      return {
        eligible: false,
        nativeTools: [],
        reason: 'Cline exposes no exact native tool visibility allowlist',
      };
    default:
      return {
        eligible: false,
        nativeTools: [],
        reason: 'Provider has no verified native research boundary',
      };
  }
}
