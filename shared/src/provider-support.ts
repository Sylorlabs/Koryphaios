import type { ProviderName } from './providers/ProviderNames';

export type ProviderSupportTier = 'certified' | 'compatible' | 'preview' | 'unavailable';

export type ProviderCapabilityKind =
  | 'chat'
  | 'coding-agent'
  | 'local-runtime'
  | 'gateway'
  | 'image'
  | 'video'
  | 'audio'
  | 'embedding'
  | 'rerank'
  | 'memory'
  | 'async-agent';

export type ProviderEvidenceKind =
  | 'live-release-matrix'
  | 'provider-specific-contract'
  | 'openai-compatible-contract'
  | 'cli-contract'
  | 'capability-adapter-contract'
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
 * A provider reached through a dedicated non-chat capability adapter (image,
 * video, audio, embedding, rerank, memory). Tier is Preview until the adapter
 * has passed a live release matrix; the adapter being present never implies
 * account entitlement, quota, or that a given model is available to the user.
 */
const capabilityAdapter = (
  capabilities: ProviderCapabilityKind[],
  note: string,
  testedUpstreamVersion?: string,
): ProviderSupportRecord => ({
  tier: 'preview',
  capabilities,
  evidence: 'capability-adapter-contract',
  note,
  ...(testedUpstreamVersion && { testedUpstreamVersion }),
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
  unorouter: compatible(['chat', 'gateway'], 'openai-compatible-contract'),
  tokenrouter: compatible(['chat', 'gateway'], 'openai-compatible-contract'),
  experientiallabs: compatible(['chat', 'gateway'], 'openai-compatible-contract'),
  groq: compatible(['chat'], 'openai-compatible-contract'),
  digitalocean: compatible(['chat'], 'openai-compatible-contract'),
  commandcode: compatible(['chat', 'gateway'], 'openai-compatible-contract'),
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
  chatbase: compatible(['chat'], 'provider-specific-contract'),
  notion: compatible(['chat'], 'provider-specific-contract'),

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
    ['chat', 'gateway'],
    'openai-compatible-contract',
    'Cline\u2019s hosted API is an OpenAI-compatible Chat Completions surface reached directly with a Cline API key (no CLI subprocess). Model ids, context windows, output limits, pricing, input modalities and supported parameters are read from Cline\u2019s live catalog; per-model reasoning ladders come from Cline\u2019s published catalog because the API reports only whether reasoning is accepted, never which values are legal. Live-verified against api.cline.bot: streaming content, tool calling, `delta.reasoning` (OpenRouter shape) alongside `delta.reasoning_content`, and usage that arrives on the same chunk as finish_reason with `completion_tokens_details.reasoning_tokens`. Only zero-priced models were executed, because the verification key had no credit, so a paid-model turn is not yet attested.',
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
    'Antigravity is a moving CLI integration and requires a live installed-version check. ' +
      'Tool authority is enforced through the agy permission engine (settings.json permissions + toolPermission): ' +
      'native shell, writes, and web are denied, and host effects are reachable only through the authenticated ' +
      'kory__ MCP bridge. Note that agy ignores --mode in headless runs, so no CLI flag carries Koryphaios\' ' +
      'permission mode.',
  ),

  gitlab: preview(
    ['chat'],
    'provider-specific-contract',
    'Sends the real Duo chat request shape (POST /api/v4/chat/completions, `{ content, additional_context }`, PAT Bearer) and parses the single bare-string answer. Access is instance-gated — gitlab.com restricts this endpoint to GitLab team members and self-managed needs access_rest_chat — so credential scope, flag state, and Duo entitlement are only proven by a live request.',
    'access_rest_chat contract as of 2026-09-27',
  ),
  freebuff: preview(
    ['chat', 'coding-agent'],
    'cli-contract',
    'Runs the real Freebuff 0.0.162 TUI through a tmux PTY. A mandatory OS sandbox confines native Freebuff tools to a disposable checkout; authoritative project actions use the authenticated Kory MCP bridge.',
    '0.0.162',
  ),
  codebuff: preview(
    ['chat', 'coding-agent'],
    'provider-specific-contract',
    'Uses the official @codebuff/sdk with a user-owned Codebuff API key and the documented codebuff/base@0.0.16 agent. Supported filesystem and command tools are overridden through Kory ToolRegistry; SDK-local artifacts stay disposable and live account verification is still required.',
    '@codebuff/sdk 0.10.7',
  ),
  jules: unavailable(
    ['async-agent'],
    'Jules mutation requires an approval-capable remote workflow that is not safely implemented in this release.',
  ),
  hoplite: unavailable(
    ['async-agent'],
    'Hoplite runs tasks in Hoplite cloud sandboxes or on a local Codex/Claude agent and opens PRs; live delegation requires an approval-capable remote workflow that is not safely implemented in this release.',
  ),
  replicate: capabilityAdapter(
    ['image', 'video', 'audio', 'embedding'],
    'Replicate runs model predictions through its own asynchronous predictions API. Image, video, audio, and embedding models are available through the dedicated capability routes; Replicate exposes no chat-completions contract, so it never appears in the chat provider picker.',
  ),
  modal: unavailable(['async-agent'], 'Modal requires a dedicated non-chat capability adapter.'),
  luma: capabilityAdapter(
    ['video', 'image'],
    'Luma Dream Machine generates video and image through an asynchronous generation API whose jobs are polled until completed or failed. It is available in the Video and Image studios and never as a chat provider.',
  ),
  fal: unavailable(['image'], 'Fal requires a dedicated media capability adapter.'),
  elevenlabs: unavailable(['audio'], 'ElevenLabs belongs in the dedicated audio capability route.'),
  deepgram: preview(
    ['audio'],
    'provider-specific-contract',
    'Deepgram prerecorded transcription is available through the dedicated voice route.',
  ),
  gladia: unavailable(['audio'], 'Gladia belongs in the dedicated transcription route.'),
  assemblyai: preview(
    ['audio'],
    'provider-specific-contract',
    'AssemblyAI upload and asynchronous transcription are available through the dedicated voice route.',
  ),
  lmnt: capabilityAdapter(
    ['audio'],
    'LMNT speech synthesis is available through the dedicated voice route using its own X-API-Key contract and native voice catalog. LMNT publishes no chat-completions endpoint.',
  ),
  voyageai: capabilityAdapter(
    ['embedding', 'rerank'],
    'Voyage AI embeddings and rerankers back semantic retrieval and can be selected as the semantic-memory embedding provider. Voyage publishes no chat, image, or video endpoint.',
  ),
  mixedbread: unavailable(['embedding'], 'Mixedbread belongs in the dedicated embeddings route.'),
  mem0: capabilityAdapter(
    ['memory'],
    'Mem0 adds, searches, and deletes managed long-term memories through its platform memory API. It is an optional external memory store alongside local memory, not a chat provider.',
  ),
  letta: capabilityAdapter(
    ['memory'],
    'Letta memory blocks and archival passages are available as an external stateful memory store. It is an optional memory backend alongside local memory, not a chat provider.',
  ),
  blackforestlabs: unavailable(
    ['image'],
    'Black Forest Labs belongs in the dedicated image route.',
  ),
  klingai: capabilityAdapter(
    ['video', 'image'],
    'Kling AI text-to-video and image-to-video tasks are submitted to its asynchronous task API and polled to completion. It is available in the Video and Image studios and never as a chat provider.',
  ),
  prodia: capabilityAdapter(
    ['image', 'video'],
    'Prodia inference jobs are submitted through the unified job endpoint and polled to completion. It is available in the Image and Video studios and never as a chat provider.',
  ),
};

const FALLBACK_SUPPORT: ProviderSupportRecord = Object.freeze({
  tier: 'preview',
  capabilities: ['chat'] as ProviderCapabilityKind[],
  evidence: 'openai-compatible-contract',
  note: 'This provider has no explicit Koryphaios release-support record. Catalog presence alone is not a compatibility promise; verify the endpoint locally before use.',
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

/**
 * True when the provider is reached through a dedicated non-chat capability
 * adapter rather than the chat provider path. These providers verify and
 * configure normally; they are simply absent from the chat picker.
 */
export function isProviderCapabilityOnly(name: ProviderName | string): boolean {
  return providerSupport(name).evidence === 'capability-adapter-contract';
}

/**
 * Capability kinds reachable through a dedicated adapter. Returns an empty list
 * for chat providers so callers can distinguish "no dedicated adapter" from
 * "adapter exists but exposes none of the requested capabilities".
 */
export function providerCapabilityKinds(name: ProviderName | string): ProviderCapabilityKind[] {
  const record = providerSupport(name);
  return record.evidence === 'capability-adapter-contract' ? record.capabilities : [];
}

/** Every provider that can serve at least one capability outside the chat path. */
export function capabilityAdapterProviders(): string[] {
  return Object.keys(PROVIDER_SUPPORT).filter((name) => isProviderCapabilityOnly(name));
}
