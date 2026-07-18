// Remote provider sharing ("host models").
//
// A HOST machine advertises a catalog of its providers over the relay; a CLIENT
// machine consumes them as ordinary providers, running its OWN agent loop and
// filesystem locally — only the model inference is served by the host. This is
// distinct from team collaboration (where a guest joins the host's session):
// here the client keeps its own workspace and the host is a pure inference
// backend.
//
// The transport reuses the existing relay/WebRTC channel. These are the message
// shapes and catalog types that flow over it.

// ─── How safe is it to share a given provider with another person? ───────────
//
// Sharing a *subscription-backed* provider is account-sharing, which several
// providers' ToS explicitly forbid and enforce (Anthropic, Google, GitHub).
// Sharing a provider the host authenticates with its own *API key* is far
// safer — the host just pays for the client's usage. The UI uses this to gate.

export type ProviderShareRisk = 'ok' | 'caution' | 'prohibited';

export interface ProviderShareClassification {
  risk: ProviderShareRisk;
  /** One-line, user-facing reason shown next to the share toggle. */
  reason: string;
}

/** Per-provider share-risk verdicts, grounded in each provider's ToS.
 *  Keyed by Koryphaios provider name. Unknown providers default to 'caution'. */
export const PROVIDER_SHARE_RISK: Record<string, ProviderShareClassification> = {
  // API-key providers the host pays for directly — safe to share (host funds usage).
  openai: { risk: 'ok', reason: 'Your API key — you pay for their usage.' },
  anthropic: { risk: 'ok', reason: 'Your API key — you pay for their usage.' },
  google: { risk: 'ok', reason: 'Your Gemini API key — you pay for their usage.' },
  aistudio: { risk: 'ok', reason: 'Your AI Studio API key — you pay for their usage.' },
  xai: { risk: 'ok', reason: 'Your xAI API key — you pay for their usage.' },
  groq: { risk: 'ok', reason: 'Your Groq API key — you pay for their usage.' },
  openrouter: { risk: 'ok', reason: 'Your OpenRouter key — you pay for their usage.' },
  mistral: { risk: 'ok', reason: 'Your API key — you pay for their usage.' },
  azure: { risk: 'ok', reason: 'Your Azure deployment — you pay for their usage.' },
  bedrock: { risk: 'ok', reason: 'Your AWS Bedrock account — you pay for their usage.' },
  vertexai: { risk: 'ok', reason: 'Your Vertex AI project — you pay for their usage.' },
  local: { risk: 'ok', reason: 'Your local endpoint — nothing metered.' },
  ollama: { risk: 'ok', reason: 'Your local Ollama — nothing metered.' },
  lmstudio: { risk: 'ok', reason: 'Your local LM Studio — nothing metered.' },
  llamacpp: { risk: 'ok', reason: 'Your local llama.cpp — nothing metered.' },

  // Subscription-backed — sharing is account-sharing the provider's ToS forbids.
  claude: {
    risk: 'prohibited',
    reason:
      "Sharing a Claude subscription violates Anthropic's terms (account sharing) — they enforce this.",
  },
  codex: {
    risk: 'caution',
    reason:
      'Sharing a ChatGPT subscription is a gray area OpenAI currently tolerates; use at your own risk.',
  },
  copilot: {
    risk: 'prohibited',
    reason: "Sharing Copilot violates GitHub's terms; proxy usage is a bannable offense.",
  },
  grok: {
    risk: 'caution',
    reason:
      "Sharing a Grok subscription likely breaches xAI's terms; a metered API key is the safe path.",
  },
  kimicode: {
    risk: 'caution',
    reason: 'Sharing a Kimi Code subscription is risky; a Console-issued API key is safer.',
  },
  cursor: {
    risk: 'caution',
    reason: "Sharing a Cursor subscription likely breaches Cursor's terms.",
  },
  devin: {
    risk: 'caution',
    reason: "Sharing a Devin subscription likely breaches Cognition's terms.",
  },
  antigravity: {
    risk: 'caution',
    reason: 'Sharing a Google/Antigravity subscription is risky; a metered API key is safer.',
  },
  cline: {
    risk: 'ok',
    reason: 'Cline is BYO-key and open source — nothing subscription-bound to share.',
  },
};

export function classifyProviderShare(providerName: string): ProviderShareClassification {
  return (
    PROVIDER_SHARE_RISK[providerName] ?? {
      risk: 'caution',
      reason: 'Unknown provider — verify the terms before sharing.',
    }
  );
}

// ─── Catalog the host advertises ─────────────────────────────────────────────

export interface SharedProviderModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  canReason?: boolean;
  reasoningLevels?: string[];
}

export interface SharedProviderEntry {
  /** Koryphaios provider name on the host (e.g. "google", "codex"). */
  provider: string;
  /** Human label for the picker ("Google", "OpenAI Codex"). */
  label: string;
  models: SharedProviderModel[];
  /** True for CLI-harness providers: they run tools on the HOST's filesystem,
   *  so they are offered in "remote-agentic" mode, not pure inference. */
  agentic: boolean;
  risk: ProviderShareRisk;
}

export interface SharedProviderCatalog {
  /** Display name of the host machine ("Micah's PC"). */
  hostName: string;
  providers: SharedProviderEntry[];
}

// ─── Remote-inference RPC messages (over the relay/WebRTC channel) ───────────

/** One project file synced to the host's sandbox for an agentic-remote turn. */
export interface ProjectSyncFile {
  /** POSIX-relative path within the project root. */
  path: string;
  content: string;
}

/** Project delta shipped to the host so a CLI harness can read/edit the
 *  client's files in a host-side temp sandbox. `full` sends the whole
 *  (filtered) project; `delta` sends only files changed since the last turn. */
export interface ProjectSync {
  mode: 'full' | 'delta';
  files: ProjectSyncFile[];
  /** Relative paths deleted since the last sync (delta mode). */
  deletes: string[];
}

/** A serializable StreamRequest — the AbortSignal is dropped in transit and
 *  reconstructed host-side; cancellation flows via a separate cancel message. */
export interface RemoteInferenceRequestPayload {
  model: string;
  provider: string;
  messages: unknown[];
  systemPrompt: string;
  tools?: unknown[];
  maxTokens?: number;
  temperature?: number;
  reasoningLevel?: string;
  /** CLIENT's working directory — passed through for agentic-remote turns only;
   *  ignored for pure-inference providers (the client runs its own tools). */
  workingDirectory?: string;
  /** True for CLI-harness providers run in the host's temp sandbox. */
  agentic?: boolean;
  /** Project files shipped to the host sandbox (agentic turns only). */
  projectSync?: ProjectSync;
}

export interface RemoteInferenceRequestMessage {
  type: 'inference-request';
  requestId: string;
  payload: RemoteInferenceRequestPayload;
}

export interface RemoteInferenceCancelMessage {
  type: 'inference-cancel';
  requestId: string;
}

/** One ProviderEvent, forwarded from host to the requesting client. `event` is
 *  a ProviderEvent (kept as unknown here so shared doesn't depend on backend). */
export interface RemoteInferenceEventMessage {
  type: 'inference-event';
  requestId: string;
  event: unknown;
}

export interface RemoteInferenceDoneMessage {
  type: 'inference-done';
  requestId: string;
}

export interface RemoteInferenceErrorMessage {
  type: 'inference-error';
  requestId: string;
  error: string;
}

export interface ProviderCatalogMessage {
  type: 'provider-catalog';
  catalog: SharedProviderCatalog;
}

export type RemoteProviderMessage =
  | RemoteInferenceRequestMessage
  | RemoteInferenceCancelMessage
  | RemoteInferenceEventMessage
  | RemoteInferenceDoneMessage
  | RemoteInferenceErrorMessage
  | ProviderCatalogMessage;
