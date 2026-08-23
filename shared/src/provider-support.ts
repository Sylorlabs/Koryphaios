import type { ProviderName } from './providers/ProviderNames';

export type ProviderSupportTier = 'certified' | 'compatible' | 'preview' | 'unavailable';

export type ProviderCapabilityKind =
  | 'chat'
  | 'coding-agent'
  | 'local-runtime'
  | 'gateway'
  | 'image'
  | 'audio'
  | 'embedding'
  | 'memory'
  | 'async-agent';

export type ProviderEvidenceKind =
  | 'live-release-matrix'
  | 'provider-specific-contract'
  | 'openai-compatible-contract'
  | 'cli-contract'
  | 'explicitly-blocked';

export interface ProviderSupportRecord {
  tier: ProviderSupportTier;
  capabilities: ProviderCapabilityKind[];
  evidence: ProviderEvidenceKind;
  /** User-facing explanation of what the tier proves and does not prove. */
  note: string;
  /** Upstream CLI/API version last reflected in the adapter, when versioned. */
  testedUpstreamVersion?: string;
}

const compatible = (
  capabilities: ProviderCapabilityKind[],
  evidence: ProviderEvidenceKind,
  note = 'The adapter has provider-specific or protocol-level contract coverage. A local verification still does not prove account entitlement, quota, or model access.',
): ProviderSupportRecord => ({ tier: 'compatible', capabilities, evidence, note });

const preview = (
  capabilities: ProviderCapabilityKind[],
  evidence: ProviderEvidenceKind,
  note: string,
  testedUpstreamVersion?: string,
): ProviderSupportRecord => ({
  tier: 'preview',
  capabilities,
  evidence,
  note,
  ...(testedUpstreamVersion && { testedUpstreamVersion }),
});

const unavailable = (
  capabilities: ProviderCapabilityKind[],
  note: string,
): ProviderSupportRecord => ({
  tier: 'unavailable',
  capabilities,
  evidence: 'explicitly-blocked',
  note,
});

/**
 * Release support truth. Connection state is deliberately separate: a
 * provider may verify successfully on one machine while remaining Preview for
 * the release because its moving CLI/API surface has not passed the complete
 * cross-platform live matrix. Nothing becomes Certified implicitly.
 */
export const PROVIDER_SUPPORT: Readonly<Record<string, ProviderSupportRecord>> = {
  anthropic: compatible(['chat'], 'provider-specific-contract'),
  openai: compatible(['chat', 'image', 'audio'], 'provider-specific-contract'),
  google: compatible(['chat'], 'provider-specific-contract'),
  aistudio: compatible(['chat'], 'provider-specific-contract'),
  xai: compatible(['chat'], 'openai-compatible-contract'),
  openrouter: compatible(['chat', 'gateway'], 'openai-compatible-contract'),
  tokenrouter: compatible(['chat', 'gateway'], 'openai-compatible-contract'),
  groq: compatible(['chat'], 'openai-compatible-contract'),
  digitalocean: compatible(['chat'], 'openai-compatible-contract'),
  copilot: compatible(['chat'], 'provider-specific-contract'),
  azure: compatible(['chat'], 'provider-specific-contract'),
  azurecognitive: compatible(['chat'], 'provider-specific-contract'),
  bedrock: compatible(['chat'], 'provider-specific-contract'),
  vertexai: compatible(['chat'], 'provider-specific-contract'),
  sapai: compatible(['chat'], 'provider-specific-contract'),
  'github-models': compatible(['chat'], 'provider-specific-contract'),
  local: compatible(['chat', 'local-runtime'], 'openai-compatible-contract'),
  ollama: compatible(['chat', 'local-runtime'], 'provider-specific-contract'),
  lmstudio: compatible(['chat', 'local-runtime'], 'openai-compatible-contract'),
  llamacpp: compatible(['chat', 'local-runtime'], 'openai-compatible-contract'),
  kimicode: compatible(['chat', 'coding-agent'], 'provider-specific-contract'),
  opencodego: compatible(['chat', 'gateway'], 'provider-specific-contract'),

  claude: preview(
    ['chat', 'coding-agent'],
    'cli-contract',
    'Claude Code is a moving external CLI. Koryphaios verifies the installed CLI at runtime; release certification requires a live cross-platform harness matrix.',
  ),
  codex: preview(
    ['chat', 'coding-agent'],
    'cli-contract',
    'Codex CLI behavior depends on the installed CLI and account. Runtime verification is required.',
  ),
  'codex-auth': preview(
    ['chat', 'coding-agent'],
    'cli-contract',
    'The managed Codex app-server route is version-sensitive and remains Preview until its packaged live matrix passes.',
  ),
  cline: preview(
    ['chat', 'coding-agent'],
    'cli-contract',
    'The adapter supports current agent_event JSON envelopes and legacy say/ask streams, feature-detects CLI flags, and fails closed on unknown protocols. A real authenticated Cline run is still required before certification.',
    'current CLI contract as of 2026-08-22',
  ),
  cursor: preview(
    ['chat', 'coding-agent'],
    'cli-contract',
    'Cursor Agent is an external versioned CLI and requires runtime compatibility verification.',
  ),
  devin: preview(
    ['chat', 'coding-agent'],
    'cli-contract',
    'Devin CLI execution and trajectory export depend on the installed upstream version.',
  ),
  grok: preview(
    ['chat', 'coding-agent'],
    'cli-contract',
    'Grok Build is an external CLI harness and remains version-sensitive.',
  ),
  antigravity: preview(
    ['chat', 'coding-agent'],
    'cli-contract',
    'Antigravity is a moving CLI integration and requires a live installed-version check.',
  ),

  gitlab: unavailable(
    ['chat'],
    'GitLab Duo chat is intentionally unavailable because this build has no supported inference contract; no generic OpenAI fallback is used.',
  ),
  freebuff: unavailable(
    ['coding-agent'],
    'Freebuff setup material may be detected for diagnostics, but Koryphaios does not call an undocumented execution API.',
  ),
  jules: unavailable(
    ['async-agent'],
    'Jules mutation requires an approval-capable remote workflow that is not safely implemented in this release.',
  ),
  replicate: unavailable(['image'], 'Replicate requires a dedicated non-chat capability adapter.'),
  modal: unavailable(['async-agent'], 'Modal requires a dedicated non-chat capability adapter.'),
  luma: unavailable(['image'], 'Luma requires a dedicated image/video capability adapter.'),
  fal: unavailable(['image'], 'Fal requires a dedicated media capability adapter.'),
  elevenlabs: unavailable(['audio'], 'ElevenLabs belongs in the dedicated audio capability route.'),
  deepgram: unavailable(['audio'], 'Deepgram belongs in the dedicated transcription route.'),
  gladia: unavailable(['audio'], 'Gladia belongs in the dedicated transcription route.'),
  assemblyai: unavailable(['audio'], 'AssemblyAI belongs in the dedicated transcription route.'),
  lmnt: unavailable(['audio'], 'LMNT belongs in the dedicated speech route.'),
  voyageai: unavailable(['embedding'], 'Voyage AI belongs in the dedicated embeddings route.'),
  mixedbread: unavailable(['embedding'], 'Mixedbread belongs in the dedicated embeddings route.'),
  mem0: unavailable(['memory'], 'Mem0 belongs in a dedicated memory adapter.'),
  letta: unavailable(['memory'], 'Letta belongs in a dedicated memory/agent adapter.'),
  blackforestlabs: unavailable(['image'], 'Black Forest Labs belongs in the dedicated image route.'),
  klingai: unavailable(['image'], 'Kling belongs in a dedicated image/video route.'),
  prodia: unavailable(['image'], 'Prodia belongs in the dedicated image route.'),
};

const FALLBACK_SUPPORT: ProviderSupportRecord = Object.freeze({
  tier: 'compatible',
  capabilities: ['chat'] as ProviderCapabilityKind[],
  evidence: 'openai-compatible-contract',
  note: 'This provider uses the shared OpenAI-compatible contract. The provider itself has not completed Koryphaios live release certification.',
});

export function providerSupport(name: ProviderName | string): ProviderSupportRecord {
  return PROVIDER_SUPPORT[String(name)] ?? FALLBACK_SUPPORT;
}

export function isProviderCertified(name: ProviderName | string): boolean {
  return providerSupport(name).tier === 'certified';
}

export function isProviderRunnableByTier(name: ProviderName | string): boolean {
  return providerSupport(name).tier !== 'unavailable';
}
