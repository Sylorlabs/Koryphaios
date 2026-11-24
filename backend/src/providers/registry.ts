// Clean Provider Registry - Only real providers with proper circuit breaker

import { createHash } from 'node:crypto';
import type {
  ModelDef,
  ProviderAuthMode,
  ProviderConfig,
  ProviderName,
  KoryphaiosConfig,
} from '@koryphaios/shared';

/** Filter each catalog entry's user-tunable `parameters` down to the keys the
 * provider's adapter actually forwards. A provider without a forwarding set
 * (CLI harnesses, inert adapters) gets everything stripped, so the composer
 * only ever sees settings that would reach the wire. */
export function gateModelParametersToForwarded(
  provider: Provider | undefined,
  models: ModelDef[],
): ModelDef[] {
  const forwarded = provider?.forwardedModelParameters?.();
  return models.map((model) => {
    if (!model.parameters?.length) return model;
    const filtered = forwarded ? model.parameters.filter((def) => forwarded.has(def.key)) : [];
    if (filtered.length === model.parameters.length) return model;
    const next = { ...model };
    if (filtered.length > 0) next.parameters = filtered;
    else delete next.parameters;
    return next;
  });
}

import { providerLog, serverLog } from '../logger';
import {
  buildAuthHeaders,
  getVerifyUrl,
  maskApiKey,
  withOpenRouterAttribution,
  GEMINI_V1BETA_BASE,
  GEMINI_V1_BASE,
  PROVIDER_BASE_URLS,
  VERTEX_EXPRESS_VERIFY_URL,
  safeEndpointUrl,
} from './api-endpoints';
import { AnthropicProvider } from './anthropic';
import {
  OpenAIProvider,
  GroqProvider,
  OpenRouterProvider,
  UnoRouterProvider,
  ExperientialLabsProvider,
  RespanProvider,
  XAIProvider,
  AzureProvider,
} from './openai';
import { OpenCodeGoProvider } from './opencodego';

import { GoogleProvider } from './google';
import { imageAttachmentTransportError } from './attachment-admission';
import { mediaInputAdmissionError } from './media-input';
import { CopilotProvider, exchangeGitHubTokenForCopilotAsync } from './copilot';
import {
  CodexCliProvider,
  codexTransientExhaustedMessage,
  isCodexTurnTokenFailure,
  isTransientCodexFailure,
} from './codex-cli';
import { CodexAuthProvider } from './codex-auth';
import { getManagedCodexAppServer } from './codex-app-server';
import { ClaudeCodeProvider } from './claude-code';
import { GrokBuildProvider } from './grok-build';
import { CodeBuddyProvider } from './codebuddy';
import { WorkBuddyDesktopProvider } from './workbuddy-desktop';
import {
  locateWorkBuddyDesktopApp,
  resolveWorkBuddyDesktopRuntime,
} from './workbuddy-desktop-runtime';
import { FreebuffProvider } from './freebuff-cli';
import { OmnirushCliProvider } from './omnirush-cli';
import { isModelEnabledInCatalog, resolveEnabledModelIds } from './model-availability';
import { OpenCodeCliProvider } from './opencode-cli';
import { FREEBUFF_CLI_DEFAULT_MODEL_ID } from './freebuff-bundled-catalog';
import { ensureFreebuffRuntimeReady } from './freebuff-runtime';
import { CodebuffProvider } from './codebuff';
import { AntigravityProvider } from './antigravity';
import { CursorProvider } from './cursor';
import { DevinProvider } from './devin';
import { ClineProvider } from './cline';
import { HundredMillionSeekProvider } from './hundredmillionseek';
import { NumesProvider } from './numes';
import { CoarenaProvider } from './coarena';
import { CrowLLMProvider } from './crowllm';
import { RadeonProvider } from './radeon';
import { RuncrateProvider } from './runcrate';
import { TokenHarborProvider } from './tokenharbor';
import { KiloCodeProvider } from './kilo-cli';
import { CommandCodeProvider } from './command-code';
import { HopliteProvider } from './hoplite';
import { BedrockProvider } from './bedrock';
import { hasAwsCredentialSource, scanAwsCredentialSources } from './aws-credential-scan';
import { GitLabProvider, normalizeGitLabBaseUrl, verifyGitLabDuoAccess } from './gitlab';
import { SapAiProvider, verifySapAiConnection } from './sapai';
import {
  GITHUB_MODELS_CATALOG_URL,
  GitHubModelsProvider,
  githubModelsHeaders,
  parseGitHubModelsCatalog,
} from './github-models';
import { NOTION_API_VERSION, NOTION_BASE_URL, NotionProvider } from './notion';
import { CustomProvider, normalizeCustomProviderBaseUrl, probeCustomProvider } from './custom';
import { AcpAgentProvider } from './acp/provider';
import {
  acpProviderName,
  isAcpProviderName,
  toAcpAgentProviderConfig,
  toAcpProbeConfig,
  type AcpAgentDefinition,
} from './acp/agent-definitions';
import {
  acpStoreRoot,
  loadAcpAgentDefinitions,
  loadAcpAgentEnv,
  loadAcpProbeVerdicts,
  type AcpProbeVerdict,
} from './acp/agent-store';
import { getWireAdapter } from './wire-adapters/registry';
import { getCapabilityAdapter, resolveCapabilityConfig } from './capabilities';
import {
  detectCodexCLILogin,
  detectClaudeCodeLogin,
  detectGrokCLILogin,
  detectCodeBuddyCLILogin,
  detectAntigravityCLILogin,
  detectCursorCLILogin,
  detectDevinCLILogin,
  detectOmnirushCLILogin,
  detectOpenCodeCLILogin,
  discoverFreebuffAccounts,
} from './auth-utils';
import { cliAutoEnableCreds, probeCliConnection, whichBinary } from './cli-detection';
import { discoverCliAccounts } from './cli-accounts';
import { type ProviderDeployment, getProviderDisplay } from './provider-display';
import {
  providerExecutionCapabilities,
  type ProviderExecutionCapabilities,
} from '@koryphaios/shared';
import { KimiCodeProvider } from './kimicode';
import { resolveKimiCodeAccessToken } from './kimicode-auth';
import { secureDecrypt, isUsingSecureEncryption } from '../security';
import {
  resolveModel,
  isLegacyModel,
  registerLiveModelResolver,
  lifecycleCapabilities,
  type LifecycleCapabilities,
  type StreamRequest,
  type ProviderEvent,
  type ProviderMessage,
  type Provider,
} from './types';
import { CapabilityRegistry } from './CapabilityRegistry';
import { withRetry } from './utils';
import { recordUsage as creditRecordUsage } from '../credit-accountant';
import {
  ENV_API_KEY_MAP,
  ENV_URL_MAP,
  ENV_AUTH_TOKEN_MAP,
  LLAMACPP_DEFAULT,
  LMSTUDIO_DEFAULT,
  BASE_URL_PLACEHOLDERS,
  PROVIDER_AUTH_MODE,
  providerDefaultBaseUrl,
} from './constants';
import {
  providerStreamFailure,
  safeProviderDiagnostic,
  safeProviderFailureMessage,
  transientExhaustedMessage,
} from './provider-diagnostics';
import {
  isRetriableProviderFailure,
  SAME_MODEL_MAX_RETRIES,
  waitForProviderRetry,
} from './provider-retry';
import { verifyRuntimeCompletion } from './runtime-verification';
import { catalogRefreshTier, getCatalogRefreshScheduler } from './catalog-refresh';
import { PROJECT_ROOT } from '../runtime/paths';
import { syncProviderConfigsToConfig } from '../runtime/config';
import { hydrateProviderEnvFromLoginShell } from '../runtime/login-shell-env';
import {
  envVarMaterial,
  isProviderAutodetectDisabled,
  localServerCandidate,
  providerEnvNamesForHydration,
} from './provider-autodetect';
import { enforceChatProviderIsolation } from './chat-isolation';
import { withBridgeWorkspace } from './bridge-grant';
import { currentProviderExecutionScope } from './execution-scope';

function safeVerificationHttpError(
  status: number,
  label = 'Provider verification request',
): string {
  if (status === 401) return `${label} was not authenticated (HTTP 401).`;
  if (status === 403) return `${label} was denied by the provider (HTTP 403).`;
  if (status === 404) return `${label} endpoint was not found (HTTP 404).`;
  if (status === 408) return `${label} timed out (HTTP 408).`;
  if (status === 429) return `${label} was rate-limited (HTTP 429).`;
  return `${label} failed (HTTP ${status}).`;
}

const CLI_HARNESS_PROVIDERS = new Set<ProviderName>([
  'claude',
  'codex',
  'codebuddy',
  'grok',
  'antigravity',
  'cursor',
  'devin',
  'freebuff',
  'omnirush',
  'opencode',
]);

// CLI harness providers that use a managed app-server instead of a CLI binary
// on PATH. They get the 'local' deployment but don't go through the standard
// cliAutoEnableCreds flow.
const MANAGED_CLI_PROVIDERS = new Set<ProviderName>(['codex-auth', 'workbuddy-desktop']);

const LOCAL_PROVIDER_KEYS = new Set<ProviderName>(['local', 'ollama', 'lmstudio', 'llamacpp']);

/** Built-ins whose APIs are not chat-completions contracts. */
export const UNSUPPORTED_CHAT_PROVIDER_NAMES = new Set<ProviderName>([
  'replicate',
  'modal',
  'luma',
  'fal',
  'elevenlabs',
  'deepgram',
  'gladia',
  'assemblyai',
  'lmnt',
  'voyageai',
  'mixedbread',
  'mem0',
  'letta',
  'blackforestlabs',
  'klingai',
  'prodia',
]);

/**
 * Providers that are genuinely configurable and verifiable but deliberately
 * expose no generic chat adapter. Membership means:
 *   - `unavailableProviderReason()` does not block them (only matters for names
 *     that are also in UNSUPPORTED_CHAT_PROVIDER_NAMES), and
 *   - a verified credential still resolves to connectionState 'verified', which
 *     is what unlocks the model selector for a provider whose `isAvailable()`
 *     is false.
 *
 * Two populations live here:
 *  - Audio/transcription backends (`deepgram`, `assemblyai`) reached through the
 *    dedicated voice route.
 *  - Media, retrieval, and memory backends reached through a capability adapter
 *    in `providers/capabilities/`. Their credentials are verified against that
 *    adapter's own endpoint rather than a chat models list, because none of them
 *    publishes a chat-completions surface.
 *
 * `hoplite` also qualifies but for a third reason: its org API key verifies
 * against /api/projects and it publishes a per-thread model catalog, but a
 * Hoplite thread is a delegated remote/local agent run rather than a chat
 * completion.
 */
export const DEDICATED_CAPABILITY_PROVIDER_NAMES = new Set<ProviderName>([
  'deepgram',
  'assemblyai',
  'hoplite',
  'luma',
  'klingai',
  'prodia',
  'replicate',
  'lmnt',
  'voyageai',
  'mem0',
  'letta',
]);

function unsupportedChatReason(name: ProviderName): string | undefined {
  if (!UNSUPPORTED_CHAT_PROVIDER_NAMES.has(name)) return undefined;
  return `${generateProviderLabel(String(name))} is not available as a chat provider in this build. Its non-chat API requires a dedicated capability adapter; no generic chat fallback will be used.`;
}

function unavailableProviderReason(name: ProviderName): string | undefined {
  return DEDICATED_CAPABILITY_PROVIDER_NAMES.has(name) ? undefined : unsupportedChatReason(name);
}

function inferProviderDeployment(
  name: ProviderName,
  authMode: ProviderAuthMode,
  isCustom: boolean,
  hasDisplayDeployment?: ProviderDeployment,
): ProviderDeployment {
  if (hasDisplayDeployment) return hasDisplayDeployment;
  if (
    LOCAL_PROVIDER_KEYS.has(name) ||
    CLI_HARNESS_PROVIDERS.has(name) ||
    MANAGED_CLI_PROVIDERS.has(name)
  )
    return 'local';
  if (String(name).startsWith('remote-')) return 'cloud';
  if (isCustom) return 'api';
  if (authMode === 'base_url_only') return 'local';
  return 'api';
}

// Circuit breaker states
interface CircuitState {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
}

type ProviderConnectionState = 'verified' | 'detected' | 'unknown' | 'failed';
type ProviderVerificationScope = 'credential' | 'account' | 'endpoint' | 'catalog' | 'runtime';

/** Outcome of one provider's user-requested refresh. `skipped` means the
 *  request was coalesced into an in-flight refresh or hit the cooldown; the UI
 *  treats that as a no-op rather than an error. */
export type ProviderRefreshResult = {
  name: ProviderName;
  skipped?: 'in_flight' | 'cooldown';
  verification?: ProviderVerificationResult;
  status?: ReturnType<ProviderRegistry['getStatus']>[number];
};

type ProviderVerificationResult = {
  /** The configuration/probe was accepted. This is not itself a verification verdict. */
  success: boolean;
  /** Omitted successful results are fully verified for backwards compatibility. */
  state?: ProviderConnectionState;
  /** Exact evidence established by this probe. */
  scope?: ProviderVerificationScope;
  error?: string;
};

interface ProviderVerificationRecord {
  state: ProviderConnectionState;
  checkedAt: number;
  scope: ProviderVerificationScope;
  error?: string;
}

/**
 * Generate a human-readable display label from a provider's machine name.
 * Used when no explicit label is defined in PROVIDER_DISPLAY, so every
 * provider in PROVIDER_CONFIGS gets a readable label without a hardcoded list.
 *
 *   '302ai'        -> '302.ai'
 *   'opencodezen'  -> 'OpenCode Zen'
 *   'codex-auth'   -> 'Codex Auth'
 *   'novita-ai'    -> 'Novita AI'
 *   'togetherai'   -> 'Together AI'
 *   'huggingface'  -> 'HuggingFace'
 */
function generateProviderLabel(name: string): string {
  // Special-case a few names where naive splitting looks wrong.
  const SPECIAL: Record<string, string> = {
    '302ai': '302.ai',
    aistudio: 'Google AI Studio',
    huggingface: 'HuggingFace',
    ollamacloud: 'Ollama Cloud',
    opencode: 'OpenCode',
    opencodezen: 'OpenCode Zen',
    opencodego: 'OpenCode Go',
    blackforestlabs: 'Black Forest Labs',
    klingai: 'Kling AI',
    novitaai: 'Novita AI',
    novita: 'Novita AI',
    'novita-ai': 'Novita AI',
    togetherai: 'Together AI',
    together: 'Together AI',
    zai: 'ZAI',
    xai: 'xAI',
    groq: 'Groq',
    'codex-auth': 'Codex Auth',
    kimicode: 'Kimi Code',
    moonshot: 'Moonshot AI',
    mixedbread: 'Mixedbread',
    mem0: 'Mem0',
    letta: 'Letta',
    prodia: 'Prodia',
    gladia: 'Gladia',
    lmnt: 'LMNT',
    fal: 'Fal',
    luma: 'Luma',
    poe: 'Poe',
    workbuddy: 'WorkBuddy',
    'workbuddy-desktop': 'WorkBuddy Desktop',
    moark: 'Moark',
    wandb: 'Weights & Biases',
    submodel: 'SubModel',
    synthetic: 'Synthetic',
    inference: 'Inference.net',
    requesty: 'Requesty',
    vultr: 'Vultr',
    abacus: 'Abacus',
    llama: 'Meta Llama',
    friendli: 'Friendli',
    voyageai: 'Voyage AI',
    perplexity: 'Perplexity',
    elevenlabs: 'ElevenLabs',
    assemblyai: 'AssemblyAI',
    deepgram: 'Deepgram',
    nvidia: 'NVIDIA NIM',
    upstage: 'Upstage',
    siliconflow: 'SiliconFlow',
    stepfun: 'StepFun',
    modelscope: 'ModelScope',
    qwen: 'Qwen',
    hyperbolic: 'Hyperbolic',
    deepinfra: 'DeepInfra',
    ionet: 'IO.net',
    fireworks: 'Fireworks AI',
    cerebras: 'Cerebras',
    cortecs: 'Cortecs',
    minimax: 'MiniMax',
    nebius: 'Nebius',
    scaleway: 'Scaleway',
    ovhcloud: 'OVHcloud',
    stackit: 'STACKIT',
    venice: 'Venice AI',
    zenmux: 'ZenMux',
    baseten: 'Baseten',
    helicone: 'Helicone',
    portkey: 'Portkey',
    modal: 'Modal',
    replicate: 'Replicate',
    cloudflare: 'Cloudflare',
    vercel: 'Vercel',
    mistral: 'Mistral AI',
    cohere: 'Cohere',
    // Well-known providers that need proper capitalization.
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    openrouter: 'OpenRouter',
    unorouter: 'UnoRouter',
    experientiallabs: 'Experiential Labs',
    hundredmillionseek: '100MillionSeek',
    numes: 'Numes',
    crowllm: 'CrowLLM',
    radeon: 'AMD Radeon Cloud',
    runcrate: 'Runcrate',
    google: 'Google',
    copilot: 'GitHub Copilot',
    azure: 'Azure OpenAI',
    bedrock: 'AWS Bedrock',
    vertexai: 'Vertex AI',
    local: 'Local (custom endpoint)',
    ollama: 'Ollama',
    lmstudio: 'LM Studio',
    llamacpp: 'Llama.cpp',
    deepseek: 'DeepSeek',
    claude: 'Claude Code',
    hoplite: 'Hoplite',
    azurecognitive: 'Azure Cognitive',
    sapai: 'SAP AI',
    gitlab: 'GitLab Duo',
    omnirush: 'Omnirush',
  };
  if (SPECIAL[name]) return SPECIAL[name];

  // Generic: split on hyphens and camelCase boundaries, title-case each part.
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_]/)
    .map((part) => {
      if (part.length <= 3) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    });
  return parts.join(' ');
}

const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_TIMEOUT = 60_000; // 1 minute

/**
 * Same-model retries for transient failures before falling through to the
 * next model in the fallback chain. CLI harnesses (Codex) YIELD an error
 * event on nonzero exit instead of throwing, so the retry check must cover
 * yielded errors too — not just thrown ones. The budget, the backoff, and the
 * retry decision live in `provider-retry` so auxiliary calls that invoke
 * `streamResponse` directly get the identical policy.
 */

/**
 * Upper bound for the connect-time live model catalog fetch in
 * setCredentials. Explicit connects await the provider's real model list so
 * the picker shows it immediately; this cap guarantees a slow catalog can
 * never hang the connect request (verification already proved the endpoint,
 * and background discovery keeps going).
 */
/**
 * Minimum gap between two user-requested refreshes of the SAME provider.
 *
 * A CLI-backed refresh spawns a subprocess with a multi-second probe timeout, so
 * an impatient double-click must coalesce rather than queue a second spawn. Ten
 * seconds is below the threshold of noticing but well above any duplicate click.
 */
const MANUAL_PROVIDER_REFRESH_COOLDOWN_MS = 10_000;

const CONNECT_CATALOG_TIMEOUT_MS = 15_000;

/**
 * Resume context for same-model retries of CLI-harness providers. When a
 * mid-turn transport failure (e.g. a stale turn-token binding) forces a fresh
 * attempt, already-completed native tool results ride along as `tool` role
 * messages so the model continues instead of redoing finished work. Codex
 * renders these freeform (`Tool result: ...`); strict API providers would
 * reject orphan tool messages, so carry-over applies to codex-family only.
 */
const CARRIED_TOOL_RESULTS_MAX = 20;
const CARRIED_TOOL_OUTPUT_MAX_CHARS = 2000;

/** Fingerprint a completed native tool call for resume matching. */
function carriedToolKey(toolName: string, toolInput: string): string {
  return `${toolName}::${toolInput}`;
}

/** Render one recorded native tool result as a prompt message. */
function toCarriedToolMessage(
  toolName: string,
  toolInput: string,
  toolOutput: string,
  isError: boolean,
): ProviderMessage {
  const output =
    toolOutput.length > CARRIED_TOOL_OUTPUT_MAX_CHARS
      ? `${toolOutput.slice(0, CARRIED_TOOL_OUTPUT_MAX_CHARS)}…[truncated ${toolOutput.length - CARRIED_TOOL_OUTPUT_MAX_CHARS} chars]`
      : toolOutput;
  const input = toolInput && toolInput !== '{}' ? ` input ${toolInput}` : '';
  return {
    role: 'tool',
    content: `[${toolName}]${isError ? ' (failed)' : ''}${input} → ${output}`,
  };
}

// ─── Provider factory registry ──────────────────────────────────────────────
// Each built-in provider registers a factory here instead of being dispatched
// from a central `switch (name)`. Adding a provider is now a single entry in
// this map, not an edit to a switch in createProvider() AND a second switch in
// the auth route. A factory returns null when the config lacks what the
// provider needs (e.g. no API key / base URL), matching the prior switch's
// per-case null returns.
type ProviderFactory = (config: ProviderConfig) => Provider | null;

const PROVIDER_FACTORIES: Partial<Record<ProviderName, ProviderFactory>> = {
  anthropic: (c) => new AnthropicProvider(c),
  // Claude Code subscription — runs the official `claude` CLI harness (no direct API calls).
  claude: (c) => new ClaudeCodeProvider(c),
  openai: (c) => new OpenAIProvider(c),
  // Direct Google Gemini API only. It never consumes CLI OAuth, ADC, or any
  // other Google provider's credentials.
  google: (c) => (c.apiKey ? new GoogleProvider(c) : null),
  // Google AI Studio — Gemini API key only (no gcloud OAuth).
  aistudio: (c) => (c.apiKey ? new GoogleProvider({ ...c, name: 'aistudio' }) : null),
  copilot: (c) => new CopilotProvider(c),
  codex: (c) => new CodexCliProvider(c),
  'codex-auth': (c) => new CodexAuthProvider(c),
  // Grok Build subscription — runs the official `grok` CLI harness (no direct API calls).
  grok: (c) => new GrokBuildProvider(c),
  // CodeBuddy subscription — runs the official `codebuddy` CLI harness.
  codebuddy: (c) => new CodeBuddyProvider(c),
  // WorkBuddy AI desktop app — runs the app's own host runtime (bundled CLI
  // in --serve mode inside the installed app), not the standalone CLI.
  'workbuddy-desktop': (c) => new WorkBuddyDesktopProvider(c),
  // Antigravity subscription — runs the official `agy` CLI harness (no direct API calls).
  antigravity: (c) => new AntigravityProvider(c),
  // Cursor subscription — runs the official `cursor-agent` CLI harness (no API key).
  cursor: (c) => new CursorProvider(c),
  // Devin subscription — runs Cognition's official `devin` CLI harness (no API key).
  devin: (c) => new DevinProvider(c),
  // Cline's hosted API — OpenAI-compatible Chat Completions on one API key.
  cline: (c) => (c.apiKey || c.authToken ? new ClineProvider(c) : null),
  // 100MillionSeek — OpenAI-compatible host; catalog owns limits and quota labels.
  hundredmillionseek: (c) => (c.apiKey || c.authToken ? new HundredMillionSeekProvider(c) : null),
  // Numes — OpenRouter-shaped gateway; catalog owns pricing, limits and efforts.
  numes: (c) => (c.apiKey || c.authToken ? new NumesProvider(c) : null),
  // Coarena — OpenAI-compatible Model API; public catalog, key-based usage.
  coarena: (c) => (c.apiKey || c.authToken ? new CoarenaProvider(c) : null),
  // CrowLLM — OpenAI-compatible gateway; public catalog, exact ids and variants.
  crowllm: (c) => (c.apiKey || c.authToken ? new CrowLLMProvider(c) : null),
  // AMD Radeon Cloud Token Factory — OpenAI-compatible; one rc-… key covers
  // every model and the authenticated /v1/models catalog owns the list.
  radeon: (c) => (c.apiKey || c.authToken ? new RadeonProvider(c) : null),
  // Runcrate — OpenAI-compatible inference; its public catalog owns the model
  // list, limits, modalities and USD prices.
  runcrate: (c) => (c.apiKey || c.authToken ? new RuncrateProvider(c) : null),
  // Token Harbor — OpenAI-compatible gateway; its catalog owns USD prices,
  // context limits and the reasoning_effort ladder.
  tokenharbor: (c) => (c.apiKey || c.authToken ? new TokenHarborProvider(c) : null),
  // Freebuff — real TUI driven through a sandboxed tmux PTY + Kory MCP.
  freebuff: (c) => new FreebuffProvider(c),
  // Omnirush — official local CLI harness; the CLI owns auth and model metadata.
  omnirush: (c) => new OmnirushCliProvider(c),
  // OpenCode — official `opencode` CLI driven over ACP; the CLI owns auth, the
  // live model catalog (with real context limits), and streaming.
  opencode: (c) => new OpenCodeCliProvider(c),
  codebuff: (c) => (c.apiKey ? new CodebuffProvider(c) : null),
  // Kilo Code AI Gateway — OpenAI-compatible, API key auth.
  // Notion Agent APIs — PAT auth, Custom Agents are the models.
  notion: (c) => (c.apiKey ? new NotionProvider(c) : null),
  kilocode: (c) => new KiloCodeProvider(c),
  // Command Code Provider API — OpenAI and Anthropic formats on one key.
  commandcode: (c) => new CommandCodeProvider(c),
  // Hoplite — cloud async agent whose organization key is verifiable today;
  // live delegation is not wired, so the adapter stays inert without a key.
  hoplite: (c) => (c.apiKey ? new HopliteProvider(c) : null),
  kimicode: (c) => new KimiCodeProvider(c),
  openrouter: (c) => new OpenRouterProvider(c),
  // UnoRouter — open-source OpenAI-compatible gateway (Bearer auth, /v1/models).
  unorouter: (c) => new UnoRouterProvider(c),
  // Experiential Labs — open-source AI gateway (Bearer auth, /v1/models).
  experientiallabs: (c) => new ExperientialLabsProvider(c),
  respan: (c) => (c.apiKey || c.authToken ? new RespanProvider(c) : null),
  // OpenCode Go is dual-protocol — OpenCodeGoProvider dispatches per-model.
  opencodego: (c) => new OpenCodeGoProvider(c),
  groq: (c) => new GroqProvider(c),
  xai: (c) => new XAIProvider(c),
  azure: (c) => new AzureProvider(c),
  // Azure Cognitive Services uses the same Azure OpenAI wire contract (api-key
  // header + /openai/deployments/{deployment}?api-version), just a different host.
  azurecognitive: (c) => (c.baseUrl ? new AzureProvider(c, 'azurecognitive') : null),
  // Claude on Amazon Bedrock — SigV4-signed via the official AnthropicBedrock client.
  bedrock: (c) => new BedrockProvider(c),
  // GitHub Models has a distinct catalog host; its dedicated adapter keeps
  // discovery separate from the OpenAI-compatible inference surface.
  'github-models': (c) => new GitHubModelsProvider(c),
  // GitLab Duo speaks POST /api/v4/chat/completions with a GitLab body and a
  // bare-string answer, so it keeps its own adapter instead of the family path.
  gitlab: (c) => (c.apiKey || c.authToken ? new GitLabProvider(c) : null),
  // SAP AI Core — OAuth (service key) + /v2/inference/deployments/{id} + AI-Resource-Group.
  sapai: (c) => (c.apiKey || c.authToken ? new SapAiProvider(c) : null),
  // Requires explicit API key — never auto-enable from GCP environment variables.
  vertexai: (c) =>
    c.disabled || !c.apiKey ? null : new GoogleProvider({ ...c, name: 'vertexai' }),
  local: (c) => openaiCompatLocal('local', c),
  ollama: (c) => openaiCompatLocal('ollama', c),
  llamacpp: (c) => openaiCompatLocal('llamacpp', c),
  lmstudio: (c) => openaiCompatLocal('lmstudio', c),
};

/** Shared factory for the OpenAI-compatible local providers (local/ollama/llamacpp/lmstudio). */
function openaiCompatLocal(name: ProviderName, config: ProviderConfig): Provider | null {
  const defaultBase =
    name === 'llamacpp' ? LLAMACPP_DEFAULT : name === 'lmstudio' ? LMSTUDIO_DEFAULT : undefined;
  const configuredBase = config.baseUrl ?? defaultBase;
  if (configuredBase) {
    // Ollama, LM Studio, and llama.cpp expose OpenAI-compatible inference at
    // /v1 even when their native discovery/health endpoint lives at the host
    // root. Keep those control-plane URLs separate from the chat base.
    const inferenceBase =
      name === 'ollama' || name === 'lmstudio' || name === 'llamacpp'
        ? `${configuredBase.replace(/\/v1\/?$/, '').replace(/\/+$/, '')}/v1`
        : configuredBase;
    return new OpenAICompatibleLocalProvider(config, name, inferenceBase);
  }
  return null;
}

/** Local OpenAI-compatible servers are endpoint-authenticated, not API-key-authenticated. */
class OpenAICompatibleLocalProvider extends OpenAIProvider {
  override isAvailable(): boolean {
    return !this.config.disabled && !!this.config.baseUrl?.trim();
  }
}

class ProviderRegistry {
  private providers = new Map<ProviderName, Provider>();
  private providerConfigs = new Map<ProviderName, ProviderConfig>();
  private circuitStates = new Map<ProviderName, CircuitState>();
  /**
   * Same-model retry counts by `${provider}:${cause}` (`transient` or
   * `turn-token-stale-binding`). Process-local health signal so bridge
   * flapping is visible instead of silent; never affects routing.
   */
  private retryCauseCounts = new Map<string, number>();
  /** Process-local probe verdicts. Credential/file presence is tracked separately. */
  private verificationRecords = new Map<ProviderName, ProviderVerificationRecord>();
  private cliAutoConnectInFlight: Promise<void> | null = null;
  private cliAutoConnectCheckedAt = 0;
  /** Where each auto-detected connection's material came from (env var name,
   *  AWS source, local server URL). Powers the status badge; never persisted. */
  private autoDetectedSources = new Map<ProviderName, string>();
  /** Providers the user disconnected this session; autodetect never revives them. */
  private userDisconnected = new Set<ProviderName>();
  /** Last autodetect attempt per provider, keyed by a hash of the material so a
   *  changed credential re-probes while an unchanged failure backs off. */
  private autoDetectAttempts = new Map<
    ProviderName,
    { fingerprint: string; at: number; success: boolean }
  >();
  private modelCatalogRefreshInFlight: Promise<void> | null = null;

  /** Per-provider guard for the user-facing Refresh button, so repeated clicks
   *  cannot stack CLI spawns or overlapping verification probes. */
  private providerRefreshInFlight = new Map<ProviderName, Promise<ProviderRefreshResult>>();
  private providerRefreshLastAt = new Map<ProviderName, number>();
  /** IDs of user-defined custom providers (e.g. "custom:my-llm"). */
  private customProviderIds = new Set<ProviderName>();
  /** IDs of user-registered ACP agents (`acp:<id>`); kept apart from endpoint customs. */
  private acpAgentIds = new Set<ProviderName>();
  /** Capability-based model selection — replaces blind first-match fallback. */
  private capabilityRegistry: CapabilityRegistry | undefined;

  constructor(private config?: KoryphaiosConfig) {
    this.initializeAll();
    // Let resolveTrustedContextWindow consult live-discovered model defs
    // (context windows the provider API / CLI reported itself).
    registerLiveModelResolver((modelId, provider) => {
      const p = this.get(provider);
      if (!p) return undefined;
      try {
        return p
          .listModels()
          .find(
            (m) =>
              m.id === modelId ||
              m.apiModelId === modelId ||
              m.name === modelId ||
              m.realModelId === modelId ||
              m.aliases?.includes(modelId),
          );
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Failed to resolve live model definition',
        );
        return undefined;
      }
    });
    // Initialize capability-based model selection (lazy import to avoid
    // circular dependency — CapabilityRegistry imports from this file).
    this.capabilityRegistry = new CapabilityRegistry(this);
  }

  private getVisibleProviderNames(): ProviderName[] {
    return [
      ...(Object.keys(PROVIDER_AUTH_MODE) as ProviderName[]),
      ...this.customProviderIds,
      ...this.acpAgentIds,
    ];
  }

  /** Auth mode for a provider, defaulting to api_key for user-defined custom providers. */
  private authModeFor(name: ProviderName): ProviderAuthMode {
    return PROVIDER_AUTH_MODE[name] ?? 'api_key';
  }

  /** Get all current provider configurations. */
  getConfigs(): Record<string, ProviderConfig> {
    const configs: Record<string, ProviderConfig> = {};
    for (const [name, config] of this.providerConfigs) {
      configs[name] = config;
    }
    return configs;
  }

  /** Get a specific provider by name. */
  get(name: ProviderName): Provider | undefined {
    const scope = currentProviderExecutionScope();
    if (scope) return scope.providers.get(name);
    return this.providers.get(name);
  }

  /** Get adapters with enough local configuration to attempt work. */
  getAvailable(): Provider[] {
    return [...(currentProviderExecutionScope()?.providers ?? this.providers).values()].filter(
      (p) => p.isAvailable(),
    );
  }

  /** Check if circuit breaker is open for a provider */
  private isCircuitOpen(name: ProviderName): boolean {
    const state = this.circuitStates.get(name);
    if (!state) return false;

    if (state.isOpen) {
      // Check if we should close it
      if (Date.now() - state.lastFailure > CIRCUIT_TIMEOUT) {
        state.isOpen = false;
        state.failures = 0;
        return false;
      }
      return true;
    }
    return false;
  }

  /** Record a failure for circuit breaker */
  private recordFailure(name: ProviderName): void {
    let state = this.circuitStates.get(name);
    if (!state) {
      state = { failures: 0, lastFailure: 0, isOpen: false };
      this.circuitStates.set(name, state);
    }

    state.failures++;
    state.lastFailure = Date.now();

    if (state.failures >= CIRCUIT_THRESHOLD) {
      state.isOpen = true;
      providerLog.warn({ provider: name, failures: state.failures }, 'Circuit breaker opened');
    }
  }

  /** Record a success for circuit breaker */
  private recordSuccess(name: ProviderName): void {
    const state = this.circuitStates.get(name);
    if (state) {
      state.failures = 0;
      state.isOpen = false;
    }
  }

  /** Snapshot of same-model retry counts by `${provider}:${cause}`. */
  getRetryCauseCounts(): Record<string, number> {
    return Object.fromEntries(this.retryCauseCounts);
  }

  /** Classify a retried failure for health visibility. Counts only; the
   *  retry decision itself stays in the call sites. Returns the cause key. */
  private recordRetryCause(provider: ProviderName, message: unknown): string {
    const cause =
      provider === 'codex' || provider === 'codex-auth'
        ? isCodexTurnTokenFailure(message)
          ? 'turn-token-stale-binding'
          : 'transient'
        : 'transient';
    const key = `${provider}:${cause}`;
    this.retryCauseCounts.set(key, (this.retryCauseCounts.get(key) ?? 0) + 1);
    return cause;
  }

  private hasDetectedConnectionMaterial(
    name: ProviderName,
    config: ProviderConfig | undefined,
    providerAvailable: boolean,
  ): boolean {
    if (providerAvailable) return true;
    if (!config) return false;
    // A disabled, unverified API-key provider can still have a saved key for
    // retry. Presence is not authentication and must not enable the adapter.
    if (config.disabled) return !!config.apiKey?.trim();
    if (config.custom) return !!config.baseUrl?.trim();
    const authMode = this.authModeFor(name);
    if (authMode === 'env_auth') {
      // A system AWS credential source OR credentials the user entered in
      // Settings (access key ID + secret access key) both count as detected.
      return this.hasBedrockEnvironment() || !!(config.apiKey && config.authToken);
    }
    if (authMode === 'base_url_only') return !!config.baseUrl?.trim();
    if (authMode === 'auth_only') return !!config.authToken?.trim();
    if (authMode === 'api_key_or_auth') {
      return !!(config.apiKey?.trim() || config.authToken?.trim());
    }
    return !!config.apiKey?.trim();
  }

  private verificationScopeFor(name: ProviderName): ProviderVerificationScope {
    if (CLI_HARNESS_PROVIDERS.has(name) || MANAGED_CLI_PROVIDERS.has(name)) return 'account';
    if (LOCAL_PROVIDER_KEYS.has(name) || String(name).startsWith('custom:')) return 'endpoint';
    if (
      name === 'sapai' ||
      name === 'bedrock' ||
      name === 'github-models' ||
      name === 'azure' ||
      name === 'azurecognitive'
    )
      return 'catalog';
    return 'credential';
  }

  private restoreVerificationRecord(name: ProviderName, config: ProviderConfig): void {
    if (config.disabled || !config.lastVerifiedAt || !config.lastVerificationScope) return;
    this.verificationRecords.set(name, {
      // Older configs predate lastVerificationState and could only have been
      // verified-grade; custom endpoints persist 'detected' explicitly.
      state: config.lastVerificationState ?? 'verified',
      checkedAt: config.lastVerifiedAt,
      scope: config.lastVerificationScope,
    });
  }

  private isDefinitiveVerificationFailure(error: string | undefined): boolean {
    return /\b(?:401|403|unauthori[sz]ed|not authenticated|not signed in|no .+ login|missing (?:api key|token|authtoken)|invalid api key|login material was detected)\b/i.test(
      error ?? '',
    );
  }

  async autoConnectCliProviders(force = false): Promise<void> {
    if (this.cliAutoConnectInFlight) return this.cliAutoConnectInFlight;
    if (!force && Date.now() - this.cliAutoConnectCheckedAt < 5_000) return;

    const names = new Set<ProviderName>(
      process.env.KORY_DISABLE_CLI_AUTODETECT ? [] : CLI_HARNESS_PROVIDERS,
    );
    for (const [name, config] of this.providerConfigs) {
      if (process.env.KORY_DISABLE_CLI_AUTODETECT && CLI_HARNESS_PROVIDERS.has(name)) continue;
      // Custom endpoints are user-owned network targets. New definitions are
      // probed before they are saved; legacy definitions stay configured until
      // an explicit Refresh or a real runtime request supplies fresh evidence.
      // A cold status read must never wait on an arbitrary custom endpoint.
      if (config.custom && !force) continue;
      const verification = this.verificationRecords.get(name);
      if (!config.disabled && (!verification || (force && verification.state !== 'verified'))) {
        names.add(name);
      }
    }
    let verificationChanged = false;
    this.cliAutoConnectInFlight = Promise.all(
      [...names].map(async (name) => {
        if (this.config?.providers?.[name]?.disabled === true) return;
        const providerConfig = this.providerConfigs.get(name);
        if (providerConfig?.disabled) {
          if (!CLI_HARNESS_PROVIDERS.has(name) || !cliAutoEnableCreds(name)) return;
          const result = await this.setCredentials(name, {});
          verificationChanged ||= result.success;
          return;
        }
        if (this.verificationRecords.get(name)?.state === 'verified') return;
        const before = providerConfig?.lastVerifiedAt;
        await this.verifyConnection(name);
        verificationChanged ||= providerConfig?.lastVerifiedAt !== before;
      }),
    )
      .then(() => this.autoDetectProviders(force))
      .then((autoDetected) => {
        verificationChanged ||= autoDetected;
        if (verificationChanged && process.env.NODE_ENV !== 'test') {
          syncProviderConfigsToConfig(PROJECT_ROOT, this.getConfigs());
        }
      })
      .finally(() => {
        this.cliAutoConnectCheckedAt = Date.now();
        this.cliAutoConnectInFlight = null;
      });

    return this.cliAutoConnectInFlight;
  }

  /**
   * Connect built-in providers whose connection material already exists on
   * this machine — env API keys/auth tokens, AWS credentials for Bedrock, and
   * running local model servers — but only after each provider's real
   * verification probe succeeds. Material is runtime-only: it is never
   * persisted, so a removed env var or a stopped server simply isn't
   * connected next launch. An in-session Disconnect or a persisted
   * `disabled: true` always wins. Opt out with
   * KORY_DISABLE_PROVIDER_AUTODETECT=1 (KORY_DISABLE_CLI_AUTODETECT=1 gates it
   * too). Returns whether anything got enabled.
   */
  async autoDetectProviders(force = false): Promise<boolean> {
    if (isProviderAutodetectDisabled()) return false;
    // Packaged/background launches inherit no shell rc exports; adopt the
    // allowlisted provider vars from the login shell before scanning.
    await hydrateProviderEnvFromLoginShell(providerEnvNamesForHydration());

    interface AutoDetectCandidate {
      name: ProviderName;
      creds: { authToken?: string; baseUrl?: string };
      fingerprint: string;
      label: string;
    }
    const candidates: AutoDetectCandidate[] = [];

    for (const name of Object.keys(PROVIDER_AUTH_MODE) as ProviderName[]) {
      if (CLI_HARNESS_PROVIDERS.has(name) || MANAGED_CLI_PROVIDERS.has(name)) continue;
      if (this.customProviderIds.has(name) || String(name).startsWith('custom:')) continue;
      if (UNSUPPORTED_CHAT_PROVIDER_NAMES.has(name)) continue;
      if (unavailableProviderReason(name)) continue;
      if (this.userDisconnected.has(name)) continue;
      if (this.providerConfigs.get(name)?.disabled !== true) continue;
      if (this.config?.providers?.[name]?.disabled === true) continue;

      const authMode = this.authModeFor(name);
      let creds: AutoDetectCandidate['creds'] | null = null;
      let material: string | null = null;
      let label: string | null = null;
      // Failed local-server probes cool down fast (a server can start any
      // moment); failed credential probes back off for much longer.
      let retryCooldownMs = 10 * 60_000;

      if (authMode === 'env_auth') {
        if (this.hasBedrockEnvironment()) {
          creds = {};
          material = scanAwsCredentialSources().description || 'aws';
          label = 'AWS credentials';
        }
      } else if (authMode === 'base_url_only') {
        const url = localServerCandidate(name);
        if (url) {
          creds = { baseUrl: url };
          material = url;
          label = `Local server · ${url}`;
          retryCooldownMs = 60_000;
        }
      } else {
        const key =
          authMode === 'api_key' || authMode === 'api_key_or_auth'
            ? envVarMaterial(name, 'apiKey')
            : null;
        const token =
          authMode === 'auth_only' || authMode === 'api_key_or_auth'
            ? envVarMaterial(name, 'authToken')
            : null;
        if (key) {
          // The apiKey slot stays empty: setCredentials resolves it from the
          // env itself, so a failed probe retains nothing.
          creds = {};
          material = key.value;
          label = key.envVar;
        } else if (token) {
          creds = { authToken: token.value };
          material = token.value;
          label = token.envVar;
        }
      }
      if (!creds || !material || !label) continue;

      // Only the fingerprint is stored — never the raw credential material.
      const fingerprint = createHash('sha256').update(`${name}\0${material}`).digest('hex');
      const attempt = this.autoDetectAttempts.get(name);
      if (attempt?.fingerprint === fingerprint) {
        // Identical material already connected; do not churn re-probes.
        if (attempt.success) continue;
        if (!force && Date.now() - attempt.at < retryCooldownMs) continue;
      }
      candidates.push({ name, creds, fingerprint, label });
    }

    let enabledAny = false;
    let index = 0;
    const workers = Array.from({ length: Math.min(4, candidates.length) }, async () => {
      while (index < candidates.length) {
        const candidate = candidates[index++];
        const result = await this.setCredentials(candidate.name, candidate.creds, {
          autoDetected: true,
        });
        this.autoDetectAttempts.set(candidate.name, {
          fingerprint: candidate.fingerprint,
          at: Date.now(),
          success: result.success,
        });
        if (result.success) {
          this.autoDetectedSources.set(candidate.name, candidate.label);
          enabledAny = true;
        }
      }
    });
    await Promise.all(workers);
    return enabledAny;
  }

  /** Get explicit detection, verification, availability, and model status for every provider. */
  getStatus(options: { refreshModels?: boolean } = {}): Array<{
    name: ProviderName;
    enabled: boolean;
    authenticated: boolean;
    adapterAvailable: boolean;
    credentialDetected: boolean;
    connectionState:
      'not_configured' | 'detected' | 'verified' | 'failed' | 'unknown' | 'unavailable';
    verifiedAt?: number;
    verificationScope?: ProviderVerificationScope;
    verificationError?: string;
    endpointUrl?: string;
    modelCatalogUrl?: string;
    modelDiscoveryHttpStatus?: number;
    models: string[];
    allAvailableModels: ReturnType<Provider['listModels']>;
    modelCatalogAuthoritative?: boolean;
    selectedModels: string[];
    hideModelSelector: boolean;
    /** Selected effective context budget; undefined means the maximum tier. */
    contextWindow?: number;
    /** Real context tiers reported by this provider's live model catalog. */
    contextWindowOptions: number[];
    /** Where auto-detected connection material came from (env var, AWS, local URL). */
    autoDetectedSource?: string;
    authMode: ProviderAuthMode;
    supportsApiKey: boolean;
    supportsAuthToken: boolean;
    requiresBaseUrl: boolean;
    requiresDeployment?: boolean;
    deploymentName?: string;
    circuitOpen: boolean;
    error?: string;
    extraAuthModes?: Array<{ id: string; label: string; description?: string }>;
    /** Placeholder for base URL input; backend is single source of truth so UI does not hardcode endpoints. */
    baseUrlPlaceholder?: string;
    /** True for user-defined custom providers. */
    custom?: boolean;
    /** Display label for custom providers. */
    label?: string;
    iconPath?: string;
    customIcon?: ProviderConfig['customIcon'];
    deployment?: 'cloud' | 'api' | 'local' | 'hybrid';
    execution?: ProviderExecutionCapabilities;
    /** Read-only lifecycle contract (interrupt, resume, rollback...). Conservative default when the adapter declares none. */
    lifecycle?: LifecycleCapabilities;
    description?: string;
    credentialUrl?: string;
  }> {
    const scope = currentProviderExecutionScope();
    if (scope)
      return [...scope.providers.values()].map((provider) => ({
        name: provider.name,
        enabled: !provider.config.disabled,
        authenticated: provider.isAvailable(),
        adapterAvailable: provider.isAvailable(),
        credentialDetected: true,
        connectionState: provider.isAvailable() ? ('verified' as const) : ('unavailable' as const),
        models: provider.listModels().map((model) => model.id),
        allAvailableModels: gateModelParametersToForwarded(provider, provider.listModels()),
        selectedModels: provider.listModels().map((model) => model.id),
        hideModelSelector: false,
        contextWindowOptions: Array.from(
          new Set(provider.listModels().flatMap((model) => model.contextWindowOptions ?? [])),
        ).sort((a, b) => a - b),
        authMode: 'api_key' as const,
        supportsApiKey: false,
        supportsAuthToken: false,
        requiresBaseUrl: false,
        circuitOpen: false,
        label: provider.config.label ?? String(provider.name),
      }));
    const names = this.getVisibleProviderNames();
    // A status read means the user is looking at the provider surface (Settings,
    // the model picker, the composer). That counts as activity for the adaptive
    // catalog scheduler, so returning to the app refreshes what is stale instead
    // of waiting out an idle-backoff interval.
    getCatalogRefreshScheduler()?.noteActivity();
    const result: Array<{
      name: ProviderName;
      enabled: boolean;
      authenticated: boolean;
      adapterAvailable: boolean;
      credentialDetected: boolean;
      connectionState:
        'not_configured' | 'detected' | 'verified' | 'failed' | 'unknown' | 'unavailable';
      verifiedAt?: number;
      verificationScope?: ProviderVerificationScope;
      verificationError?: string;
      endpointUrl?: string;
      modelCatalogUrl?: string;
      modelDiscoveryHttpStatus?: number;
      models: string[];
      allAvailableModels: ReturnType<Provider['listModels']>;
      modelCatalogAuthoritative?: boolean;
      selectedModels: string[];
      hideModelSelector: boolean;
      contextWindow?: number;
      contextWindowOptions: number[];
      autoDetectedSource?: string;
      authMode: ProviderAuthMode;
      supportsApiKey: boolean;
      supportsAuthToken: boolean;
      requiresBaseUrl: boolean;
      requiresDeployment?: boolean;
      deploymentName?: string;
      configurationBlocked?: boolean;
      circuitOpen: boolean;
      error?: string;
      extraAuthModes?: Array<{ id: string; label: string; description?: string }>;
      baseUrlPlaceholder?: string;
      custom?: boolean;
      label?: string;
      iconPath?: string;
      customIcon?: ProviderConfig['customIcon'];
      deployment?: 'cloud' | 'api' | 'local' | 'hybrid';
      execution?: ProviderExecutionCapabilities;
      lifecycle?: LifecycleCapabilities;
      description?: string;
      credentialUrl?: string;
    }> = [];

    for (const name of names) {
      const provider = this.providers.get(name);
      const config = this.providerConfigs.get(name);
      const isCustom = this.customProviderIds.has(name) || !!config?.custom;
      const authMode = this.authModeFor(name);
      const circuitOpen = this.isCircuitOpen(name);

      const isProviderAvailable = provider?.isAvailable() ?? false;
      const isEnabled = config ? !config.disabled : false;
      const credentialDetected = this.hasDetectedConnectionMaterial(
        name,
        config,
        isProviderAvailable,
      );
      const verification = this.verificationRecords.get(name);
      let allModels = [] as ReturnType<Provider['listModels']>;
      if (isEnabled) {
        if (provider) {
          if (options.refreshModels) {
            provider.refreshModels?.(true);
          }
          allModels = provider.listModels();
        }
      }

      // Before account-owned Freebuff catalogs existed, the provider persisted
      // its CLI-default sentinel as the only selected model. That sentinel is
      // a selection policy, not an entitlement restriction: once account rows
      // are available, treating it as an explicit filter hides every real
      // Freebuff model from the main picker. Preserve explicit multi-model
      // selections, but expand this legacy default-only state to the catalog.
      const configuredSelectedModels = config?.selectedModels ?? [];
      const selectedModels =
        name === 'freebuff' &&
        configuredSelectedModels.length === 1 &&
        configuredSelectedModels[0] === FREEBUFF_CLI_DEFAULT_MODEL_ID &&
        allModels.some((model) => model.apiModelId?.startsWith('freebuff/catalog-'))
          ? []
          : configuredSelectedModels;
      const hideModelSelector = config?.hideModelSelector ?? false;
      // Only real tiers reported by a provider's own catalog can appear in the
      // context selector. A generated ladder would offer budgets the CLI does
      // not accept.
      const contextWindowOptions = Array.from(
        new Set(allModels.flatMap((model) => model.contextWindowOptions ?? [])),
      ).sort((a, b) => a - b);
      const providerUnavailableReason = unavailableProviderReason(name);
      // A failed background refresh keeps the last good catalog (see
      // refreshModelsInBackground), so a stale discovery error must not be
      // shown while the provider still reports models — that is exactly the
      // "Connected · 23/23 models enabled" alongside "No models were
      // reported" contradiction. Discovery trouble is surfaced only when
      // there is actually nothing to offer.
      const discoveryFailure = provider?.getModelDiscoveryError?.();
      // A cold catalog read starts discovery and returns the models already
      // cached, which is none on the first read. Reporting that as a discovery
      // failure made every first visit to a provider card flash "No models were
      // reported" before the request it just started had a chance to finish.
      const discoveryInFlight = provider?.isModelDiscoveryInFlight?.() === true;
      const modelDiscoveryError =
        providerUnavailableReason ??
        (isEnabled &&
        isProviderAvailable &&
        !hideModelSelector &&
        allModels.length === 0 &&
        !discoveryInFlight
          ? (discoveryFailure ??
            'No models were reported by this configured provider. Refresh discovery or check its account and CLI/API authentication.')
          : undefined);

      // All-stale selections resolve to zero live entries → unfiltered,
      // matching the picker rule that an empty enabled list means "all".
      const enabledModels = resolveEnabledModelIds(allModels, selectedModels);

      const blocksChatConfiguration = !!providerUnavailableReason;
      const connectionState = blocksChatConfiguration
        ? ('unavailable' as const)
        : verification?.state === 'verified' &&
            (isProviderAvailable || DEDICATED_CAPABILITY_PROVIDER_NAMES.has(name))
          ? ('verified' as const)
          : verification?.state === 'failed'
            ? ('failed' as const)
            : verification?.state === 'unknown'
              ? ('unknown' as const)
              : verification?.state === 'detected'
                ? ('detected' as const)
                : credentialDetected
                  ? ('detected' as const)
                  : isEnabled
                    ? ('unknown' as const)
                    : ('not_configured' as const);
      const requiresDeployment = name === 'azure' || name === 'azurecognitive' || name === 'sapai';
      const requiresBaseUrl =
        !blocksChatConfiguration &&
        (isCustom ||
          authMode === 'base_url_only' ||
          name === 'cloudflare' ||
          name === 'modal' ||
          name === 'azure' ||
          name === 'azurecognitive' ||
          name === 'sapai' ||
          // Self-managed GitLab is a different host, so the instance URL has to
          // be configurable even though gitlab.com is the default.
          name === 'gitlab' ||
          name === 'zai');
      const baseUrlPlaceholder: string | undefined = requiresBaseUrl
        ? (BASE_URL_PLACEHOLDERS[name] ??
          providerDefaultBaseUrl(name) ??
          (name === 'ollama'
            ? 'http://localhost:11434'
            : name === 'llamacpp'
              ? LLAMACPP_DEFAULT
              : name === 'lmstudio'
                ? LMSTUDIO_DEFAULT
                : isCustom
                  ? config?.baseUrl || 'https://your-endpoint.example/v1'
                  : undefined))
        : undefined;

      const display = getProviderDisplay(name);
      const endpointUrl = safeEndpointUrl(config?.baseUrl ?? providerDefaultBaseUrl(name));
      const modelCatalogUrl = endpointUrl ? `${endpointUrl}/models` : undefined;
      const discoveryStatus = provider as
        (Provider & { getModelDiscoveryHttpStatus?: () => number | undefined }) | undefined;
      const inferredDeployment = inferProviderDeployment(
        name,
        authMode,
        isCustom,
        display?.deployment,
      );

      result.push({
        name,
        enabled: isEnabled,
        // Keep the compatibility field truthful: detection and adapter
        // construction alone do not establish authenticated provider access.
        authenticated: connectionState === 'verified',
        adapterAvailable: isProviderAvailable,
        credentialDetected,
        connectionState,
        ...(verification &&
          (verification.state === 'verified' || verification.state === 'detected') && {
            verificationScope: verification.scope,
          }),
        ...(verification?.state === 'verified' && { verifiedAt: verification.checkedAt }),
        ...(verification?.error && { verificationError: verification.error }),
        ...(endpointUrl && { endpointUrl }),
        ...(modelCatalogUrl && { modelCatalogUrl }),
        ...(discoveryStatus?.getModelDiscoveryHttpStatus && {
          modelDiscoveryHttpStatus: discoveryStatus.getModelDiscoveryHttpStatus(),
        }),
        models: enabledModels,
        allAvailableModels: gateModelParametersToForwarded(provider, allModels),
        ...(provider?.isModelCatalogAuthoritative?.() === true
          ? { modelCatalogAuthoritative: true }
          : {}),
        selectedModels,
        hideModelSelector,
        ...(config?.contextWindow !== undefined ? { contextWindow: config.contextWindow } : {}),
        contextWindowOptions,
        ...(this.autoDetectedSources.has(name) && {
          autoDetectedSource: this.autoDetectedSources.get(name),
        }),
        authMode,
        supportsApiKey:
          !blocksChatConfiguration &&
          (isCustom ||
            authMode === 'api_key' ||
            authMode === 'api_key_or_auth' ||
            // Bedrock's env_auth mode also accepts explicit AWS keys in Settings.
            name === 'bedrock'),
        supportsAuthToken:
          !blocksChatConfiguration &&
          !CLI_HARNESS_PROVIDERS.has(name) &&
          (authMode === 'auth_only' || authMode === 'api_key_or_auth' || name === 'bedrock'),
        requiresBaseUrl,
        ...(requiresDeployment && { requiresDeployment: true }),
        ...(config?.deployment && { deploymentName: config.deployment }),
        ...(blocksChatConfiguration && { configurationBlocked: true }),
        circuitOpen,
        ...(modelDiscoveryError && { error: modelDiscoveryError }),
        ...(isCustom && {
          custom: true,
          label: config?.label ?? String(name),
          ...(config?.customIcon && { customIcon: config.customIcon }),
        }),
        ...(display?.label && !isCustom && { label: display.label }),
        // Auto-generate a human-readable label for providers without a display entry.
        ...(!display?.label &&
          !isCustom &&
          !String(name).startsWith('remote-') && {
            label: generateProviderLabel(String(name)),
          }),
        ...(display?.iconPath && { iconPath: display.iconPath }),
        deployment: inferredDeployment,
        execution: providerExecutionCapabilities(String(name), inferredDeployment),
        ...(provider && { lifecycle: lifecycleCapabilities(provider) }),
        ...(display?.credentialUrl && { credentialUrl: display.credentialUrl }),
        ...(baseUrlPlaceholder && { baseUrlPlaceholder }),
        // Remote providers (served by another machine) carry an agentic flag so
        // the composer can confirm the "your files go to the host" CLI flow.
        ...(String(name).startsWith('remote-') && {
          remote: true,
          remoteAgentic: (provider as { agentic?: boolean } | undefined)?.agentic === true,
          label: config?.label ?? String(name),
        }),
      });
    }

    return result;
  }

  /** Refresh model catalogs for enabled providers that expose a refresh hook. */
  async refreshModelCatalogs(): Promise<void> {
    if (this.modelCatalogRefreshInFlight) return this.modelCatalogRefreshInFlight;

    this.modelCatalogRefreshInFlight = this.refreshModelCatalogsInternal().finally(() => {
      this.modelCatalogRefreshInFlight = null;
    });
    return this.modelCatalogRefreshInFlight;
  }

  private async refreshModelCatalogsInternal(): Promise<void> {
    const refreshes: Promise<unknown>[] = [];
    // Subprocess-backed catalogs are refreshed one at a time. Fanning these out
    // together started every installed CLI at once — a single manual refresh
    // could launch a dozen processes on the user's machine, each with its own
    // multi-second probe timeout. Cheap HTTP catalogs stay fully parallel, since
    // one GET each cannot exhaust the machine.
    const cliBacked: Provider[] = [];
    const names = this.getVisibleProviderNames();

    for (const name of names) {
      const provider = this.providers.get(name);
      const config = this.providerConfigs.get(name);
      const isEnabled = config ? !config.disabled : false;
      if (!provider || !isEnabled) continue;

      // A forced status request probes custom-provider credentials immediately
      // before refreshing catalogs. If that probe failed, a second /models call
      // cannot add information and only repeats the rejected credential. The
      // next explicit verification remains free to retry this provider.
      const isCustom = config?.custom === true || this.customProviderIds.has(name);
      if (isCustom && this.verificationRecords.get(name)?.state === 'failed') continue;

      if (catalogRefreshTier(name) === 'cli') {
        cliBacked.push(provider);
        continue;
      }
      try {
        const result = provider.refreshModels?.(true);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          refreshes.push(result);
        }
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Provider model refresh failed (non-fatal)',
        );
        // Refresh failures are non-fatal here; provider status can still render
        // with cached/fallback models and users can retry manually from settings.
      }
    }

    if (refreshes.length > 0) {
      await Promise.allSettled(refreshes);
    }

    for (const provider of cliBacked) {
      try {
        await provider.refreshModels?.(true);
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err), provider: provider.name },
          'CLI provider catalog refresh failed (non-fatal)',
        );
      }
    }

    // A manual refresh already paid for the catalogs it covered. Tell the
    // adaptive scheduler so it does not immediately repeat the same work.
    getCatalogRefreshScheduler()?.noteManualRefresh();
  }

  /**
   * Providers a background catalog refresh may poll: enabled, runnable, and
   * actually exposing a discovery hook. Providers with no `refreshModels` hook
   * serve a fixed list and must never appear here.
   */
  listModelCatalogRefreshTargets(): Provider[] {
    const targets: Provider[] = [];
    for (const provider of this.providers.values()) {
      const config = this.providerConfigs.get(provider.name);
      if (!config || config.disabled) continue;
      if (typeof provider.refreshModels !== 'function') continue;
      if (!provider.isAvailable()) continue;
      // Same reasoning as refreshModelCatalogsInternal: a custom provider whose
      // credential probe failed gains nothing from another /models attempt.
      const isCustom = config.custom === true || this.customProviderIds.has(provider.name);
      if (isCustom && this.verificationRecords.get(provider.name)?.state === 'failed') continue;
      if (this.isCircuitOpen(provider.name)) continue;
      targets.push(provider);
    }
    return targets;
  }

  /**
   * Refresh one provider's model catalog. Single-provider counterpart to
   * `refreshModelCatalogs`, used by the adaptive background scheduler so each
   * provider can run on its own cadence. Failures stay non-fatal.
   */
  async refreshModelCatalog(name: ProviderName): Promise<void> {
    const provider = this.providers.get(name);
    if (!provider) return;
    try {
      const result = provider.refreshModels?.(true);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        await result;
      }
    } catch (err: unknown) {
      serverLog.debug(
        { provider: name, err: err instanceof Error ? err.message : String(err) },
        'Provider model refresh failed (non-fatal)',
      );
    }
  }

  /**
   * One provider's user-requested refresh: re-check it with the provider and
   * reload its model catalog.
   *
   * This is the per-provider counterpart to the all-provider paths, and it is
   * deliberately cheap by default: `verifyConnection` performs a real
   * configuration/catalog probe against the provider, which is enough to
   * confirm the credential still works. `runtimeCheck` additionally spends a
   * real generation, which is opt-in because it costs tokens.
   *
   * Coalesced per provider and rate-limited, because a CLI-backed refresh spawns
   * a subprocess and a held-down button would otherwise queue them up.
   */
  async refreshProviderAndVerify(
    name: ProviderName,
    options: { runtimeCheck?: boolean; now?: number } = {},
  ): Promise<ProviderRefreshResult> {
    const existing = this.providerRefreshInFlight.get(name);
    if (existing) return existing;

    // One clock for both the check and the recorded timestamp. Reading the wall
    // clock again at completion made the two disagree, so a caller supplying an
    // injected clock could be refused by a cooldown it never entered.
    const now = options.now ?? Date.now();
    const last = this.providerRefreshLastAt.get(name) ?? 0;
    if (last > 0 && now - last < MANUAL_PROVIDER_REFRESH_COOLDOWN_MS) {
      return { skipped: 'cooldown', name };
    }
    this.providerRefreshLastAt.set(name, now);

    const run = (async (): Promise<ProviderRefreshResult> => {
      // A previously open circuit would otherwise block the very probe the user
      // asked for.
      this.circuitStates.delete(name);
      this.clearKeyInvalid?.(name);

      let verification: ProviderVerificationResult | undefined;
      try {
        verification = await this.verifyConnection(name, undefined, {
          runtimeCheck: options.runtimeCheck === true,
        });
      } catch (err: unknown) {
        verification = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      // Refresh regardless of the verification verdict: a provider can be
      // reachable for its catalog while the credential probe failed, and the
      // user explicitly asked for fresh lists.
      await this.refreshModelCatalog(name);
      // Stop the background scheduler from immediately repeating this work.
      getCatalogRefreshScheduler()?.noteManualRefresh();

      const status = this.getStatus().find((entry) => entry.name === name);
      return { name, verification, status };
    })().finally(() => {
      this.providerRefreshInFlight.delete(name);
    });

    this.providerRefreshInFlight.set(name, run);
    return run;
  }

  /** All provider types that can be added (for "Add provider" UI). Not filtered by auth. */
  getAvailableProviderTypes(): Array<{ name: ProviderName; authMode: ProviderAuthMode }> {
    return this.getVisibleProviderNames().map((name) => ({
      name,
      authMode: this.authModeFor(name),
    }));
  }

  /** Register (or update) a user-defined custom provider. Caller persists via getConfigs(). */
  registerCustomProvider(def: {
    id: ProviderName;
    label: string;
    kind?: 'openai' | 'anthropic' | 'gemini';
    adapter?: string;
    baseUrl: string;
    apiKey?: string;
    authToken?: string;
    headers?: Record<string, string>;
    models?: string[];
    catalogDetected?: boolean;
  }): { success: boolean; error?: string } {
    if (!def.baseUrl?.trim())
      return { success: false, error: 'Custom provider requires a base URL' };
    let normalizedBaseUrl: string;
    try {
      normalizedBaseUrl = normalizeCustomProviderBaseUrl(def.baseUrl);
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Custom provider endpoint is invalid',
      };
    }
    const catalogDetectedAt = def.catalogDetected ? Date.now() : undefined;
    const previous = this.providerConfigs.get(def.id);
    const providerConfig: ProviderConfig = {
      name: def.id,
      custom: true,
      kind: def.kind ?? 'openai',
      label: def.label,
      baseUrl: normalizedBaseUrl,
      apiKey: def.apiKey?.trim() || undefined,
      authToken: def.authToken?.trim() || undefined,
      headers: def.headers,
      models: def.models,
      selectedModels: def.models ?? [],
      hideModelSelector: false,
      // Persist the catalog confirmation so the provider survives restarts
      // as detected instead of dropping to unconfigured.
      ...(catalogDetectedAt && {
        lastVerifiedAt: catalogDetectedAt,
        lastVerificationScope: 'catalog' as const,
        lastVerificationState: 'detected' as const,
      }),
      ...(previous?.customIcon && { customIcon: previous.customIcon }),
      // Only persist known adapter ids; an unknown one would silently break
      // inference at provider-construction time.
      ...(def.adapter && getWireAdapter(def.adapter) && { adapter: def.adapter }),
      disabled: false,
    };
    this.providerConfigs.set(def.id, providerConfig);
    this.customProviderIds.add(def.id);
    const provider = this.createProvider(def.id, providerConfig);
    if (!provider) {
      this.customProviderIds.delete(def.id);
      this.providerConfigs.delete(def.id);
      return { success: false, error: 'Failed to initialize custom provider' };
    }
    this.providers.set(def.id, provider);
    this.circuitStates.delete(def.id);
    if (catalogDetectedAt) {
      this.verificationRecords.set(def.id, {
        state: 'detected',
        checkedAt: catalogDetectedAt,
        scope: 'catalog',
      });
    } else {
      this.verificationRecords.delete(def.id);
    }
    providerLog.info(
      { provider: def.id, kind: providerConfig.kind, adapter: providerConfig.adapter },
      'Custom provider registered',
    );
    return { success: true };
  }

  /** Merge icon metadata without rebuilding or weakening the provider config. */
  setCustomProviderIcon(
    id: ProviderName,
    customIcon: ProviderConfig['customIcon'] | undefined,
  ): { success: boolean; error?: string } {
    const existing = this.providerConfigs.get(id);
    if (!existing?.custom || !this.customProviderIds.has(id)) {
      return { success: false, error: 'Custom provider not found' };
    }
    this.providerConfigs.set(id, {
      ...existing,
      customIcon,
    });
    return { success: true };
  }

  /**
   * Register or replace a user-registered ACP agent (`acp:<id>`). The provider
   * config carries the non-secret definition and the stored probe verdict; env
   * values are read from the agent secret store at turn time.
   */
  registerAcpAgentProvider(def: AcpAgentDefinition, verdict?: AcpProbeVerdict): void {
    const name = acpProviderName(def.id) as ProviderName;
    const providerConfig: ProviderConfig = {
      name,
      disabled: false,
      acpAgent: toAcpAgentProviderConfig(def, verdict ? toAcpProbeConfig(verdict) : undefined),
    };
    this.providerConfigs.set(name, providerConfig);
    this.acpAgentIds.add(name);
    this.providers.delete(name);
    this.circuitStates.delete(name);
    const provider = this.createProvider(name, providerConfig);
    if (provider) this.providers.set(name, provider);
    providerLog.info({ provider: name, probed: !!verdict?.ok }, 'ACP agent provider registered');
  }

  /** Remove a user-registered ACP agent provider. */
  removeAcpAgentProvider(id: string): void {
    const name = acpProviderName(id) as ProviderName;
    this.providers.delete(name);
    this.providerConfigs.delete(name);
    this.acpAgentIds.delete(name);
    this.circuitStates.delete(name);
    this.verificationRecords.delete(name);
    providerLog.info({ provider: name }, 'ACP agent provider removed');
  }

  /** Remove a user-defined custom provider. */
  removeCustomProvider(id: ProviderName): void {
    this.providers.delete(id);
    this.providerConfigs.delete(id);
    this.customProviderIds.delete(id);
    this.circuitStates.delete(id);
    this.verificationRecords.delete(id);
    providerLog.info({ provider: id }, 'Custom provider removed');
  }

  /** Register a REMOTE provider (inference served by another machine's host).
   *  Appears in the picker like any provider; the manager runs tools locally. */
  registerRemoteProvider(provider: Provider): void {
    const id = provider.name;
    this.providerConfigs.set(id, provider.config);
    this.customProviderIds.add(id);
    this.providers.set(id, provider);
    this.circuitStates.delete(id);
    providerLog.info({ provider: id }, 'Remote provider registered');
  }

  /** Remove every registered remote provider (id prefix `remote-`). */
  clearRemoteProviders(): void {
    for (const id of [...this.customProviderIds]) {
      if (String(id).startsWith('remote-')) this.removeCustomProvider(id);
    }
  }

  /**
   * True when the provider earned explicit trust for auto-routing: a verified
   * credential, or a user-owned custom endpoint (creating one is explicit by
   * definition). Everything else — env-detected keys, CLI login markers,
   * never-probed configs — ranks as fallback. Auto-detection therefore fills
   * gaps but never outranks a provider the user verified.
   */
  isTrustedForRouting(name: ProviderName): boolean {
    if (this.customProviderIds.has(name) || this.providerConfigs.get(name)?.custom) return true;
    // A user-registered ACP agent is an explicit act, like creating a custom endpoint.
    if (this.acpAgentIds.has(name)) return true;
    return this.verificationRecords.get(name)?.state === 'verified';
  }

  /** Find the best available provider for a given model ID. */
  findProviderForModel(modelId: string): Provider | undefined {
    for (const provider of this.getAvailable()) {
      if (this.isCircuitOpen(provider.name)) continue;

      const config = this.providerConfigs.get(provider.name);
      const selected = config?.selectedModels ?? [];

      const listed = provider.listModels();
      const known = listed.some((m) => m.id === modelId || m.aliases?.includes(modelId));
      if (selected.length > 0 && !selected.includes(modelId) && !known) {
        continue;
      }

      if (known) {
        return provider;
      }
    }
    return undefined;
  }

  /** Resolve the provider that should handle a model. */
  resolveProvider(modelId: string, preferredProvider?: ProviderName): Provider | undefined {
    const scope = currentProviderExecutionScope();
    if (scope) {
      const candidates = preferredProvider
        ? [scope.providers.get(preferredProvider)]
        : [...scope.providers.values()];
      return candidates.find(
        (provider) =>
          provider?.isAvailable() &&
          provider
            .listModels()
            .some((model) => model.id === modelId || model.aliases?.includes(modelId)),
      );
    }
    const modelDef = resolveModel(modelId);

    if (modelDef) {
      const catalogProvider = this.providers.get(modelDef.provider);
      if (catalogProvider?.isAvailable() && !this.isCircuitOpen(catalogProvider.name))
        return catalogProvider;
      // Catalog provider missing or unavailable: try user's preferred provider if it can serve this model, then any available provider.
      if (preferredProvider) {
        const preferred = this.providers.get(preferredProvider);
        if (
          preferred?.isAvailable() &&
          !this.isCircuitOpen(preferredProvider) &&
          preferred.listModels().some((m) => m.id === modelId)
        )
          return preferred;
      }
      return this.findProviderForModel(modelId);
    }

    if (preferredProvider) {
      const preferred = this.providers.get(preferredProvider);
      if (preferred?.isAvailable() && !this.isCircuitOpen(preferredProvider)) return preferred;
    }
    return this.findProviderForModel(modelId);
  }

  /** Return the best available model for "auto" fallback, using
   *  capability-based scoring instead of blind first-match. Falls back to
   *  the original first-match behavior if the capability registry returns
   *  nothing (e.g. all providers have open circuit breakers). */
  getFirstAvailableRouting(): { model: string; provider: ProviderName } | undefined {
    if (currentProviderExecutionScope()) {
      for (const provider of this.getAvailable()) {
        const model = provider.listModels()[0];
        if (model) return { model: model.id, provider: provider.name };
      }
      return undefined;
    }
    // Try capability-based selection first — picks the best model by tier,
    // context window, and capabilities rather than insertion order.
    const capability = this.capabilityRegistry?.findBestModel({
      preferredTier: 'flagship',
    });
    if (capability) return capability;
    // Fallback: original blind first-match for edge cases where the
    // capability registry has no candidates (e.g. all legacy models).
    for (const provider of this.getAvailable()) {
      if (provider.name === 'vertexai' || this.isCircuitOpen(provider.name)) continue;
      const models = provider.listModels().filter((m) => !isLegacyModel(m));
      const first = models[0];
      if (first) return { model: first.id, provider: provider.name as ProviderName };
    }
    return undefined;
  }

  /** Execute a stream request with automatic retries and circuit breaker. */
  async *executeWithRetry(
    request: StreamRequest,
    preferredProvider?: ProviderName,
    fallbackChain: string[] = [],
  ): AsyncGenerator<ProviderEvent> {
    const scope = currentProviderExecutionScope();
    if (scope && request.sessionId !== scope.sessionId) {
      yield { type: 'error', error: 'Device provider credentials belong to a different chat.' };
      return;
    }
    const chain = [request.model, ...fallbackChain];
    // A real completion is the strongest activity signal available: the user is
    // actively using this provider, so its catalog should not be sitting on an
    // idle-backoff interval while a turn runs.
    getCatalogRefreshScheduler()?.noteActivity();

    for (let i = 0; i < chain.length; i++) {
      const currentModel = chain[i];
      const provider = this.resolveProvider(currentModel, i === 0 ? preferredProvider : undefined);
      if (request.requiredProvider && provider?.name !== request.requiredProvider) {
        yield {
          type: 'error',
          error:
            'The authorized provider is unavailable. Remote inference cannot use a different provider.',
        };
        return;
      }

      if (!provider) {
        if (i === chain.length - 1) {
          yield { type: 'error', error: `No available provider for model: ${currentModel}` };
          return;
        }
        providerLog.warn({ model: currentModel }, 'No provider available, trying fallback');
        continue;
      }

      // Check circuit breaker
      if (this.isCircuitOpen(provider.name)) {
        providerLog.warn({ provider: provider.name }, 'Circuit breaker open, skipping');
        if (i === chain.length - 1) {
          yield { type: 'error', error: `Provider ${provider.name} circuit breaker open` };
          return;
        }
        continue;
      }

      // Every dispatch path (including remote turns and fallback routes) must
      // reject a text-only integration before it can flatten image input.
      const imageTransportError = imageAttachmentTransportError(provider, request.messages);
      if (imageTransportError) {
        yield { type: 'error', error: imageTransportError, errorTransient: false };
        return;
      }
      const mediaError = mediaInputAdmissionError(provider, request.messages);
      if (mediaError) {
        yield { type: 'error', error: mediaError, errorTransient: false };
        return;
      }

      // Consecutive same-model retries used for transient failures. Declared
      // outside the attempt loop so the exhausted error banner can report the
      // total attempt count honestly.
      let attempt = 0;
      // Native tool results completed in earlier attempts of this turn. On a
      // mid-turn transport failure the retried attempt resumes with these in
      // context instead of redoing finished work. Codex-family only: strict
      // API providers reject orphan `tool` messages.
      const carriedToolLedger = new Map<string, ProviderMessage>();
      const isCodexFamily = provider.name === 'codex' || provider.name === 'codex-auth';
      try {
        for (;;) {
          const attemptStartedAt = performance.now();
          let firstContentAt: number | undefined;
          let hasContent = false;
          let accTokensIn = 0;
          let accTokensOut = 0;
          let accTokensCacheExcluded = 0;
          let accTokensCacheRead: number | undefined;
          let accTokensCacheWrite: number | undefined;
          let accBillingTokensIn: number | undefined;
          let accBillingTokensOut: number | undefined;
          let accReportedCostUsd: number | undefined;
          let accBillingUsageSamples: ProviderEvent['billingUsageSamples'];
          let usageAccountId: string | undefined;
          // A yielded error event the loop chose to suppress for a same-model
          // retry (set instead of surfacing it to the caller).
          let yieldedRetriable: string | undefined;
          // A terminal retriable error already surfaced with an honest banner.
          let terminalSurfaced = false;
          // An error event already yielded to the caller this attempt. When
          // set, the empty-response fallback below stays silent so the turn
          // ends with the single real banner instead of two stacked errors.
          let surfacedError = false;
          try {
            const stream = provider.streamResponse({
              ...enforceChatProviderIsolation(provider.name, request),
              model: currentModel,
              ...(isCodexFamily && carriedToolLedger.size > 0
                ? { messages: [...request.messages, ...carriedToolLedger.values()] }
                : {}),
            });

            for await (const event of withBridgeWorkspace(request.workingDirectory, stream)) {
              if (event.type === 'error' && !request.signal?.aborted) {
                const message = typeof event.error === 'string' ? event.error : '';
                // `errorTransient` is the provider's own verdict, computed from
                // the raw failure. Text matching stays as the fallback for
                // adapters that only surface a message.
                const retriable =
                  event.errorTransient === true ||
                  (message.length > 0 && this.isRetriableProviderError(message));
                if (message && retriable) {
                  if (attempt < SAME_MODEL_MAX_RETRIES) {
                    // Transient yielded error (the Codex path: nonzero exit
                    // does not throw). Suppress it — the caller must not see
                    // an error for an attempt we are about to retry — and
                    // re-run the same model with backoff. Breaking the
                    // for-await closes the finished provider generator.
                    yieldedRetriable = message;
                    break;
                  }
                  if (
                    (provider.name === 'codex' || provider.name === 'codex-auth') &&
                    isTransientCodexFailure(message)
                  ) {
                    // Retries exhausted: a single honest banner with the
                    // attempt count instead of the raw stderr plus a duplicate
                    // empty-response error below.
                    yield {
                      type: 'error',
                      error: codexTransientExhaustedMessage(attempt + 1),
                    };
                    terminalSurfaced = true;
                    break;
                  }
                  if (attempt > 0) {
                    // Same honesty for every other provider: the user sees the
                    // provider's own reason plus how many retries already ran,
                    // instead of a bare failure that looks like a config error.
                    // Reaching here means the retry budget is spent, so `attempt`
                    // is always the number of retries already made.
                    yield {
                      type: 'error',
                      error: transientExhaustedMessage(message, attempt + 1),
                    };
                    terminalSurfaced = true;
                    break;
                  }
                }
              }
              if (this.isContentEvent(event)) {
                hasContent = true;
                firstContentAt ??= performance.now();
              }
              if (event.type === 'error') surfacedError = true;
              if (isCodexFamily && event.type === 'tool_executed' && event.toolName) {
                // Record before yielding so an aborted consumer still leaves
                // resume context for the retry. Latest result wins per tool.
                const input = typeof event.toolInput === 'string' ? event.toolInput : '';
                const output = typeof event.toolOutput === 'string' ? event.toolOutput : '';
                carriedToolLedger.set(
                  carriedToolKey(event.toolName, input),
                  toCarriedToolMessage(event.toolName, input, output, event.isError === true),
                );
                while (carriedToolLedger.size > CARRIED_TOOL_RESULTS_MAX) {
                  const oldest = carriedToolLedger.keys().next();
                  if (oldest.done) break;
                  carriedToolLedger.delete(oldest.value);
                }
              }
              if (event.type === 'usage_update') {
                if (event.reportedCostUsd !== undefined) accReportedCostUsd = event.reportedCostUsd;
                if (typeof event.tokensIn === 'number') accTokensIn = event.tokensIn;
                if (typeof event.tokensOut === 'number') accTokensOut = event.tokensOut;
                if (typeof event.tokensCache === 'number') {
                  accTokensCacheExcluded = event.tokensCache;
                }
                if (typeof event.tokensCacheRead === 'number') {
                  accTokensCacheRead = event.tokensCacheRead;
                }
                if (typeof event.tokensCacheWrite === 'number') {
                  accTokensCacheWrite = event.tokensCacheWrite;
                }
                if (typeof event.billingTokensIn === 'number') {
                  accBillingTokensIn = event.billingTokensIn;
                }
                if (typeof event.billingTokensOut === 'number') {
                  accBillingTokensOut = event.billingTokensOut;
                }
                if (event.billingUsageSamples) {
                  accBillingUsageSamples = event.billingUsageSamples;
                }
                if (event.accountId) usageAccountId = event.accountId;
              }
              yield event;
            }
          } catch (streamError: unknown) {
            if (
              attempt < SAME_MODEL_MAX_RETRIES &&
              !request.signal?.aborted &&
              this.isRetriableProviderError(streamError)
            ) {
              attempt += 1;
              const retryCause = this.recordRetryCause(provider.name, streamError);
              providerLog.warn(
                { provider: provider.name, model: currentModel, attempt, cause: retryCause },
                'Transient provider throw — retrying same model',
              );
              await this.waitForSameModelRetry(attempt, request.signal);
              continue;
            }
            throw streamError;
          }

          if (yieldedRetriable !== undefined) {
            attempt += 1;
            const retryCause = this.recordRetryCause(provider.name, yieldedRetriable);
            providerLog.warn(
              {
                provider: provider.name,
                model: currentModel,
                attempt,
                cause: retryCause,
                resumedTools: carriedToolLedger.size,
              },
              'Transient provider error — retrying same model',
            );
            await this.waitForSameModelRetry(attempt, request.signal);
            continue;
          }

          if (terminalSurfaced) {
            this.recordFailure(provider.name);
            return;
          }

          if (hasContent) {
            const completedAt = performance.now();
            const latencyMs = Math.max(0, completedAt - attemptStartedAt);
            const ttftMs =
              firstContentAt === undefined
                ? undefined
                : Math.max(0, firstContentAt - attemptStartedAt);
            // A successful provider turn is the strongest account proof we have.
            // Local files, env vars, and CLI presence remain "detected" until the
            // provider actually accepts a request; after that, Billing and
            // Settings may truthfully show the connection as active.
            const checkedAt = Date.now();
            const providerConfig = this.providerConfigs.get(provider.name);
            const scope: ProviderVerificationScope = providerConfig?.custom
              ? 'runtime'
              : this.verificationScopeFor(provider.name);
            this.verificationRecords.set(provider.name, {
              state: 'verified',
              checkedAt,
              scope,
            });
            if (providerConfig) {
              providerConfig.lastVerifiedAt = checkedAt;
              providerConfig.lastVerificationScope = scope;
            }
            if (accBillingUsageSamples?.length) {
              for (const sample of accBillingUsageSamples) {
                creditRecordUsage(
                  currentModel,
                  provider.name,
                  sample.tokensIn,
                  sample.tokensOut,
                  {
                    accountId: usageAccountId,
                    sessionId: request.sessionId,
                  },
                  {
                    cacheReadTokens: sample.tokensCacheRead,
                    cacheWriteTokens: sample.tokensCacheWrite,
                    ttftMs,
                    latencyMs,
                  },
                );
              }
            } else {
              const recordedTokensIn = accBillingTokensIn ?? accTokensIn + accTokensCacheExcluded;
              const recordedTokensOut = accBillingTokensOut ?? accTokensOut;
              if (recordedTokensIn > 0 || recordedTokensOut > 0) {
                creditRecordUsage(
                  currentModel,
                  provider.name,
                  recordedTokensIn,
                  recordedTokensOut,
                  {
                    accountId: usageAccountId,
                    sessionId: request.sessionId,
                  },
                  {
                    reportedCostUsd: accReportedCostUsd,
                    cacheReadTokens: accTokensCacheRead,
                    cacheWriteTokens: accTokensCacheWrite,
                    ttftMs,
                    latencyMs,
                  },
                );
              }
            }
            this.recordSuccess(provider.name);
            return;
          }

          if (!surfacedError) {
            yield {
              type: 'error',
              error: `The model returned an empty response. The provider ${provider.name} did not stream any content before timing out or closing. Try again, switch model/provider, or split a large prompt.`,
            };
          }
          this.recordFailure(provider.name);
          return;
        }
      } catch (err: unknown) {
        const diagnostic = safeProviderDiagnostic(provider.name, 'stream', err);
        providerLog.error({ ...diagnostic, model: currentModel }, 'Provider error');
        this.recordFailure(provider.name);

        if (i === chain.length - 1) {
          if (
            (provider.name === 'codex' || provider.name === 'codex-auth') &&
            isTransientCodexFailure(err)
          ) {
            // Same-model retries exhausted on a thrown transient: same honest
            // banner as the yielded-error path. attempt counts retries used.
            yield {
              type: 'error',
              error: codexTransientExhaustedMessage(attempt + 1),
            };
            return;
          }
          yield {
            type: 'error',
            error: safeProviderFailureMessage(provider.name, diagnostic),
          };
          return;
        }
        providerLog.info('Trying next model in fallback chain');
      }
    }
  }

  private isContentEvent(event: ProviderEvent): boolean {
    return (
      event.type === 'content_delta' ||
      event.type === 'thinking_delta' ||
      event.type === 'tool_use_start'
    );
  }

  /** Abort-aware backoff between same-model retries. Shared with the auxiliary
   *  provider calls so every retry site uses one budget and one delay curve. */
  private waitForSameModelRetry(retryIndex: number, signal?: AbortSignal): Promise<void> {
    return waitForProviderRetry(retryIndex, signal);
  }

  /**
   * Validate provider credentials and retain a process-local verdict. The
   * record is updated only when probing the active config (or immediately
   * after setCredentials installs a newly verified config), so a rejected
   * replacement key cannot poison the last working provider's state.
   */
  async verifyConnection(
    name: ProviderName,
    credentials?: { apiKey?: string; authToken?: string; baseUrl?: string; deployment?: string },
    options: { runtimeCheck?: boolean } = {},
  ): Promise<ProviderVerificationResult> {
    const existing = this.providerConfigs.get(name);
    const probesActiveConfig =
      credentials == null ||
      ((credentials.apiKey ?? undefined) === (existing?.apiKey ?? undefined) &&
        (credentials.authToken ?? undefined) === (existing?.authToken ?? undefined) &&
        (credentials.baseUrl ?? undefined) === (existing?.baseUrl ?? undefined) &&
        (credentials.deployment ?? undefined) === (existing?.deployment ?? undefined));
    let result = await this.verifyConnectionInternal(name, credentials);
    if (!probesActiveConfig) return result;

    // A catalog probe cannot see plan entitlement, key scoping, or per-model
    // access. When the caller explicitly asked for a full check, close that gap
    // with one real generation. Never on the polled auto-connect path: that
    // would spend tokens on every status poll.
    if (options.runtimeCheck && result.success) {
      result = await this.applyRuntimeVerification(name, existing, result);
    }

    const previous = this.verificationRecords.get(name);
    const nextState = result.state ?? (result.success ? 'verified' : 'failed');
    if (previous?.state === 'verified') {
      if (result.success && nextState === 'detected') {
        return { success: true, state: 'verified' };
      }
      if (!result.success && !this.isDefinitiveVerificationFailure(result.error)) {
        return result;
      }
    }

    const checkedAt = Date.now();
    const scope = result.scope ?? this.verificationScopeFor(name);
    this.verificationRecords.set(name, {
      state: nextState,
      checkedAt,
      scope,
      ...(result.error && { error: result.error }),
    });
    if (nextState === 'verified' && existing) {
      existing.lastVerifiedAt = checkedAt;
      existing.lastVerificationScope = scope;
    } else if (
      nextState === 'failed' &&
      existing &&
      this.isDefinitiveVerificationFailure(result.error)
    ) {
      existing.lastVerifiedAt = undefined;
      existing.lastVerificationScope = undefined;
    }
    return result;
  }

  /**
   * Families that are verified by their own authority or have no completion
   * contract. Kept next to the CLI/unsupported sets it mirrors so the two lists
   * can be compared by eye.
   */
  private runtimeCheckIneligible(name: ProviderName, config: ProviderConfig): string | null {
    if (CLI_HARNESS_PROVIDERS.has(name) || MANAGED_CLI_PROVIDERS.has(name)) return 'CLI';
    if (LOCAL_PROVIDER_KEYS.has(name)) return 'local';
    // Capability-only providers are also absent from the chat surface, but the
    // dedicated reason is more useful to the settings UI than "unsupported".
    if (DEDICATED_CAPABILITY_PROVIDER_NAMES.has(name)) return 'capability-only';
    if (UNSUPPORTED_CHAT_PROVIDER_NAMES.has(name)) return 'unsupported';
    if (String(name).startsWith('remote-')) return 'remote';
    // Deployment-, project-, or OAuth-bound hosts verify their binding through
    // the catalog; a synthetic generation adds cost without adding evidence.
    if (name === 'azure' || name === 'azurecognitive' || name === 'bedrock') return 'deployment';
    if (name === 'vertexai' || name === 'sapai' || name === 'copilot') return 'hosted-resource';
    if (name === 'codex-auth' || name === 'codebuff') return 'own-authority';
    return null;
  }

  /**
   * Upgrade a catalog-level pass to a runtime-level one, or surface a
   * definitive refusal.
   *
   * A transient generation failure deliberately keeps the catalog verdict: a
   * rate-limited provider is not a misconfigured one, and reporting it as
   * broken would be a lie the user cannot act on.
   */
  private async applyRuntimeVerification(
    name: ProviderName,
    existing: ProviderConfig | undefined,
    catalogResult: ProviderVerificationResult,
  ): Promise<ProviderVerificationResult> {
    const config = existing;
    if (!config) return catalogResult;

    const ineligible = this.runtimeCheckIneligible(name, config);
    if (ineligible) return catalogResult;

    const adapter = this.createProvider(name, config);
    if (!adapter || !adapter.isAvailable()) return catalogResult;

    const outcome = await verifyRuntimeCompletion(name, adapter);
    if (outcome.kind === 'skipped') return catalogResult;

    if (outcome.kind === 'generated') {
      // 'runtime' is the strongest scope: the account produced a completion.
      return { success: true, state: 'verified', scope: 'runtime' };
    }

    if (outcome.kind === 'refused') {
      return { success: false, state: 'failed', error: outcome.error };
    }

    // Transient: preserve the catalog verdict, but carry the reason so the
    // settings note can say the generation check was inconclusive.
    return {
      success: true,
      state: catalogResult.state,
      scope: catalogResult.scope,
      error: outcome.error,
    };
  }

  private async verifyConnectionInternal(
    name: ProviderName,
    credentials?: { apiKey?: string; authToken?: string; baseUrl?: string; deployment?: string },
  ): Promise<ProviderVerificationResult> {
    const unavailableReason = unavailableProviderReason(name);
    if (unavailableReason) return { success: false, error: unavailableReason };

    const existing = this.providerConfigs.get(name);
    const apiKey = credentials?.apiKey ?? existing?.apiKey;
    const authToken = credentials?.authToken ?? existing?.authToken;
    const baseUrl = credentials?.baseUrl ?? existing?.baseUrl;
    const deployment = credentials?.deployment ?? existing?.deployment;
    const shouldMutateStoredState =
      credentials == null ||
      ((credentials.apiKey ?? undefined) === (existing?.apiKey ?? undefined) &&
        (credentials.authToken ?? undefined) === (existing?.authToken ?? undefined) &&
        (credentials.baseUrl ?? undefined) === (existing?.baseUrl ?? undefined) &&
        (credentials.deployment ?? undefined) === (existing?.deployment ?? undefined));

    try {
      if (existing?.custom || this.customProviderIds.has(name)) {
        const probe = await probeCustomProvider({
          kind: existing?.kind,
          adapter: existing?.adapter,
          baseUrl: baseUrl ?? '',
          apiKey,
          authToken,
          headers: existing?.headers,
        });
        return probe.success
          ? { success: true, state: 'detected', scope: 'catalog' }
          : { success: false, error: probe.error };
      }
      switch (name) {
        case 'claude': {
          // Claude Code subscription is verified by confirming the official CLI is
          // logged in. We never validate a raw token against the API — the CLI owns
          // auth and runs every request, keeping us compliant with Anthropic's terms.
          const claudeBin = whichBinary('claude');
          if (!claudeBin) {
            return {
              success: false,
              error: 'Claude Code CLI (claude) was not found on PATH. Install it, then reconnect.',
            };
          }
          if (!detectClaudeCodeLogin()) {
            return {
              success: false,
              error:
                'No Claude Code login material was detected. Run "claude login" in your terminal, then check again.',
            };
          }
          if (!(await probeCliConnection(claudeBin, 'claude'))) {
            return {
              success: true,
              state: 'detected',
              error:
                'Claude Code CLI was found on PATH with login material but did not pass its connection probe. The local login may be expired, unavailable, or the CLI installation may be broken.',
            };
          }
          return { success: true, state: 'verified' };
        }
        case 'grok': {
          const grokBin = whichBinary('grok');
          if (!grokBin) {
            return {
              success: false,
              error: 'Grok Build CLI (grok) was not found on PATH. Install it, then reconnect.',
            };
          }
          if (!detectGrokCLILogin()) {
            return {
              success: false,
              error:
                'No Grok Build login material was detected. Install the grok CLI, run "grok login", then check again.',
            };
          }
          if (!(await probeCliConnection(grokBin, 'grok'))) {
            return {
              success: true,
              state: 'detected',
              error:
                'Grok Build CLI was found on PATH with login material but did not pass its connection probe. The local login may be expired, unavailable, or the CLI installation may be broken.',
            };
          }
          return { success: true, state: 'verified' };
        }
        case 'codebuddy': {
          const cbBin = whichBinary('codebuddy');
          if (!cbBin) {
            return {
              success: false,
              error: 'CodeBuddy CLI (codebuddy) was not found on PATH. Install it, then reconnect.',
            };
          }
          if (!detectCodeBuddyCLILogin()) {
            return {
              success: false,
              error:
                'No CodeBuddy login material was detected. Complete the interactive `codebuddy` login, then check again.',
            };
          }
          if (!(await probeCliConnection(cbBin, 'codebuddy'))) {
            return {
              success: true,
              state: 'detected',
              error:
                'CodeBuddy CLI was found on PATH with login material but did not pass its connection probe. The local login may be expired, unavailable, or the CLI installation may be broken.',
            };
          }
          return { success: true, state: 'verified' };
        }
        case 'workbuddy-desktop': {
          // The desktop app owns its auth. Installing it IS the verification:
          // there is no token or key to check, and the runtime either attaches
          // to the running app or starts the app's bundled runtime itself.
          const app = locateWorkBuddyDesktopApp();
          if (!app) {
            return {
              success: false,
              error:
                'WorkBuddy AI is not installed. Install the desktop app (or set ' +
                'WORKBUDDY_DESKTOP_APP_PATH to its install root), then check again.',
            };
          }
          const wbRuntime = resolveWorkBuddyDesktopRuntime(app);
          if (!wbRuntime) {
            return {
              success: false,
              error:
                'WorkBuddy AI is installed but its bundled runtime is missing. ' +
                'Reinstall the desktop app, then check again.',
            };
          }
          return { success: true, state: 'verified' };
        }
        case 'antigravity': {
          const agyBin = whichBinary('agy');
          if (!agyBin) {
            return {
              success: false,
              error: 'Antigravity CLI (agy) was not found on PATH. Install it, then reconnect.',
            };
          }
          if (!detectAntigravityCLILogin()) {
            return {
              success: false,
              error:
                'No Antigravity login material was detected. Install agy, run "agy login", then check again.',
            };
          }
          if (!(await probeCliConnection(agyBin, 'antigravity'))) {
            return {
              success: true,
              state: 'detected',
              error:
                'Antigravity CLI was found on PATH with login material but did not pass its connection probe. The local login may be expired, unavailable, or the CLI installation may be broken.',
            };
          }
          return { success: true, state: 'verified' };
        }
        case 'cursor': {
          // Subscription CLI harness — no API key; the logged-in cursor-agent
          // binary authenticates itself.
          const cursorBin = whichBinary('cursor-agent');
          if (!cursorBin) {
            return {
              success: false,
              error: 'Cursor CLI (cursor-agent) was not found on PATH. Install it, then reconnect.',
            };
          }
          if (!detectCursorCLILogin()) {
            return {
              success: false,
              error:
                'No Cursor login material was detected. Install cursor-agent, run "cursor-agent login", then check again.',
            };
          }
          if (!(await probeCliConnection(cursorBin, 'cursor'))) {
            return {
              success: true,
              state: 'detected',
              error:
                'Cursor CLI was found on PATH with login material but did not pass its connection probe. The local login may be expired, unavailable, or the CLI installation may be broken.',
            };
          }
          return { success: true, state: 'verified' };
        }
        case 'devin': {
          const devinBin = whichBinary('devin');
          if (!devinBin) {
            return {
              success: false,
              error: 'Devin CLI (devin) was not found on PATH. Install it, then reconnect.',
            };
          }
          if (!detectDevinCLILogin()) {
            return {
              success: false,
              error:
                'No Devin login material was detected. Install devin, run "devin auth login", then check again.',
            };
          }
          if (!(await probeCliConnection(devinBin, 'devin'))) {
            return {
              success: true,
              state: 'detected',
              error:
                'Devin CLI was found on PATH with login material but did not pass its connection probe. The local login may be expired, unavailable, or the CLI installation may be broken.',
            };
          }
          return { success: true, state: 'verified' };
        }
        case 'freebuff': {
          // Use the same multi-account/reference discovery as actual execution;
          // never extract a CLI token merely to decide whether setup exists.
          if (!discoverFreebuffAccounts().length) {
            return {
              success: false,
              error:
                'Freebuff CLI login material was not found. Run "freebuff login" in your terminal, then reconnect.',
            };
          }
          const isolation = await ensureFreebuffRuntimeReady();
          if (!isolation.available) {
            return {
              success: false,
              error:
                isolation.reason ?? 'Freebuff mandatory Linux bubblewrap runtime is unavailable.',
            };
          }
          const runtime = new FreebuffProvider({
            name: 'freebuff',
            authToken: authToken || 'cli:freebuff:detected',
            baseUrl: '',
            disabled: false,
          });
          const models = await runtime.refreshModels(true);
          if (!runtime.isAvailable()) {
            return {
              success: false,
              error:
                runtime.getModelDiscoveryError() ??
                'Freebuff native CLI executable or login is unavailable.',
            };
          }
          // Authentication belongs to the CLI account/runtime, not to the
          // optional entitlement catalog. Keep a valid login connected when a
          // catalog request is temporarily unavailable; the model picker can
          // show the discovery error and retry independently.
          if (
            !runtime.getModelDiscoveryError() &&
            models.some((model) => model.apiModelId?.startsWith('freebuff/catalog-'))
          ) {
            return { success: true, state: 'verified', scope: 'catalog' };
          }
          return {
            success: true,
            state: 'verified',
            scope: 'account',
          };
        }
        case 'omnirush': {
          const omnirushBin = whichBinary('omnirush');
          if (!omnirushBin) {
            return {
              success: false,
              error: 'Omnirush CLI (omnirush) was not found on PATH. Install it, then reconnect.',
            };
          }
          if (!detectOmnirushCLILogin()) {
            return {
              success: false,
              error:
                'No Omnirush login material was detected. Run `omnirush login` in your terminal, then check again.',
            };
          }
          if (!(await probeCliConnection(omnirushBin, 'omnirush'))) {
            return {
              success: true,
              state: 'detected',
              error:
                'Omnirush CLI was found on PATH with login material but its `whoami` probe failed. The session may be expired or the CLI may be unable to reach Omnirush.',
            };
          }
          return { success: true, state: 'verified' };
        }
        case 'opencode': {
          const opencodeBin = whichBinary('opencode');
          if (!opencodeBin) {
            return {
              success: false,
              error:
                'OpenCode CLI (opencode) was not found on PATH. Install it from https://opencode.ai, then reconnect.',
            };
          }
          if (!detectOpenCodeCLILogin()) {
            return {
              success: false,
              error:
                'No OpenCode login material was detected. Run "opencode auth login" in your terminal, then check again.',
            };
          }
          if (!(await probeCliConnection(opencodeBin, 'opencode'))) {
            return {
              success: true,
              state: 'detected',
              error:
                'OpenCode CLI was found on PATH with login material but its `models` probe failed. The CLI may be unable to reach its catalog; the login may be expired or the installation broken.',
            };
          }
          return { success: true, state: 'verified' };
        }
        case 'codebuff': {
          if (!apiKey) return { success: false, error: 'Missing Codebuff API key' };
          const response = await fetch('https://www.codebuff.com/api/v1/me?fields=id,email', {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (response.ok) return { success: true, state: 'verified' };
          return {
            success: false,
            error: safeVerificationHttpError(response.status, 'Codebuff account verification'),
          };
        }
        case 'hoplite': {
          // Hoplite is a cloud async-agent control plane, not a chat API. Its
          // organization-scoped key is proven against the live project catalog
          // (/api/projects); delegation itself is a later release.
          if (!apiKey) return { success: false, error: 'Missing Hoplite API key' };
          const response = await fetch('https://api.hoplite.sh/api/projects', {
            headers: {
              'X-Api-Key': apiKey,
              'Content-Type': 'application/json',
              'User-Agent': 'Koryphaios/1.0',
            },
            signal: AbortSignal.timeout(10_000),
          });
          if (response.ok) return { success: true, state: 'verified', scope: 'catalog' };
          const body = (await response.text().catch(() => '')).slice(0, 200);
          if (response.status === 401 || response.status === 403) {
            return {
              success: false,
              error: `Hoplite rejected this API key (HTTP ${response.status}). Create an organization API key (hop_…) in app.hoplite.sh organization settings, then reconnect.${body ? ` Hoplite said: ${body}` : ''}`,
            };
          }
          return {
            success: false,
            error: `${safeVerificationHttpError(response.status, 'Hoplite connection verification')}${body ? ` Body: ${body}` : ''}`,
          };
        }
        case 'anthropic': {
          if (!apiKey && !authToken)
            return { success: false, error: 'Missing apiKey or authToken' };
          const { headers } = buildAuthHeaders(name, { apiKey, authToken });
          const url =
            getVerifyUrl(name, undefined, { apiKey, authToken }) ||
            `${PROVIDER_BASE_URLS.anthropic}/models`;
          const res = await this.verifyModelCatalogWithStatus(
            url,
            { method: 'GET', headers },
            'openai',
          );
          if (res.success) return { success: true };
          if (res.status === 401 && shouldMutateStoredState) {
            this.markKeyInvalid(name, res.error ?? 'Unauthorized');
            const config = this.providerConfigs.get(name);
            if (config) {
              config.disabled = true;
              this.providers.delete(name);
            }
          }
          return { success: false, error: res.error };
        }
        case 'openai':
          return this.verifyBearerGet('https://api.openai.com/v1/models', apiKey);
        case 'codex-auth': {
          try {
            // This runs while connecting, before the provider instance exists.
            // The official app-server is the OAuth authority, so query it directly.
            const account = await getManagedCodexAppServer().account(true);
            return account.account?.type === 'chatgpt'
              ? { success: true }
              : { success: false, error: 'OpenAI Codex is not signed in with ChatGPT' };
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Could not verify OpenAI Codex',
            };
          }
        }
        case 'google':
        case 'aistudio': {
          if (!apiKey && !authToken)
            return { success: false, error: 'Missing apiKey or authToken' };
          // Gemini 3.1 / Thinking: v1beta often required; support ?key= and x-goog-api-key as fallbacks.
          const creds = { apiKey, authToken };
          const tryUrl = (base: string, useHeader: boolean) => {
            const path = `${base.replace(/\/?$/, '')}/models`;
            if (useHeader) {
              const { headers } = buildAuthHeaders(name, creds, { useGeminiHeader: true });
              return this.verifyModelCatalogWithStatus(path, { method: 'GET', headers }, 'gemini');
            }
            const urlWithKey = `${path}?key=${encodeURIComponent(apiKey!)}`;
            return this.verifyModelCatalogWithStatus(
              urlWithKey,
              {
                method: 'GET',
                headers: { 'Content-Type': 'application/json', 'User-Agent': 'Koryphaios/1.0' },
              },
              'gemini',
            );
          };
          let result = await tryUrl(GEMINI_V1BETA_BASE, false);
          if (result.success) return { success: true };
          if (result.status === 401 && shouldMutateStoredState) {
            this.markKeyInvalid(name, result.error ?? 'Unauthorized');
            const config = this.providerConfigs.get(name);
            if (config) {
              config.disabled = true;
              this.providers.delete(name);
            }
            return { success: false, error: result.error };
          }
          if (result.status === 404) {
            result = await tryUrl(GEMINI_V1BETA_BASE, true);
            if (result.success) return { success: true };
            result = await tryUrl(GEMINI_V1_BASE, false);
            if (result.success) {
              try {
                const { getDb } = require('../db');
                getDb()
                  .prepare(
                    'INSERT OR REPLACE INTO provider_endpoint_override (provider, base_url, updated_at) VALUES (?, ?, ?)',
                  )
                  .run(name, GEMINI_V1_BASE, Date.now());
              } catch (err: unknown) {
                serverLog.debug(
                  { err: err instanceof Error ? err.message : String(err) },
                  'Failed to persist Gemini v1 endpoint override (DB not initialized)',
                );
                // DB not initialized
              }
              return { success: true };
            }
          }
          return { success: false, error: result.error };
        }
        case 'copilot': {
          const token = authToken;
          if (!token) return { success: false, error: 'GitHub Copilot token not found' };
          const bearer = await exchangeGitHubTokenForCopilotAsync(token);
          if (!bearer)
            return { success: false, error: 'Failed to exchange GitHub token for Copilot bearer' };
          return this.verifyModelCatalog(
            'https://api.githubcopilot.com/models',
            {
              headers: {
                Authorization: `Bearer ${bearer}`,
                'Editor-Version': 'vscode/1.100.0',
                'Editor-Plugin-Version': 'copilot-chat/0.27.0',
                'Copilot-Integration-Id': 'vscode-chat',
                'User-Agent': 'Koryphaios/1.0',
              },
            },
            'openai',
          );
        }
        case 'notion': {
          if (!apiKey)
            return { success: false, error: 'Notion requires a Personal Access Token (PAT)' };
          // POST /agents/query is the documented discovery surface: 200 proves
          // the PAT authenticates; the body is kept minimal for a cheap probe.
          try {
            const response = await fetch(`${NOTION_BASE_URL}/agents/query`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiKey}`,
                'Notion-Version': NOTION_API_VERSION,
                'Content-Type': 'application/json',
                'User-Agent': 'Koryphaios/1.0',
              },
              body: JSON.stringify({ page_size: 1 }),
              signal: AbortSignal.timeout(5_000),
            });
            if (!response.ok)
              return { success: false, error: safeVerificationHttpError(response.status) };
            return { success: true };
          } catch {
            return { success: false, error: 'Provider verification failed safely.' };
          }
        }
        case 'openrouter':
          return this.verifyModelCatalog(
            'https://openrouter.ai/api/v1/models',
            {
              headers: {
                Authorization: `Bearer ${apiKey}`,
                ...withOpenRouterAttribution(),
              },
            },
            'openai',
          );
        case 'github-models': {
          const token = apiKey || authToken;
          if (!token) return { success: false, error: 'Missing GitHub token' };
          return this.verifyGitHubModelsCatalog(token);
        }
        case 'gitlab': {
          // No catalog or identity endpoint also proves Duo entitlement, so the
          // chat endpoint is the only honest probe.
          const probe = await verifyGitLabDuoAccess({
            ...(existing ?? { name: 'gitlab' }),
            name: 'gitlab',
            apiKey,
            authToken,
            baseUrl,
            disabled: false,
          } as ProviderConfig);
          return probe.success ? { success: true, state: 'verified', scope: 'endpoint' } : probe;
        }
        case 'kimicode': {
          const resolvedToken = await resolveKimiCodeAccessToken(authToken ?? apiKey ?? null);
          if (!resolvedToken) return { success: false, error: 'Missing authToken' };
          const base = baseUrl?.replace(/\/+$/, '') || 'https://api.kimi.com/coding/v1';
          return this.verifyModelCatalog(
            `${base}/models`,
            {
              method: 'GET',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${resolvedToken}`,
              },
            },
            'openai',
          );
        }
        case 'mistral':
          return this.verifyBearerGet('https://api.mistral.ai/v1/models', apiKey);
        case 'workbuddy':
          // TokenHub gateway: GET /v1/models is the documented low-cost probe
          // (an invalid key returns 401 gateway_error on every endpoint).
          return this.verifyBearerGet(
            'https://tokenhub-intl.tencentcloudmaas.com/v1/models',
            apiKey,
          );
        case 'groq':
          return this.verifyBearerGet('https://api.groq.com/openai/v1/models', apiKey);
        case 'deepgram':
          if (!apiKey) return { success: false, error: 'Missing API key' };
          return this.verifyCapabilityGet(
            `${(baseUrl || 'https://api.deepgram.com/v1').replace(/\/$/, '')}/projects`,
            { Authorization: `Token ${apiKey}` },
          );
        case 'assemblyai':
          if (!apiKey) return { success: false, error: 'Missing API key' };
          return this.verifyCapabilityGet(
            `${(baseUrl || 'https://api.assemblyai.com/v2').replace(/\/$/, '')}/account`,
            { Authorization: apiKey },
          );
        case 'xai':
          return this.verifyBearerGet('https://api.x.ai/v1/models', apiKey);
        case 'azure': {
          if (!apiKey && !authToken)
            return { success: false, error: 'Missing apiKey or authToken' };
          if (apiKey && authToken) {
            return {
              success: false,
              error:
                'Azure OpenAI accepts either an API key or a Microsoft Entra bearer token, not both. Disconnect the existing credential before switching auth modes.',
            };
          }
          if (!baseUrl) return { success: false, error: 'Missing baseUrl' };
          if (!deployment) {
            return {
              success: false,
              error:
                'Azure OpenAI requires the deployment name you created. A base model id is not a deployment.',
            };
          }
          const trimmed = baseUrl.replace(/\/+$/, '');
          const headers: Record<string, string> = {};
          if (apiKey) headers['api-key'] = apiKey;
          if (authToken) headers.Authorization = `Bearer ${authToken}`;
          const catalog = await this.verifyModelCatalog(
            `${trimmed}/openai/models?api-version=2024-10-21`,
            { headers },
            'openai',
          );
          // The data-plane model catalog can validate the resource credential,
          // but it cannot prove that the user-entered deployment exists. Keep
          // the adapter usable while reporting the deployment as detected,
          // never verified, until an actual inference succeeds.
          return catalog.success ? { success: true, state: 'detected' } : catalog;
        }
        case 'local': {
          if (!baseUrl) return { success: false, error: 'Missing baseUrl' };
          const trimmed = baseUrl.replace(/\/+$/, '');
          return this.verifyModelCatalog(`${trimmed}/models`, undefined, 'openai');
        }
        case 'ollama': {
          if (!baseUrl)
            return { success: false, error: 'Missing baseUrl (e.g. http://localhost:11434)' };
          const trimmed = baseUrl.replace(/\/+$/, '');
          return this.verifyModelCatalog(`${trimmed}/api/tags`, undefined, 'ollama');
        }
        case 'bedrock': {
          const hasStoredAwsCreds = !!(existing?.apiKey && existing?.authToken);
          if (!this.hasBedrockEnvironment() && !hasStoredAwsCreds) {
            return {
              success: false,
              error:
                'No AWS credential source detected on this system. Enter an access key ID and secret access key, or configure the AWS CLI.',
            };
          }
          const provider = new BedrockProvider({
            ...(existing ?? { name: 'bedrock' }),
            name: 'bedrock',
            disabled: false,
          } as ProviderConfig);
          return provider.verifyAccess();
        }
        case 'vertexai':
          if (!apiKey)
            return {
              success: false,
              error:
                'Vertex AI requires an explicit API key (set GOOGLE_VERTEX_AI_API_KEY or add apiKey in settings)',
            };
          return this.verifyVertexExpressKey(apiKey);
        case 'codex': {
          const codexBin = whichBinary('codex');
          if (!codexBin) {
            return {
              success: false,
              error: 'Codex CLI (codex) was not found on PATH. Install it, then reconnect.',
            };
          }
          if (
            !detectCodexCLILogin() &&
            !discoverCliAccounts().some((account) => account.provider === 'codex')
          ) {
            return {
              success: false,
              error:
                'No Codex CLI login material was detected. Run "codex login" in your terminal, then check again.',
            };
          }
          if (!(await probeCliConnection(codexBin, 'codex'))) {
            return {
              success: true,
              state: 'detected',
              error:
                'Codex CLI was found on PATH with login material but did not pass its connection probe. The local login may be expired, unavailable, or the CLI installation may be broken.',
            };
          }
          return { success: true, state: 'verified' };
        }
        case 'opencodezen': {
          if (!apiKey)
            return { success: false, error: 'Missing API key (get one at opencode.ai/auth)' };
          const base = 'https://opencode.ai/zen/v1';
          return this.verifyBearerGet(`${base}/models`, apiKey);
        }
        case 'opencodego': {
          if (!apiKey)
            return {
              success: false,
              error: 'Missing API key — subscribe to OpenCode Go at opencode.ai/auth',
            };
          const base = 'https://opencode.ai/zen/go/v1';
          return this.verifyBearerGet(`${base}/models`, apiKey);
        }
        case 'llamacpp': {
          const url = baseUrl ?? LLAMACPP_DEFAULT;
          if (!url)
            return { success: false, error: 'Missing baseUrl (e.g. http://127.0.0.1:8080/v1)' };
          return this.verifyModelCatalog(
            `${url.replace(/\/v1\/?$/, '')}/v1/models`,
            undefined,
            'openai',
          );
        }
        case 'lmstudio': {
          const url = baseUrl ?? LMSTUDIO_DEFAULT;
          if (!url)
            return { success: false, error: 'Missing baseUrl (e.g. http://localhost:1234/v1)' };
          return this.verifyModelCatalog(
            `${url.replace(/\/v1\/?$/, '')}/v1/models`,
            undefined,
            'openai',
          );
        }
        case 'azurecognitive': {
          if (!apiKey) return { success: false, error: 'Missing API key' };
          if (!baseUrl)
            return {
              success: false,
              error: 'Missing baseUrl (e.g. https://YOUR_RESOURCE.cognitiveservices.azure.com)',
            };
          if (!deployment) {
            return {
              success: false,
              error:
                'Azure Cognitive requires the deployment name you created. A base model id is not a deployment.',
            };
          }
          const trimmed = baseUrl.replace(/\/+$/, '');
          const catalog = await this.verifyModelCatalog(
            `${trimmed}/openai/models?api-version=2024-10-21`,
            { headers: { 'api-key': apiKey } },
            'openai',
          );
          return catalog.success ? { success: true, state: 'detected' } : catalog;
        }
        case 'sapai': {
          if (!apiKey && !authToken) {
            return { success: false, error: 'Missing SAP service key JSON or bearer token' };
          }
          return verifySapAiConnection({
            ...(existing ?? { name: 'sapai' }),
            name: 'sapai',
            apiKey,
            authToken,
            baseUrl,
            deployment,
            disabled: false,
          } as ProviderConfig);
        }
        case 'zai': {
          // Z.AI: https://api.z.ai/api/paas/v4 (Standard) or .../api/coding/paas/v4 (Coding Plan) or open.bigmodel.cn (China)
          if (!apiKey) return { success: false, error: 'Missing API key' };
          const base = baseUrl?.replace(/\/+$/, '') ?? 'https://api.z.ai/api/paas/v4';
          return this.verifyHttp(`${base}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: 'glm-4.5',
              messages: [{ role: 'user', content: 'Hi' }],
              max_tokens: 1,
            }),
          });
        }
        default: {
          // Dedicated non-chat backends (media, retrieval, memory) verify
          // against their own adapter endpoint. The OpenAI-compatible
          // `/models` probe below would fail for all of them, because none
          // publishes a chat-completions surface, and reporting that as a
          // broken credential would be a lie.
          const capabilityAdapter = getCapabilityAdapter(name);
          if (capabilityAdapter) {
            const resolved = resolveCapabilityConfig(capabilityAdapter, {
              apiKey,
              authToken,
              baseUrl,
            });
            const outcome = await capabilityAdapter.verify(resolved);
            if (outcome.ok) return { success: true, state: 'verified' };
            return {
              success: false,
              state: 'failed',
              error: outcome.error ?? `${name} verification failed.`,
            };
          }

          const defaultBase = providerDefaultBaseUrl(name);
          // A configured base URL that is present but blank (the Settings UI and
          // the shipped koryphaios.json both write `""`) must fall back to the
          // provider's own default. `??` treats "" as a real value, which
          // silently produced "Unsupported provider" for every built-in
          // OpenAI-compatible provider whose default URL is known.
          const effectiveBase = baseUrl?.trim() || defaultBase;
          const effectiveApiKey = apiKey?.trim() || authToken?.trim();

          // Universal OpenAI-compatible verification
          if (effectiveBase && effectiveApiKey) {
            return this.verifyBearerGet(
              `${effectiveBase.replace(/\/?$/, '')}/models`,
              effectiveApiKey,
            );
          }

          if (effectiveBase) return { success: false, error: 'Missing API key' };
          return { success: false, error: `Unsupported provider: ${name}` };
        }
      }
    } catch (err: unknown) {
      return { success: false, error: 'Provider verification failed safely.' };
    }
  }

  /** Set/update provider credentials. */
  async setCredentials(
    name: ProviderName,
    credentials: {
      apiKey?: string;
      authToken?: string;
      baseUrl?: string;
      deployment?: string;
      awsRegion?: string;
      awsSessionToken?: string;
      selectedModels?: string[];
      hideModelSelector?: boolean;
      contextWindow?: number;
    },
    options: { fullCheck?: boolean; preferenceOnly?: boolean; autoDetected?: boolean } = {},
  ): Promise<{ success: boolean; error?: string; credentialsRetained?: boolean }> {
    try {
      if (!this.getVisibleProviderNames().includes(name)) {
        return { success: false, error: 'Unknown provider' };
      }
      const unavailableReason = unavailableProviderReason(name);
      if (unavailableReason) return { success: false, error: unavailableReason };

      const existing = this.providerConfigs.get(name);
      const isEnvAuth = this.authModeFor(name) === 'env_auth';

      // Material the caller passed explicitly marks a user-owned connection;
      // autoDetectProviders passes nothing it did not find on the machine.
      const userSuppliedMaterial = !!(
        credentials.apiKey?.trim() ||
        credentials.authToken?.trim() ||
        credentials.baseUrl?.trim()
      );
      if (options.autoDetected !== true && userSuppliedMaterial) {
        this.autoDetectedSources.delete(name);
      }
      const nextAutoDetected =
        options.autoDetected === true
          ? true
          : userSuppliedMaterial
            ? undefined
            : existing?.autoDetected;

      // Auto-detect if blank. env_auth providers (Bedrock) never auto-bake
      // machine-level AWS credentials into the persisted config — the AWS SDK
      // resolves them from the standard credential chain at runtime. Only
      // explicit user-entered keys are stored.
      const resolvedApiKey =
        credentials.apiKey?.trim() ||
        existing?.apiKey ||
        (!isEnvAuth ? this.detectEnvKey(name) : null) ||
        undefined;
      // CLI harnesses own their credentials. A reconnect must re-read the local
      // CLI state, never ask the user to paste a token Koryphaios does not own.
      const localCliAuth = CLI_HARNESS_PROVIDERS.has(name) ? cliAutoEnableCreds(name) : null;
      const resolvedAuthToken = CLI_HARNESS_PROVIDERS.has(name)
        ? localCliAuth?.authToken
        : credentials.authToken?.trim() || existing?.authToken || undefined;
      const rawResolvedBaseUrl =
        credentials.baseUrl?.trim() || existing?.baseUrl || this.detectEnvUrl(name) || undefined;
      let resolvedBaseUrl = rawResolvedBaseUrl;
      if (rawResolvedBaseUrl && name === 'gitlab') {
        // Store the canonical API root so the settings field round-trips the
        // same value it shows, whatever shape was pasted in.
        try {
          resolvedBaseUrl = normalizeGitLabBaseUrl(rawResolvedBaseUrl);
        } catch (error: unknown) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'GitLab instance URL is invalid',
          };
        }
      }
      if (existing?.custom && rawResolvedBaseUrl) {
        try {
          resolvedBaseUrl = normalizeCustomProviderBaseUrl(rawResolvedBaseUrl);
        } catch (error: unknown) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Custom provider endpoint is invalid',
          };
        }
      }
      const resolvedDeployment =
        credentials.deployment?.trim() || existing?.deployment || undefined;
      const resolvedAwsRegion = credentials.awsRegion?.trim() || existing?.awsRegion || undefined;
      const resolvedAwsSessionToken =
        credentials.awsSessionToken?.trim() || existing?.awsSessionToken || undefined;

      // Return the CLI's actionable local state rather than the generic
      // auth-only validation error when there is no existing session marker.
      if (CLI_HARNESS_PROVIDERS.has(name) && !resolvedAuthToken) {
        return this.verifyConnection(name);
      }

      const nextConnection = {
        apiKey: resolvedApiKey,
        authToken: resolvedAuthToken,
        baseUrl: resolvedBaseUrl,
        deployment: resolvedDeployment,
        awsRegion: resolvedAwsRegion,
        awsSessionToken: resolvedAwsSessionToken,
      };

      const validation = this.validateCredentials(name, nextConnection, existing);
      if (!validation.success) return validation;

      const connectionChanged =
        existing?.apiKey !== nextConnection.apiKey ||
        existing?.authToken !== nextConnection.authToken ||
        existing?.baseUrl !== nextConnection.baseUrl ||
        existing?.deployment !== nextConnection.deployment ||
        existing?.awsRegion !== nextConnection.awsRegion ||
        existing?.awsSessionToken !== nextConnection.awsSessionToken;
      let acceptedState: ProviderConnectionState =
        this.verificationRecords.get(name)?.state ?? 'unknown';
      let acceptedScope: ProviderVerificationScope | undefined =
        this.verificationRecords.get(name)?.scope;

      // A CLI may have moved off PATH or lost its local login material since
      // its marker was saved. Re-evaluate that detection on every reconnect;
      // only a supported account probe may produce a verified state.
      // Re-probe only when connection material changed. CLI harnesses own
      // their credentials externally, so reconnects always re-read local CLI
      // state. Re-probing unchanged credentials adds no information — and for
      // custom endpoints (which can never exceed 'detected') the old
      // `state !== 'verified'` clause re-probed on EVERY save, so a
      // preference-only save (e.g. Manage Models) was rejected whenever the
      // endpoint hiccuped and the failure poisoned the stored record.
      //
      // `fullCheck` is the one exception: it is how "Run safe check" and an
      // explicit connect ask for a re-probe of *unchanged* stored credentials.
      // Without it that button was a no-op for API-key providers — it re-saved
      // the previous verdict, so a provider stuck on 'failed' stayed failed
      // forever no matter how many times the user clicked it.
      if (
        !options.preferenceOnly &&
        (connectionChanged ||
          existing?.disabled ||
          CLI_HARNESS_PROVIDERS.has(name) ||
          options.fullCheck)
      ) {
        const verification = await this.verifyConnection(name, nextConnection, {
          runtimeCheck: options.fullCheck === true,
        });
        if (!verification.success) {
          // Retain only an explicitly submitted API key for an inactive provider.
          // Never overwrite a working connection on failed rotation, or persist
          // ambient/CLI credentials. The authenticated route owns disk writes;
          // registry tests and transient registries must not mutate real stores.
          if (
            !credentials.apiKey?.trim() ||
            (existing && !existing.disabled) ||
            !['api_key', 'api_key_or_auth'].includes(this.authModeFor(name))
          )
            return verification;
          const failedConfig: ProviderConfig = {
            ...existing,
            name,
            apiKey: resolvedApiKey,
            authToken: resolvedAuthToken,
            baseUrl: resolvedBaseUrl,
            deployment: resolvedDeployment,
            awsRegion: resolvedAwsRegion,
            awsSessionToken: resolvedAwsSessionToken,
            autoDetected: nextAutoDetected,
            lastVerifiedAt: undefined,
            lastVerificationScope: undefined,
            lastVerificationState: undefined,
            disabled: true,
          };
          this.providerConfigs.set(name, failedConfig);
          this.providers.delete(name);
          return { ...verification, credentialsRetained: true };
        }
        acceptedState = verification.state ?? 'verified';
        acceptedScope = verification.scope ?? this.verificationScopeFor(name);
      }

      // Remember catalog/endpoint confirmation across restarts so custom
      // providers don't demote themselves to unconfigured on every boot.
      const confirmedState = acceptedState === 'verified' || acceptedState === 'detected';
      const verifiedAt = confirmedState
        ? Date.now()
        : connectionChanged
          ? undefined
          : existing?.lastVerifiedAt;
      const verificationScope = confirmedState
        ? (acceptedScope ?? this.verificationScopeFor(name))
        : connectionChanged
          ? undefined
          : existing?.lastVerificationScope;
      const verificationState: ProviderConfig['lastVerificationState'] = confirmedState
        ? acceptedState === 'detected'
          ? 'detected'
          : 'verified'
        : connectionChanged
          ? undefined
          : existing?.lastVerificationState;
      const providerConfig: ProviderConfig = {
        ...existing,
        name,
        apiKey: resolvedApiKey,
        authToken: resolvedAuthToken,
        baseUrl: resolvedBaseUrl,
        deployment: resolvedDeployment,
        awsRegion: resolvedAwsRegion,
        awsSessionToken: resolvedAwsSessionToken,
        selectedModels: credentials.selectedModels ?? existing?.selectedModels,
        hideModelSelector: credentials.hideModelSelector ?? existing?.hideModelSelector,
        contextWindow:
          credentials.contextWindow === 0
            ? undefined // restore the maximum tier
            : typeof credentials.contextWindow === 'number' &&
                Number.isSafeInteger(credentials.contextWindow) &&
                credentials.contextWindow > 0
              ? credentials.contextWindow
              : existing?.contextWindow,
        lastVerifiedAt: verifiedAt,
        lastVerificationScope: verificationScope,
        lastVerificationState: verificationState,
        autoDetected: nextAutoDetected,
        disabled: false, // Explicitly enable on setCredentials
        headers: existing?.headers,
      };

      this.providerConfigs.set(name, providerConfig);

      // A preference-only save (Manage Models, context window, selector
      // visibility) cannot change transport, so it must keep the live adapter.
      // Rebuilding one produced a fresh instance with an empty catalog while the
      // deliberate no-refresh rule skipped discovery, so the card showed "No
      // models were reported" until a manual refresh. Mutating the existing
      // config keeps context-window readers current without discarding the
      // catalog.
      const provider = options.preferenceOnly
        ? (this.providers.get(name) ?? this.createProvider(name, providerConfig))
        : this.createProvider(name, providerConfig);
      if (provider && options.preferenceOnly) Object.assign(provider.config, providerConfig);
      if (provider) {
        // A preference-only update (Manage Models) must not re-run catalog
        // discovery. The selection is already based on the catalog displayed
        // in the dialog, and CLI-backed discovery can take long enough to make
        // Done appear unresponsive. Normal connects still warm the catalog so
        // the picker is populated immediately; background/manual refreshes
        // handle later catalog changes.
        if (!options.preferenceOnly) {
          // Wait for the live model catalog on explicit connect so the model
          // picker shows the provider's real models immediately — no restart
          // needed. Previously only Codex awaited here (and without forcing a
          // refresh), so every other provider returned success with an empty
          // catalog while background discovery was still in flight, and the
          // frontend's immediate status reload rendered zero models. Guarded by
          // a timeout so a slow catalog can never hang connect: verification
          // already passed, and the background refresh keeps going.
          const catalogRefresh = provider.refreshModels?.(true);
          if (catalogRefresh && typeof (catalogRefresh as Promise<unknown>).then === 'function') {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                catalogRefresh as Promise<unknown>,
                new Promise((resolve) => {
                  timer = setTimeout(resolve, CONNECT_CATALOG_TIMEOUT_MS);
                }),
              ]);
            } catch (err: unknown) {
              providerLog.debug(
                { provider: name, err: err instanceof Error ? err.message : String(err) },
                'Connect-time model catalog refresh failed; background discovery continues',
              );
            } finally {
              if (timer) clearTimeout(timer);
            }
          }
        }
        this.providers.set(name, provider);
        this.circuitStates.delete(name); // Reset circuit breaker
        this.clearKeyInvalid(name); // New key may be valid
        this.verificationRecords.set(name, {
          state: acceptedState,
          checkedAt: verifiedAt ?? Date.now(),
          scope: acceptedScope ?? verificationScope ?? this.verificationScopeFor(name),
        });
        if (options.autoDetected !== true) this.userDisconnected.delete(name);
        providerLog.info({ provider: name }, 'Provider configured');
        return { success: true };
      }
      if (DEDICATED_CAPABILITY_PROVIDER_NAMES.has(name)) {
        this.clearKeyInvalid(name);
        this.verificationRecords.set(name, {
          state: acceptedState,
          checkedAt: verifiedAt ?? Date.now(),
          scope: acceptedScope ?? verificationScope ?? this.verificationScopeFor(name),
        });
        if (options.autoDetected !== true) this.userDisconnected.delete(name);
        providerLog.info({ provider: name }, 'Dedicated capability provider configured');
        return { success: true };
      }
      return { success: false, error: 'Failed to initialize provider' };
    } catch (err: unknown) {
      return { success: false, error: 'Provider configuration could not be initialized.' };
    }
  }

  private validateCredentials(
    name: ProviderName,
    credentials: {
      apiKey?: string;
      authToken?: string;
      baseUrl?: string;
      deployment?: string;
    },
    existing?: ProviderConfig,
  ): { success: boolean; error?: string } {
    const authMode = this.authModeFor(name);
    const apiKey = credentials.apiKey?.trim();
    const authToken = credentials.authToken?.trim();
    const baseUrl = credentials.baseUrl?.trim();
    const deployment = credentials.deployment?.trim() || existing?.deployment?.trim();

    // Custom providers only require a base URL; the API key is optional.
    if (existing?.custom || this.customProviderIds.has(name)) {
      if (!baseUrl && !existing?.baseUrl) {
        return { success: false, error: 'Custom provider requires a base URL' };
      }
      return { success: true };
    }

    if (authMode === 'auth_only' && apiKey) {
      return {
        success: false,
        error: `${name} uses account auth only and does not accept API keys`,
      };
    }

    if (authMode === 'auth_only') {
      const hasAuth = !!(authToken || existing?.authToken);
      // Managed local runtimes own their auth: the desktop app / app-server
      // holds the login, so "Connect" is a detection step, never a token
      // entry. Only genuinely token-based auth_only providers require one.
      if (!hasAuth && !MANAGED_CLI_PROVIDERS.has(name)) {
        return { success: false, error: 'authToken is required' };
      }
    }

    if (authMode === 'api_key' && !apiKey) {
      return { success: false, error: 'apiKey is required' };
    }

    if (authMode === 'api_key_or_auth' && !apiKey && !authToken) {
      return { success: false, error: 'Provide apiKey or authToken' };
    }

    if (name === 'azure' && apiKey && authToken) {
      return {
        success: false,
        error:
          'Azure OpenAI accepts either an API key or a Microsoft Entra bearer token, not both. Disconnect the existing credential before switching auth modes.',
      };
    }

    if (authMode === 'env_auth') {
      const envReady = this.hasBedrockEnvironment();
      // Bedrock accepts explicit AWS credentials entered in Settings as an
      // alternative to a system-wide credential source (env vars / AWS CLI).
      const explicitAwsCreds = name === 'bedrock' && !!(apiKey && authToken);
      if (!envReady && !explicitAwsCreds)
        return {
          success: false,
          error: `${name} environment credentials not detected. Enter an AWS access key ID and secret access key, or configure the AWS CLI.`,
        };
    }

    if (authMode === 'base_url_only' && !baseUrl) {
      // Some local providers have defaults
      if (name === 'llamacpp' || name === 'lmstudio' || name === 'ollama') return { success: true };
      return { success: false, error: 'baseUrl is required' };
    }

    if ((name === 'azure' || name === 'azurecognitive') && !deployment) {
      return {
        success: false,
        error: `${name} requires the explicit Azure deployment name; base model ids cannot be used as deployments`,
      };
    }

    if (name === 'sapai' && !deployment) {
      return {
        success: false,
        error: 'SAP AI Core requires an explicit running deployment ID',
      };
    }

    if (name === 'gitlab' && baseUrl) {
      // Reject a malformed instance URL at save time: a typo here otherwise
      // surfaces much later as a 404 that reads like "no Duo access".
      try {
        normalizeGitLabBaseUrl(baseUrl);
      } catch (error: unknown) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'GitLab instance URL is invalid',
        };
      }
    }

    return { success: true };
  }

  /** Force-refresh a provider instance from current stored config. */
  refreshProvider(name: ProviderName): { success: boolean; error?: string } {
    const config = this.providerConfigs.get(name);
    if (!config) return { success: false, error: 'Provider config not found' };
    try {
      const provider = this.createProvider(name, config);
      if (!provider) return { success: false, error: 'Failed to initialize provider' };
      this.providers.set(name, provider);
      this.circuitStates.delete(name); // Reset circuit breaker on refresh
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: 'Provider refresh could not be initialized.' };
    }
  }

  /** Remove a provider's API key. */
  removeApiKey(name: ProviderName): void {
    const config = this.providerConfigs.get(name);
    if (config) {
      config.apiKey = undefined;
      config.authToken = undefined;
      config.autoDetected = undefined;
      config.lastVerifiedAt = undefined;
      config.lastVerificationScope = undefined;
      config.lastVerificationState = undefined;
      config.disabled = true;
      this.providerConfigs.set(name, config);
    }
    this.providers.delete(name);
    this.circuitStates.delete(name);
    this.verificationRecords.delete(name);
    // Disconnect is user intent: autodetect must not silently reconnect the
    // same material later in this session.
    this.userDisconnected.add(name);
    this.autoDetectedSources.delete(name);
    providerLog.info({ provider: name }, 'Provider disconnected');
  }

  /** Get the env var name expected for a provider. */
  getExpectedEnvVar(
    name: ProviderName,
    kind: 'apiKey' | 'authToken' | 'baseUrl' = 'apiKey',
  ): string {
    if (kind === 'authToken') {
      return ENV_AUTH_TOKEN_MAP[name]?.[0] ?? `${name.toUpperCase()}_AUTH_TOKEN`;
    }
    if (kind === 'baseUrl') {
      return ENV_URL_MAP[name] ?? `${name.toUpperCase()}_BASE_URL`;
    }
    return ENV_API_KEY_MAP[name]?.[0] ?? `${name.toUpperCase()}_API_KEY`;
  }

  // ─── Private: Initialize all providers ──────────────────────────────────

  private initializeAll() {
    for (const name of Object.keys(PROVIDER_AUTH_MODE) as ProviderName[]) {
      const providerConfig = this.buildProviderConfig(name);
      this.providerConfigs.set(name, providerConfig);

      // A disabled provider is configuration metadata, not a runnable adapter.
      // Several CLI adapters discover accounts or launch model probes from their
      // constructor/listModels path, so constructing them here would bypass both
      // the user's Disconnect choice and KORY_DISABLE_CLI_AUTODETECT.
      if (providerConfig.disabled) continue;
      this.restoreVerificationRecord(name, providerConfig);

      try {
        const provider = this.createProvider(name, providerConfig);
        if (provider) this.providers.set(name, provider);
      } catch (error) {
        providerLog.error(
          safeProviderDiagnostic(name, 'configuration', error),
          'Failed to initialize provider',
        );
      }
    }

    // Restore user-registered ACP agents from koryphaios.json (definitions) and
    // the probe verdict store. Agents are never enabled by detection alone: an
    // agent without an ok verdict stays listed but unavailable.
    try {
      const root = acpStoreRoot();
      const verdicts = loadAcpProbeVerdicts(root);
      for (const def of loadAcpAgentDefinitions(root)) {
        this.registerAcpAgentProvider(def, verdicts[def.id]);
      }
    } catch (error) {
      providerLog.error(
        { errorType: error instanceof Error ? error.name : typeof error },
        'Failed to restore ACP agent providers',
      );
    }

    // Restore user-defined custom providers persisted in the config.
    for (const [id, pc] of Object.entries(this.config?.providers ?? {})) {
      if (!pc?.custom || PROVIDER_AUTH_MODE[id as ProviderName]) continue;
      this.customProviderIds.add(id as ProviderName);
      const providerConfig = this.buildProviderConfig(id as ProviderName);
      this.providerConfigs.set(id, providerConfig);
      if (providerConfig.disabled) continue;
      this.restoreVerificationRecord(id as ProviderName, providerConfig);
      try {
        const provider = this.createProvider(id as ProviderName, providerConfig);
        if (provider) this.providers.set(id, provider);
      } catch (error) {
        providerLog.error(
          safeProviderDiagnostic(id, 'configuration', error),
          'Failed to initialize custom provider',
        );
      }
    }

    // Proactively warm only explicitly enabled adapters. Disabled adapters are
    // deliberately absent from this.providers, so startup cannot spawn a CLI or
    // contact an endpoint the user did not enable.
    for (const provider of this.providers.values()) {
      try {
        provider.listModels();
      } catch (error) {
        providerLog.debug(
          safeProviderDiagnostic(provider.name, 'configuration', error),
          'Startup model-list warm-up failed',
        );
      }
    }

    this.logProviderStatus();
  }

  /**
   * Auto-enable providers backed by an agent CLI the user already has installed +
   * logged in on this machine (Claude Code, Codex, Grok Build) — so they
   * "just work" with no manual Connect step. A logged-in CLI is clear user intent,
   * unlike a stray environment variable (which we still don't auto-auth). Returns the
   * credentials to inject, or null when there's nothing to auto-enable.
   * Opt out entirely with KORY_DISABLE_CLI_AUTODETECT=1.
   */
  private buildProviderConfig(name: ProviderName): ProviderConfig {
    const userConfig = this.config?.providers?.[name];

    // Default to disabled so startup never "auto-auths" from environment variables.
    // Env/local connection material found on this machine is connected asynchronously by
    // autoDetectProviders, and only after that provider's real verification probe succeeds.
    // Explicit opt-in (via UI "Connect" or config) is otherwise required — EXCEPT for providers
    // backed by an agent CLI the user has installed + logged in, which we treat as intent and
    // auto-enable (Claude Code, Codex, Grok Build). Opt out with KORY_DISABLE_CLI_AUTODETECT=1.
    const defaultDisabled = true;
    const autoCli = userConfig?.disabled === true ? null : cliAutoEnableCreds(name);
    const hasStoredCredential = !!(
      userConfig?.apiKey?.trim() ||
      userConfig?.authToken?.trim() ||
      userConfig?.baseUrl?.trim() ||
      userConfig?.deployment?.trim() ||
      userConfig?.awsRegion?.trim() ||
      userConfig?.lastVerifiedAt
    );
    const isDisabled =
      userConfig?.disabled ?? (hasStoredCredential ? false : autoCli ? false : defaultDisabled);
    // Retired TokenRouter hosts (the dead .me domain and the wrong .io default
    // older versions may have persisted) count as "no explicit override" so the
    // canonical default applies. Explicit user URLs on live hosts still win.
    let normalizedUserBaseUrl = userConfig?.baseUrl?.replace(/\/+$/, '');
    const canonicalCustomBaseUrl =
      false && normalizedUserBaseUrl ? normalizedUserBaseUrl : (userConfig?.baseUrl ?? undefined);
    const userBaseUrl =
      name === 'tokenrouter' &&
      (normalizedUserBaseUrl === 'https://tokenrouter.me/v1' ||
        normalizedUserBaseUrl === 'https://api.tokenrouter.io/v1')
        ? undefined
        : canonicalCustomBaseUrl;

    const providerConfig: ProviderConfig = {
      name,
      apiKey:
        userConfig?.apiKey ??
        autoCli?.apiKey ??
        (isDisabled ? undefined : this.detectEnvKey(name)) ??
        undefined,
      authToken:
        userConfig?.authToken ??
        autoCli?.authToken ??
        (isDisabled ? undefined : this.detectEnvAuthToken(name)) ??
        undefined,
      // One canonical default reaches both runtime construction and the
      // synthetic request-shape suite. Explicit user/env URLs still win.
      baseUrl: userBaseUrl ?? this.detectEnvUrl(name) ?? providerDefaultBaseUrl(name) ?? undefined,
      deployment: userConfig?.deployment,
      awsRegion: userConfig?.awsRegion,
      awsSessionToken: userConfig?.awsSessionToken,
      selectedModels: userConfig?.selectedModels ?? [],
      hideModelSelector: userConfig?.hideModelSelector ?? false,
      contextWindow: userConfig?.contextWindow,
      lastVerifiedAt: userConfig?.lastVerifiedAt,
      lastVerificationScope: userConfig?.lastVerificationScope,
      lastVerificationState: userConfig?.lastVerificationState,
      disabled: isDisabled,
      headers: userConfig?.headers,
      // Preserve custom-provider metadata so BYO providers survive restarts.
      ...(userConfig?.custom && {
        custom: true,
        kind: userConfig.kind,
        label: userConfig.label,
        models: userConfig.models,
        customIcon: userConfig.customIcon,
      }),
    };

    return providerConfig;
  }

  private hasValidAuth(name: ProviderName, config: ProviderConfig): boolean {
    if (config.custom) return !!config.baseUrl;
    const authMode = this.authModeFor(name);
    const hasApi = !!config.apiKey;
    const hasAuth = !!config.authToken;
    const hasUrl = !!config.baseUrl;

    const hasAnyAuth =
      (authMode === 'api_key' && hasApi) ||
      (authMode === 'auth_only' && hasAuth) ||
      (authMode === 'api_key_or_auth' && (hasApi || hasAuth)) ||
      (authMode === 'env_auth' && (this.hasBedrockEnvironment() || (hasApi && hasAuth))) ||
      (authMode === 'base_url_only' && (hasUrl || name === 'lmstudio' || name === 'llamacpp'));

    if (hasAnyAuth) return true;

    // Provider has no auth — it will fail at runtime when called
    return false;
  }

  private createProvider(name: ProviderName, config: ProviderConfig): Provider | null {
    // Non-chat APIs never inherit OpenAI-compatible chat by URL coincidence.
    if (UNSUPPORTED_CHAT_PROVIDER_NAMES.has(name)) return null;

    // User-registered ACP agents. The provider holds no endpoint; it spawns the
    // registered command per turn with the agent's own env secrets.
    if (isAcpProviderName(String(name))) {
      return config.acpAgent ? new AcpAgentProvider(config) : null;
    }

    // User-defined custom providers (OpenAI/Anthropic/Gemini-compatible BYO endpoints).
    if (config.custom || this.customProviderIds.has(name)) {
      return config.baseUrl ? new CustomProvider(config) : null;
    }
    // Built-in providers with an explicit factory.
    const factory = PROVIDER_FACTORIES[name];
    if (factory) return factory(config);

    // Unmapped names that still have a known OpenAI-compatible default base URL
    // (302ai, deepseek, mistral, cohere, perplexity, novita, …) get a generic
    // OpenAIProvider. This keeps BYO OpenAI-compatible endpoints working without
    // requiring a per-name factory entry.
    const defaultBase = providerDefaultBaseUrl(name);
    const effectiveBase = config.baseUrl?.trim() || defaultBase;
    if (effectiveBase && (config.apiKey || config.authToken)) {
      return new OpenAIProvider(config, name, effectiveBase);
    }
    if (name === 'sapai' && config.apiKey && config.baseUrl) {
      return new OpenAIProvider(config, 'sapai', config.baseUrl);
    }
    return null;
  }

  private detectEnvKey(name: ProviderName): string | null {
    return envVarMaterial(name, 'apiKey')?.value ?? null;
  }

  private detectEnvAuthToken(name: ProviderName): string | null {
    return envVarMaterial(name, 'authToken')?.value ?? null;
  }

  /** Resolve envelope-encrypted credentials after encryption is initialized. */
  async initializeEncryptedCredentials(): Promise<void> {
    if (!isUsingSecureEncryption()) return;
    for (const name of Object.keys(PROVIDER_AUTH_MODE) as ProviderName[]) {
      const config = this.providerConfigs.get(name);
      if (!config || config.disabled) continue;
      let apiKey = config.apiKey;
      let authToken = config.authToken;
      for (const envVar of ENV_API_KEY_MAP[name] ?? []) {
        const val = process.env[envVar];
        if (val?.startsWith('env:')) {
          try {
            apiKey = await secureDecrypt(val);
            break;
          } catch (err: unknown) {
            serverLog.debug(
              { err: err instanceof Error ? err.message : String(err) },
              'Failed to decrypt stored API key',
            );
            providerLog.warn({ provider: name, envVar }, 'Failed to decrypt stored API key');
          }
        }
      }
      for (const envVar of ENV_AUTH_TOKEN_MAP[name] ?? []) {
        const val = process.env[envVar];
        if (val?.startsWith('env:')) {
          try {
            authToken = await secureDecrypt(val);
            break;
          } catch (err: unknown) {
            serverLog.debug(
              { err: err instanceof Error ? err.message : String(err) },
              'Failed to decrypt stored auth token',
            );
            providerLog.warn({ provider: name, envVar }, 'Failed to decrypt stored auth token');
          }
        }
      }
      if (apiKey !== config.apiKey || authToken !== config.authToken) {
        const updated = { ...config, apiKey, authToken };
        this.providerConfigs.set(name, updated);
        const provider = updated.disabled ? null : this.createProvider(name, updated);
        if (provider) this.providers.set(name, provider);
      }
    }
  }

  private detectEnvUrl(name: ProviderName): string | null {
    const envVar = ENV_URL_MAP[name];
    if (envVar) return process.env[envVar] ?? null;
    return null;
  }

  private hasBedrockEnvironment(): boolean {
    // Environment variables, ~/.aws/credentials, or ~/.aws/config profiles.
    return hasAwsCredentialSource();
  }

  private logProviderStatus() {
    const available = this.getAvailable();
    const names = available.map((p) => p.name);
    providerLog.info({ providers: names }, 'Providers ready');

    if (names.length === 0) {
      providerLog.warn('No providers configured - set API keys in .env');
    }
  }

  private async verifyCapabilityGet(
    url: string,
    headers: Record<string, string>,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await fetch(url, {
        headers: { ...headers, 'User-Agent': 'Koryphaios/1.0' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok)
        return { success: false, error: safeVerificationHttpError(response.status) };
      return { success: true };
    } catch {
      return { success: false, error: 'Provider verification failed safely.' };
    }
  }

  private async verifyBearerGet(
    url: string,
    token?: string | null,
  ): Promise<{ success: boolean; error?: string }> {
    if (!token) return { success: false, error: 'Missing token' };
    return this.verifyModelCatalog(
      url,
      { headers: { Authorization: `Bearer ${token}` } },
      'openai',
    );
  }

  /**
   * Verify a model-catalog endpoint by both authentication outcome and response
   * shape. HTTP 2xx alone is not evidence: reverse-proxy login pages, generic
   * mocks, empty accounts, and malformed JSON all remain unverified.
   */
  private async verifyModelCatalog(
    url: string,
    init: RequestInit | undefined,
    shape: 'openai' | 'gemini' | 'ollama',
  ): Promise<{ success: boolean; error?: string }> {
    const result = await this.verifyModelCatalogWithStatus(url, init, shape);
    return { success: result.success, error: result.error };
  }

  private async verifyModelCatalogWithStatus(
    url: string,
    init: RequestInit | undefined,
    shape: 'openai' | 'gemini' | 'ollama',
  ): Promise<{ success: boolean; status?: number; error?: string }> {
    const timeoutMs = 5_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers(init?.headers ?? {});
      if (!headers.has('User-Agent')) headers.set('User-Agent', 'Koryphaios/1.0');
      const response = await fetch(url, {
        method: 'GET',
        ...init,
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.arrayBuffer();
        return {
          success: false,
          status: response.status,
          error: safeVerificationHttpError(response.status),
        };
      }

      let payload: unknown;
      try {
        payload = JSON.parse(await response.text()) as unknown;
      } catch {
        return {
          success: false,
          status: response.status,
          error: `HTTP ${response.status}: model catalog did not return valid JSON`,
        };
      }

      if (!this.hasValidModelCatalogEntry(payload, shape)) {
        return {
          success: false,
          status: response.status,
          error: `HTTP ${response.status}: model catalog contained no valid ${shape} model entries`,
        };
      }
      return { success: true, status: response.status };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('abort') || message.includes('timeout')) {
        return { success: false, error: 'Request timeout (5s)' };
      }
      return { success: false, error: 'Provider model-catalog verification request failed.' };
    } finally {
      clearTimeout(timer);
    }
  }

  private hasValidModelCatalogEntry(
    payload: unknown,
    shape: 'openai' | 'gemini' | 'ollama',
  ): boolean {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const body = payload as Record<string, unknown>;
    const validId = (value: unknown): boolean =>
      typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 512;

    if (shape === 'openai') {
      return (
        Array.isArray(body.data) &&
        body.data.some(
          (entry) =>
            !!entry &&
            typeof entry === 'object' &&
            !Array.isArray(entry) &&
            validId((entry as Record<string, unknown>).id),
        )
      );
    }

    if (!Array.isArray(body.models)) return false;
    if (shape === 'ollama') {
      return body.models.some(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          !Array.isArray(entry) &&
          (validId((entry as Record<string, unknown>).name) ||
            validId((entry as Record<string, unknown>).model)),
      );
    }

    return body.models.some((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const model = entry as Record<string, unknown>;
      if (!validId(model.name) || !(model.name as string).trim().startsWith('models/'))
        return false;
      const methods = model.supportedGenerationMethods;
      return (
        !Array.isArray(methods) ||
        methods.some((method) => method === 'generateContent' || method === 'streamGenerateContent')
      );
    });
  }

  private async verifyGitHubModelsCatalog(
    token: string,
  ): Promise<{ success: boolean; error?: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(GITHUB_MODELS_CATALOG_URL, {
        method: 'GET',
        headers: githubModelsHeaders(token),
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.arrayBuffer();
        return {
          success: false,
          error: safeVerificationHttpError(response.status, 'GitHub Models catalog verification'),
        };
      }
      const models = parseGitHubModelsCatalog(await response.json());
      if (models.length === 0) {
        return {
          success: false,
          error: 'GitHub Models catalog returned no chat-capable models for this token',
        };
      }
      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: 'GitHub Models verification request failed.' };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Prove a Vertex AI express-mode key against Google's authenticated API.
   * Presence alone is never treated as authentication. countTokens performs
   * no content generation and its response shape gives us authenticated
   * service metadata to validate instead of accepting an arbitrary HTTP 200.
   */
  private async verifyVertexExpressKey(
    apiKey: string,
  ): Promise<{ success: boolean; error?: string }> {
    const timeoutMs = 5_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const { headers } = buildAuthHeaders('vertexai', { apiKey });
      const response = await fetch(VERTEX_EXPRESS_VERIFY_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Koryphaios connection check' }] }],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        await response.arrayBuffer();
        return {
          success: false,
          error: safeVerificationHttpError(response.status, 'Vertex AI verification'),
        };
      }

      const payload = (await response.json()) as { totalTokens?: unknown };
      if (typeof payload.totalTokens !== 'number' || !Number.isFinite(payload.totalTokens)) {
        return {
          success: false,
          error:
            'Vertex AI returned an invalid countTokens response; connection remains unverified',
        };
      }

      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes('abort') || message.toLowerCase().includes('timeout')) {
        return { success: false, error: 'Vertex AI verification timed out after 5 seconds' };
      }
      return { success: false, error: 'Vertex AI verification request failed.' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Identify if an error is a quota/rate limit error that should trigger a reroute. */
  isQuotaError(error: unknown): boolean {
    const msg = String(
      (error as { message?: string } | undefined)?.message || error || '',
    ).toLowerCase();
    const isQuota =
      msg.includes('quota') ||
      msg.includes('rate limit') ||
      msg.includes('429') ||
      msg.includes('insufficient_quota') ||
      msg.includes('credit balance');
    return isQuota;
  }

  /**
   * Identify transient provider errors (5xx / timeouts / in-stream server error
   * frames) that should be retried on the same model, or fall through to a
   * fallback provider, instead of failing closed. 4xx auth errors
   * (401/403/invalid key) stay fail-closed. The policy lives in
   * `provider-retry` so auxiliary calls share it.
   */
  isRetriableProviderError(error: unknown): boolean {
    return isRetriableProviderFailure(error);
  }

  /**
   * Dry-run connectivity test for a provider. Sends minimal-cost request (e.g. model list).
   * Returns 200 OK or specific "Out of Credits" vs timeout/refused. Never logs raw API keys.
   */
  async testConnection(name: ProviderName): Promise<{
    ok: boolean;
    status?: number;
    error?: string;
    outOfCredits?: boolean;
  }> {
    const result = await this.verifyConnection(name);
    if (result.success && (result.state ?? 'verified') === 'verified') {
      return { ok: true, status: 200 };
    }
    if (result.success) {
      return {
        ok: false,
        error:
          'Local setup material was detected, but this provider has no supported read-only account or deployment probe. Access remains unverified until runtime.',
      };
    }
    const err = (result.error ?? '').toLowerCase();
    const outOfCredits =
      err.includes('quota') ||
      err.includes('credit') ||
      err.includes('insufficient') ||
      err.includes('out of credits');
    return { ok: false, error: result.error, outOfCredits };
  }

  /** Persist invalid key state (401). No-op if DB not initialized. */
  private markKeyInvalid(name: ProviderName, lastError: string): void {
    try {
      const { getDb } = require('../db');
      getDb()
        .prepare(
          'INSERT OR REPLACE INTO provider_key_invalid (provider, invalid_since, last_error) VALUES (?, ?, ?)',
        )
        .run(name, Date.now(), lastError);
      const config = this.providerConfigs.get(name);
      providerLog.warn(
        { provider: name, keyMask: maskApiKey(config?.apiKey ?? config?.authToken) },
        'API key marked invalid (401); update key in settings',
      );
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to mark key invalid (DB not initialized)',
      );
      // DB not initialized (e.g. tests)
    }
  }

  /** Clear invalid key state (e.g. after user updates key). */
  clearKeyInvalid(name: ProviderName): void {
    try {
      const { getDb } = require('../db');
      getDb().run('DELETE FROM provider_key_invalid WHERE provider = ?', name);
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to clear invalid key state (DB not initialized)',
      );
      // DB not initialized
    }
  }

  /** Check if provider was previously marked invalid. */
  private isKeyMarkedInvalid(name: ProviderName): boolean {
    try {
      const { getDb } = require('../db');
      const row = getDb()
        .query('SELECT provider FROM provider_key_invalid WHERE provider = ?')
        .get(name) as { provider?: string } | undefined;
      return !!row;
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to check invalid key state, assuming not invalid',
      );
      return false;
    }
  }

  /** Like verifyHttp but returns status for 401/404 handling. */
  private async verifyHttpWithStatus(
    url: string,
    init?: RequestInit,
  ): Promise<{ success: boolean; status?: number; error?: string }> {
    const timeoutMs = 5_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers(init?.headers ?? {});
      if (!headers.has('User-Agent')) headers.set('User-Agent', 'Koryphaios/1.0');
      const response = await fetch(url, {
        method: 'GET',
        ...init,
        headers,
        signal: controller.signal,
      });
      if (response.ok) return { success: true, status: response.status };
      await response.arrayBuffer();
      return {
        success: false,
        status: response.status,
        error: safeVerificationHttpError(response.status),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('abort') || msg.includes('timeout')) {
        return { success: false, error: 'Request timeout (5s)' };
      }
      return { success: false, error: 'Provider verification request failed.' };
    } finally {
      clearTimeout(timer);
    }
  }

  private async verifyHttp(
    url: string,
    init?: RequestInit,
  ): Promise<{ success: boolean; error?: string }> {
    const res = await this.verifyHttpWithStatus(url, init);
    return { success: res.success, error: res.error };
  }
}

export { ProviderRegistry };
