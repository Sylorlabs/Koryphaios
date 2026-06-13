// Provider abstraction layer — modeled after OpenCode's baseProvider pattern.
// Each provider implements a uniform streaming interface regardless of underlying API.

import type { ModelDef, ProviderConfig, ProviderName } from '@koryphaios/shared';

// Export model catalog and helpers from the new modular structure
export * from './models';

// ─── Provider Events (streaming protocol) ───────────────────────────────────

export type ProviderEventType =
  | 'content_delta'
  | 'thinking_delta'
  | 'tool_use_start'
  | 'tool_use_delta'
  | 'tool_use_stop'
  | 'usage_update'
  // Emitted by AGENTIC providers (CLI harnesses like claude-code) that execute their own
  // tools internally. Unlike tool_use_*, these are already-done actions to DISPLAY, not to
  // execute — the manager surfaces them (live file preview / tool feed) without re-running.
  | 'file_edit'
  | 'tool_executed'
  | 'complete'
  | 'error';

export interface ProviderEvent {
  type: ProviderEventType;
  content?: string;
  thinking?: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: string;
  tokensIn?: number;
  tokensOut?: number;
  tokensCache?: number; // Added for caching support
  finishReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop';
  error?: string;
  // file_edit (agentic providers): a file the agent just created/edited.
  filePath?: string;
  fileContent?: string;
  fileOldContent?: string;
  fileOperation?: 'create' | 'edit';
  // tool_executed (agentic providers): a non-file tool the agent already ran.
  toolOutput?: string;
  isError?: boolean;
}

// ─── Tool definition for provider calls ─────────────────────────────────────

export interface ProviderToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ─── Message format for provider calls ──────────────────────────────────────

/** Minimal tool call shape for assistant messages so APIs accept following "tool" messages. */
export interface ProviderToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ProviderMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ProviderContentBlock[];
  /** Required for role "tool": ID of the tool call this result belongs to. */
  tool_call_id?: string;
  /** Required when following messages have role "tool": assistant must include tool_calls. */
  tool_calls?: ProviderToolCall[];
}

export interface ProviderContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  isError?: boolean;
  imageData?: string;
  imageMimeType?: string;
}

// ─── Stream request ─────────────────────────────────────────────────────────

export interface StreamRequest {
  model: string;
  messages: ProviderMessage[];
  systemPrompt: string;
  tools?: ProviderToolDef[];
  maxTokens?: number;
  temperature?: number;
  /** For reasoning models — never restrict this. Can be "low"|"medium"|"high" or provider-specific like "8192" */
  reasoningLevel?: string;
  /** Signal to abort the stream */
  signal?: AbortSignal;
  /** Project working directory — agentic CLI providers (claude-code) run + edit files here. */
  workingDirectory?: string;
}

// ─── Provider interface ─────────────────────────────────────────────────────

export interface Provider {
  readonly name: ProviderName;
  readonly config: ProviderConfig;

  /** Stream a response from the model. Yields events as they arrive. */
  streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent>;

  /** Check if this provider is configured and authenticated. */
  isAvailable(): boolean;

  /** List models available for this provider. */
  listModels(): ModelDef[];
}

// ─── Provider factory ───────────────────────────────────────────────────────

export type ProviderFactory = (config: ProviderConfig) => Provider;
