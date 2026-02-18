// Koryphaios Shared Types — The contract between backend and frontend.

// ─── Provider & Model Definitions ───────────────────────────────────────────

export const ProviderName = {
  // Frontier (Major providers)
  Anthropic: "anthropic",
  OpenAI: "openai",
  Google: "google",
  XAI: "xai",
  // Aggregators
  OpenRouter: "openrouter",
  Cline: "cline",
  Groq: "groq",
  Copilot: "copilot",
  // Enterprise
  Azure: "azure",
  Bedrock: "bedrock",
  VertexAI: "vertexai",
  // Local
  Local: "local",
  Ollama: "ollama",
  LMStudio: "lmstudio",
  LlamaCpp: "llamacpp",
  OllamaCloud: "ollamacloud",
  // Chinese AI Providers
  DeepSeek: "deepseek",
  MiniMax: "minimax",
  MoonshotAI: "moonshot",
  ZAI: "zai",
  Cortecs: "cortecs",
  StepFun: "stepfun",
  // High Performance / Speed
  Cerebras: "cerebras",
  FireworksAI: "fireworks",
  DeepInfra: "deepinfra",
  IO: "ionet",
  Hyperbolic: "hyperbolic",
  // Open Source Platforms
  HuggingFace: "huggingface",
  Replicate: "replicate",
  Modal: "modal",
  // AI Gateways
  Vercel: "vercel",
  Cloudflare: "cloudflare",
  CloudflareWorkers: "cloudflareworkers",
  Baseten: "baseten",
  Helicone: "helicone",
  Portkey: "portkey",
  // European Providers
  Scaleway: "scaleway",
  OVHcloud: "ovhcloud",
  STACKIT: "stackit",
  Nebius: "nebius",
  // Subscription-based
  TogetherAI: "togetherai",
  VeniceAI: "venice",
  ZenMux: "zenmux",
  OpenCodeZen: "opencodezen",
  Firmware: "firmware",
  A302AI: "302ai",
  // Specialized
  MistralAI: "mistralai",
  Cohere: "cohere",
  Perplexity: "perplexity",
  Luma: "luma",
  Fal: "fal",
  // Audio/Speech
  ElevenLabs: "elevenlabs",
  AssemblyAI: "assemblyai",
  Deepgram: "deepgram",
  Gladia: "gladia",
  LMNT: "lmnt",
  // Enterprise
  AzureCognitive: "azurecognitive",
  SAPAI: "sapai",
  // Developer Platforms
  GitLab: "gitlab",
  // NVIDIA
  NVIDIA: "nvidia",
  NIM: "nim",
  // Friendli
  FriendliAI: "friendliai",
  // Embeddings
  VoyageAI: "voyageai",
  Mixedbread: "mixedbread",
  // Memory
  Mem0: "mem0",
  Letta: "letta",
  // Qwen
  Qwen: "qwen",
  Alibaba: "alibaba",
  // Chrome
  ChromeAI: "chromeai",
  // Requesty
  Requesty: "requesty",
  // AIHubMix
  AIHubMix: "aihubmix",
  AIMLAPI: "aimlapi",
  // Black Forest Labs
  BlackForestLabs: "blackforestlabs",
  // Kling AI
  KlingAI: "klingai",
  // Prodia
  Prodia: "prodia",
  // Legacy
  Codex: "codex",
  Antigravity: "antigravity",
  // Additional providers (to match OpenCode coverage)
  Novita: "novita",
  Banbri: "banbri",
} as const;

export type ProviderName = (typeof ProviderName)[keyof typeof ProviderName];

export type ModelTier = "flagship" | "fast" | "cheap" | "reasoning";

export interface ModelDef {
  id: string;
  name: string;
  provider: ProviderName;
  /** Model ID sent to the API. Defaults to `id` if omitted. Used when API expects a different name (e.g., OpenRouter "openai/gpt-4.1"). */
  apiModelId?: string;
  contextWindow: number;
  maxOutputTokens: number;
  costPerMInputTokens: number;
  costPerMOutputTokens: number;
  costPerMInputCached?: number;
  costPerMOutputCached?: number;
  canReason: boolean;
  supportsAttachments: boolean;
  supportsStreaming: boolean;
  tier?: ModelTier;
  isGeneric?: boolean;
}

export interface ProviderConfig {
  name: ProviderName;
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
  disabled: boolean;
  /** List of model IDs enabled by the user. If empty or undefined, all are enabled. */
  selectedModels?: string[];
  /** Whether to skip the model selection dialog in the future. */
  hideModelSelector?: boolean;
  headers?: Record<string, string>;
}

export type ProviderAuthMode = "api_key" | "auth_only" | "api_key_or_auth" | "base_url_only" | "env_auth";

// ─── Agent & Worker Types ───────────────────────────────────────────────────

export type AgentRole = "manager" | "coder" | "task" | "reviewer" | "title" | "summarizer" | "critic";

export type AgentStatus = "idle" | "thinking" | "tool_calling" | "streaming" | "verifying" | "compacting" | "waiting_user" | "error" | "done" | "reading" | "writing" | "criticizing";

export type WorkerDomain = "frontend" | "backend" | "general" | "review" | "test" | "critic";

export interface AgentIdentity {
  id: string;
  name: string;
  role: AgentRole;
  model: string;
  provider: ProviderName;
  domain: WorkerDomain;
  /** CSS glow color for the UI */
  glowColor: string;
}

// ─── Tool System ────────────────────────────────────────────────────────────

export type ToolName =
  | "bash"
  | "read_file"
  | "write_file"
  | "edit_file"
  | "delete_file"
  | "move_file"
  | "patch"
  | "diff"
  | "grep"
  | "glob"
  | "ls"
  | "web_fetch"
  | "web_search"
  | "ask_user"
  | "ask_manager"
  | "agent"
  | string; // MCP tools use dynamic names

export interface ToolCall {
  id: string;
  name: ToolName;
  input: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: ToolName;
  output: string;
  isError: boolean;
  durationMs: number;
}

// ─── Message & Content Types ────────────────────────────────────────────────

export type ContentBlockType = "text" | "thinking" | "tool_use" | "tool_result" | "image";

export interface ContentBlock {
  type: ContentBlockType;
  text?: string;
  thinking?: string;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  imageUrl?: string;
}

export interface Message {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  model?: string;
  provider?: ProviderName;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  createdAt: number;
}

/** Flattened message structure for database storage */
export interface StoredMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string; // JSON string of ContentBlock[] or raw text
  model?: string;
  provider?: ProviderName;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  createdAt: number;
}

// ─── Session Types ──────────────────────────────────────────────────────────

export interface Session {
  id: string;
  title: string;
  parentSessionId?: string;
  messageCount: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  createdAt: number;
  updatedAt: number;
}

// ─── Permission System ──────────────────────────────────────────────────────

export interface PermissionRequest {
  id: string;
  sessionId: string;
  toolName: ToolName;
  action: string;
  path?: string;
  description: string;
  createdAt: number;
}

export type PermissionResponse = "granted" | "denied" | "granted_session";

// ─── WebSocket Protocol ─────────────────────────────────────────────────────
// Every message over the wire follows this envelope.

export type WSEventType =
  // Agent lifecycle
  | "agent.spawned"
  | "agent.status"
  | "agent.completed"
  | "agent.error"
  // Streaming content
  | "stream.delta"
  | "stream.thinking"
  | "stream.tool_call"
  | "stream.tool_result"
  | "stream.usage"
  | "stream.complete"
  // File edit streaming (Cursor-style per-token preview)
  | "stream.file_delta"
  | "stream.file_complete"
  // Session events
  | "session.created"
  | "session.updated"
  | "session.deleted"
  | "session.changes"
  | "session.accept_changes"
  // Permission events
  | "permission.request"
  | "permission.response"
  // Provider status
  | "provider.status"
  // System
  | "system.error"
  | "system.info"
  // Kory-specific
  | "kory.thought"
  | "kory.routing"
  | "kory.verification"
  | "kory.task_breakdown"
  | "kory.ask_user";

export interface WSMessage<T = unknown> {
  type: WSEventType;
  payload: T;
  timestamp: number;
  sessionId?: string;
  agentId?: string;
}

// ─── Specific Payloads ──────────────────────────────────────────────────────

export interface AgentSpawnedPayload {
  agent: AgentIdentity;
  task: string;
  parentAgentId?: string;
}

export interface AgentStatusPayload {
  agentId: string;
  status: AgentStatus;
  detail?: string;
}

export interface StreamDeltaPayload {
  agentId: string;
  content: string;
  model: string;
}

export interface StreamThinkingPayload {
  agentId: string;
  thinking: string;
}

export interface StreamToolCallPayload {
  agentId: string;
  toolCall: ToolCall;
}

export interface StreamToolResultPayload {
  agentId: string;
  toolResult: ToolResult;
}

export interface StreamUsagePayload {
  agentId: string;
  model: string;
  provider: ProviderName;
  tokensIn: number;
  tokensOut: number;
  tokensUsed: number;
  /** True only when provider returns usage counters. */
  usageKnown: boolean;
  /** Context window size for this model (if trustworthy). */
  contextWindow?: number;
  /** True only when context window is verified for this model/provider. */
  contextKnown: boolean;
}

export interface StreamFileDeltaPayload {
  agentId: string;
  path: string;
  delta: string;
  /** Current accumulated content so far */
  totalLength: number;
  /** 'create' for new files, 'edit' for edits */
  operation: "create" | "edit";
}

export interface StreamFileCompletePayload {
  agentId: string;
  path: string;
  totalLines: number;
  operation: "create" | "edit";
}

export interface KoryThoughtPayload {
  thought: string;
  phase: "analyzing" | "routing" | "delegating" | "verifying" | "synthesizing";
}

export interface KoryRoutingPayload {
  domain: WorkerDomain;
  selectedModel: string;
  selectedProvider: ProviderName;
  reasoning: string;
}

export interface KoryTaskBreakdownPayload {
  tasks: Array<{
    id: string;
    description: string;
    domain: WorkerDomain;
    assignedModel: string;
    status: "pending" | "active" | "done" | "failed";
  }>;
}

export interface KoryAskUserPayload {
  question: string;
  options: string[];
  allowOther: boolean;
}

export interface ChangeSummary {
  path: string;
  linesAdded: number;
  linesDeleted: number;
  operation: "create" | "edit" | "delete";
}

export interface KorySessionChangesPayload {
  changes: ChangeSummary[];
}

export interface ProviderStatusPayload {
  providers: Array<{
    name: ProviderName;
    enabled: boolean;
    authenticated: boolean;
    authSource?: "API Key" | "Subscription" | "CLI session" | "Antigravity";
    models: string[];
    /** All possible models for this provider, even if not selected. Returns full definitions for UI reflection. */
    allAvailableModels: ModelDef[];
    /** The IDs of models currently selected/enabled by the user. */
    selectedModels: string[];
    hideModelSelector: boolean;
    authMode: ProviderAuthMode;
    supportsApiKey: boolean;
    supportsAuthToken: boolean;
    requiresBaseUrl: boolean;
    extraAuthModes?: Array<{ id: string; label: string; description: string }>;
    error?: string;
    circuitOpen?: boolean;
  }>;
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface KoryphaiosConfig {
  providers: Record<string, ProviderConfig>;
  agents: {
    manager: { model: string; maxTokens?: number; reasoningLevel?: string };
    coder: { model: string; maxTokens?: number; reasoningLevel?: string };
    task: { model: string; maxTokens?: number };
  };
  /** Mapping of worker domains to specific models. Example: "ui": "openai:gpt-4.1" */
  assignments?: Partial<Record<WorkerDomain, string>>;
  /** Per-model fallback chains. When a model's provider is unavailable or quota-limited,
   *  try these models in order before falling back to other available providers.
   *  Example: { "gemini-2.5-pro": ["gpt-4.1", "claude-sonnet-4-5"] } */
  fallbacks?: Record<string, string[]>;
  mcpServers?: Record<string, MCPServerConfig>;
  telegram?: {
    botToken: string;
    adminId: number;
    webhookUrl?: string;
    secretToken?: string;
  };
  server: {
    port: number;
    host: string;
  };
  contextPaths?: string[];
  dataDirectory: string;
}

export interface MCPServerConfig {
  type: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

// ─── REST API Types ─────────────────────────────────────────────────────────

export interface APIResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface SendMessageRequest {
  sessionId: string;
  content: string;
  attachments?: Array<{ type: "image" | "file"; data: string; name: string }>;
  model?: string;
  reasoningLevel?: string;
}

export interface CreateSessionRequest {
  title?: string;
  parentSessionId?: string;
}

// ─── Reasoning Configuration ─────────────────────────────────────────────
// Comprehensive reasoning config based on provider + model patterns
// Researched from official API docs (Anthropic, OpenAI, Google, Groq, xAI)

export type ReasoningLevel = string;

export interface ReasoningConfig {
  parameter: string;
  options: { value: string; label: string; description: string }[];
  defaultValue: string;
  supportsModelSpecific?: boolean;
}

type ReasoningOption = { value: string; label: string; description: string };

export const STANDARD_REASONING_OPTIONS = {
  none: { value: "none", label: "None", description: "Standard generation without explicit reasoning" },
  low: { value: "low", label: "Low", description: "Minimal reasoning effort for speed" },
  medium: { value: "medium", label: "Medium", description: "Balanced depth and speed" },
  high: { value: "high", label: "High", description: "Thorough reasoning for complex tasks" },
  xhigh: { value: "xhigh", label: "xhigh", description: "Deepest possible reasoning budget" },
  adaptive: { value: "adaptive", label: "Auto", description: "Model automatically decides reasoning level based on task" },
} as const;

const REASONING_OPTIONS = {
  ...STANDARD_REASONING_OPTIONS,
  minimal: { value: "minimal", label: "Minimal", description: "Lightest available explicit reasoning effort" },
  off: { value: "off", label: "Off", description: "Disable explicit reasoning mode" },
  on: { value: "on", label: "On", description: "Enable default reasoning mode" },
  default: { value: "default", label: "Default", description: "Provider default reasoning mode" },
  budget_0: { value: "0", label: "Off", description: "Disable thinking budget" },
  budget_1024: { value: "1024", label: "Low", description: "Thinking budget: 1,024 tokens" },
  budget_8192: { value: "8192", label: "Medium", description: "Thinking budget: 8,192 tokens" },
  budget_24576: { value: "24576", label: "High", description: "Thinking budget: 24,576 tokens" },
} as const;

interface ReasoningRule {
  provider: string;
  modelPattern?: RegExp;
  config: ReasoningConfig | null;
}

const DEFAULT_REASONING_RULES: ReasoningRule[] = [
  {
    provider: "auto",
    config: {
      parameter: "reasoning",
      options: Object.values(STANDARD_REASONING_OPTIONS),
      defaultValue: "medium",
    }
  },
  {
    provider: "anthropic",
    modelPattern: /^claude-opus-4-6/i,
    config: {
      parameter: "thinking.effort",
      options: [REASONING_OPTIONS.none, REASONING_OPTIONS.low, REASONING_OPTIONS.medium, REASONING_OPTIONS.high, REASONING_OPTIONS.xhigh],
      defaultValue: "medium",
    },
  },
  {
    provider: "anthropic",
    config: {
      parameter: "thinking.type",
      options: [REASONING_OPTIONS.off, REASONING_OPTIONS.on],
      defaultValue: "on",
    },
  },
  {
    provider: "openai",
    modelPattern: /^o1-mini/i,
    config: null,
  },
  {
    provider: "openai",
    modelPattern: /^gpt-5/i,
    config: {
      parameter: "reasoning.effort",
      options: [REASONING_OPTIONS.none, REASONING_OPTIONS.minimal, REASONING_OPTIONS.low, REASONING_OPTIONS.medium, REASONING_OPTIONS.high, REASONING_OPTIONS.xhigh],
      defaultValue: "medium",
    },
  },
  {
    provider: "openai",
    modelPattern: /^(o1|o3|o4)/i,
    config: {
      parameter: "reasoning.effort",
      options: [REASONING_OPTIONS.low, REASONING_OPTIONS.medium, REASONING_OPTIONS.high],
      defaultValue: "medium",
    },
  },
  {
    provider: "openai",
    config: null,
  },
  {
    provider: "azure",
    modelPattern: /(^azure\.)?o1-mini/i,
    config: null,
  },
  {
    provider: "azure",
    modelPattern: /(^azure\.)?gpt-5/i,
    config: {
      parameter: "reasoning.effort",
      options: [REASONING_OPTIONS.none, REASONING_OPTIONS.minimal, REASONING_OPTIONS.low, REASONING_OPTIONS.medium, REASONING_OPTIONS.high, REASONING_OPTIONS.xhigh],
      defaultValue: "medium",
    },
  },
  {
    provider: "azure",
    modelPattern: /(^azure\.)?(o1|o3|o4)/i,
    config: {
      parameter: "reasoning.effort",
      options: [REASONING_OPTIONS.low, REASONING_OPTIONS.medium, REASONING_OPTIONS.high],
      defaultValue: "medium",
    },
  },
  {
    provider: "azure",
    config: null,
  },
  {
    provider: "google",
    modelPattern: /^gemini-3/i,
    config: {
      parameter: "thinkingConfig.thinkingLevel",
      options: [REASONING_OPTIONS.low, REASONING_OPTIONS.medium, REASONING_OPTIONS.high],
      defaultValue: "medium",
    },
  },
  {
    provider: "google",
    modelPattern: /^gemini-2\.5/i,
    config: {
      parameter: "thinkingConfig.thinkingBudget",
      options: [REASONING_OPTIONS.budget_0, REASONING_OPTIONS.budget_1024, REASONING_OPTIONS.budget_8192, REASONING_OPTIONS.budget_24576],
      defaultValue: "8192",
    },
  },
  {
    provider: "google",
    config: {
      parameter: "thinkingConfig.thinkingBudget",
      options: [REASONING_OPTIONS.budget_0, REASONING_OPTIONS.budget_1024, REASONING_OPTIONS.budget_8192, REASONING_OPTIONS.budget_24576],
      defaultValue: "8192",
    },
  },
  {
    provider: "vertexai",
    modelPattern: /^vertexai\.gemini-2\.5/i,
    config: {
      parameter: "thinkingConfig.thinkingBudget",
      options: [REASONING_OPTIONS.budget_0, REASONING_OPTIONS.budget_1024, REASONING_OPTIONS.budget_8192, REASONING_OPTIONS.budget_24576],
      defaultValue: "8192",
    },
  },
  {
    provider: "vertexai",
    modelPattern: /^gemini-3/i,
    config: {
      parameter: "thinkingConfig.thinkingLevel",
      options: [REASONING_OPTIONS.low, REASONING_OPTIONS.medium, REASONING_OPTIONS.high],
      defaultValue: "medium",
    },
  },
  {
    provider: "vertexai",
    config: {
      parameter: "thinkingConfig.thinkingBudget",
      options: [REASONING_OPTIONS.budget_0, REASONING_OPTIONS.budget_1024, REASONING_OPTIONS.budget_8192, REASONING_OPTIONS.budget_24576],
      defaultValue: "8192",
    },
  },
  {
    provider: "groq",
    modelPattern: /^qwen/i,
    config: {
      parameter: "reasoning_effort",
      options: [REASONING_OPTIONS.none, REASONING_OPTIONS.default],
      defaultValue: "default",
    },
  },
  {
    provider: "groq",
    config: null,
  },
  {
    provider: "xai",
    modelPattern: /^grok-3-mini/i,
    config: {
      parameter: "reasoning_effort",
      options: [REASONING_OPTIONS.low, REASONING_OPTIONS.high],
      defaultValue: "high",
    },
  },
  {
    provider: "xai",
    config: null,
  },
  {
    provider: "openrouter",
    modelPattern: /^openrouter\.(o1|o3|o4)/i,
    config: {
      parameter: "reasoning.effort",
      options: [REASONING_OPTIONS.low, REASONING_OPTIONS.medium, REASONING_OPTIONS.high],
      defaultValue: "medium",
    },
  },
  {
    provider: "openrouter",
    config: null,
  },
  { provider: "copilot", config: null },
  {
    provider: "copilot",
    modelPattern: /codex/i,
    config: {
      parameter: "reasoning.effort",
      options: [REASONING_OPTIONS.adaptive, REASONING_OPTIONS.none, REASONING_OPTIONS.low, REASONING_OPTIONS.medium, REASONING_OPTIONS.high],
      defaultValue: "adaptive",
    },
  },
  {
    provider: "codex",
    config: {
      parameter: "reasoning.effort",
      options: [REASONING_OPTIONS.adaptive, REASONING_OPTIONS.none, REASONING_OPTIONS.low, REASONING_OPTIONS.medium, REASONING_OPTIONS.high],
      defaultValue: "adaptive",
    },
  },
  { provider: "bedrock", config: null },
  { provider: "local", config: null },
  // New providers - most OpenAI-compatible APIs don't have explicit reasoning config
  { provider: "deepseek", config: null },
  { provider: "togetherai", config: null },
  { provider: "cerebras", config: null },
  { provider: "fireworks", config: null },
  { provider: "huggingface", config: null },
  { provider: "baseten", config: null },
  { provider: "cloudflare", config: null },
  { provider: "vercel", config: null },
  { provider: "ollama", config: null },
  { provider: "ollamacloud", config: null },
  { provider: "lmstudio", config: null },
  { provider: "llamacpp", config: null },
  { provider: "minimax", config: null },
  { provider: "moonshot", config: null },
  { provider: "nebius", config: null },
  { provider: "venice", config: null },
  { provider: "deepinfra", config: null },
  { provider: "scaleway", config: null },
  { provider: "ovhcloud", config: null },
  { provider: "sapai", config: null },
  { provider: "stackit", config: null },
  { provider: "ionet", config: null },
  { provider: "zai", config: null },
  { provider: "zenmux", config: null },
  { provider: "opencodezen", config: null },
  { provider: "firmware", config: null },
  { provider: "cortecs", config: null },
  { provider: "azurecognitive", config: null },
  { provider: "gitlab", config: null },
  { provider: "antigravity", config: null },
  // Additional new providers
  { provider: "mistralai", config: null },
  { provider: "cohere", config: null },
  { provider: "perplexity", config: null },
  { provider: "luma", config: null },
  { provider: "fal", config: null },
  { provider: "replicate", config: null },
  { provider: "modal", config: null },
  { provider: "hyperbolic", config: null },
  { provider: "stepfun", config: null },
  { provider: "qwen", config: null },
  { provider: "alibaba", config: null },
  { provider: "cloudflareworkers", config: null },
  { provider: "helicone", config: null },
  { provider: "portkey", config: null },
  { provider: "elevenlabs", config: null },
  { provider: "deepgram", config: null },
  { provider: "gladia", config: null },
  { provider: "lmnt", config: null },
  { provider: "nvidia", config: null },
  { provider: "nim", config: null },
  { provider: "friendliai", config: null },
  { provider: "voyageai", config: null },
  { provider: "mixedbread", config: null },
  { provider: "mem0", config: null },
  { provider: "letta", config: null },
  { provider: "chromeai", config: null },
  { provider: "requesty", config: null },
  { provider: "aihubmix", config: null },
  { provider: "aimlapi", config: null },
  { provider: "blackforestlabs", config: null },
  { provider: "klingai", config: null },
  { provider: "prodia", config: null },
  { provider: "302ai", config: null },
  { provider: "a302ai", config: null },
  { provider: "assemblyai", config: null },
];

function normalizeProvider(provider?: string): string | undefined {
  return provider;
}

export function getReasoningConfig(provider?: string, model?: string): ReasoningConfig | null {
  const normalizedProvider = normalizeProvider(provider) || "auto";

  for (const rule of DEFAULT_REASONING_RULES) {
    if (rule.provider !== normalizedProvider) continue;
    if (rule.modelPattern && !rule.modelPattern.test(model ?? "")) continue;
    return rule.config;
  }
  return null;
}

export function hasReasoningSupport(provider?: string, model?: string): boolean {
  const config = getReasoningConfig(provider, model);
  return config !== null && config.options && config.options.length > 0;
}

export function getDefaultReasoning(provider?: string, model?: string): string {
  const config = getReasoningConfig(provider, model);
  return config?.defaultValue ?? 'medium';
}

export function normalizeReasoningLevel(
  provider: string | undefined,
  model: string | undefined,
  reasoningLevel: string | undefined,
): string | undefined {
  if (!reasoningLevel) return undefined;

  // Adaptive means let the model decide - return undefined to use provider default
  const normalizedLevel = reasoningLevel.toLowerCase().trim();
  if (normalizedLevel === "adaptive") {
    return undefined;
  }

  // Auto means manager decides based on task complexity - return undefined to let manager handle it
  if (normalizedLevel === "auto") {
    return "auto";
  }

  // If provider is specified, we try to map the standardized level to the provider's native value
  if (provider && provider !== "auto") {
    const level = normalizedLevel;

    // ─── Gemini (Budget-based) ─────────────────────────────────────────────
    if (provider === "google" || provider === "vertexai") {
      const isGemini3 = model ? /gemini-3/i.test(model) : false;
      if (isGemini3) {
        if (level === "none") return "low"; // Minimum for Gemini 3
        if (["low", "medium", "high", "xhigh"].includes(level)) return level === "xhigh" ? "high" : level;
      } else {
        if (level === "none") return "0";
        if (level === "low") return "1024";
        if (level === "medium") return "8192";
        if (level === "high") return "24576";
        if (level === "xhigh") return "65536";
      }
    }

    // ─── OpenAI / Anthropic / Groq (Effort-based) ──────────────────────────
    if (["openai", "anthropic", "groq", "xai", "azure", "openrouter"].includes(provider)) {
      if (level === "none") return "none";
      if (level === "xhigh") return "high"; // Standardize xhigh to high for effort-based
      return level; // low, medium, high are standard
    }
  }

  // Fallback: search in config options
  const config = getReasoningConfig(provider, model);
  if (!config || config.options.length === 0) return undefined;

  const value = reasoningLevel.trim().toLowerCase();
  const option = config.options.find((opt) => opt.value.toLowerCase() === value);
  if (!option) return config.defaultValue;
  return option.value;
}

/**
 * Determine reasoning level based on task complexity.
 * Used when reasoningLevel is "auto" - the manager decides the appropriate level.
 */
export function determineAutoReasoningLevel(taskDescription: string): string {
  const lower = taskDescription.toLowerCase();

  // High complexity tasks - need deep reasoning
  const highComplexityPatterns = [
    /multi-?step/i, /complex/i, /architect/i, /design/i, /refactor/i,
    /debug/i, /troubleshoot/i, /optimize/i, /implement/i, /create.*from.*scratch/i,
    /build.*system/i, /rewrite/i, /migrate/i, /restructure/i,
    /explain.*complex/i, /analyze.*entire/i, /review.*entire/i,
  ];

  // Low complexity tasks - quick responses sufficient
  const lowComplexityPatterns = [
    /simple/i, /quick/i, /basic/i, /small/i, /fix.*typo/i,
    /add.*comment/i, /format/i, /lint/i, /brief/i, /what.*is/i,
    /how.*do/i, /list/i, /show.*me/i, /read.*file/i,
  ];

  for (const pattern of highComplexityPatterns) {
    if (pattern.test(lower)) {
      return "high";
    }
  }

  for (const pattern of lowComplexityPatterns) {
    if (pattern.test(lower)) {
      return "low";
    }
  }

  // Default to medium for everything else
  return "medium";
}
