// Wire-adapter abstraction: translation plugins that let a custom provider
// speak HTTP dialects outside the three SDK families (OpenAI / Anthropic /
// Gemini). An adapter converts Koryphaios's canonical chat request into the
// dialect's wire shape and maps the dialect's stream events back into
// canonical terms; WireAdapterProvider owns the transport (fetch, SSE/JSONL
// framing, abort, event accumulation) so adapters stay small and testable.

import type { ProviderConfig } from '@koryphaios/shared';
import type { ProviderMessage, ProviderToolDef } from '../types';

/** Canonical chat request handed to an adapter for translation. */
export interface WireAdapterChatRequest {
  model: string;
  /** Pre-pended as a system message by the caller when the dialect has no
   *  dedicated system field; adapters decide how to place it. */
  systemPrompt: string;
  messages: ProviderMessage[];
  tools?: ProviderToolDef[];
  maxTokens?: number;
  temperature?: number;
}

/** Endpoint + credential context for one adapter request. */
export interface WireAdapterRequestContext {
  config: ProviderConfig;
  /** Normalized base URL without a trailing slash. */
  baseUrl: string;
  credential?: string;
  extraHeaders?: Record<string, string>;
}

/** The exact HTTP request the dialect expects. */
export interface WireAdapterHttpRequest {
  /** Appended to the base URL (starts with '/'). */
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

/** One parsed stream step expressed in canonical terms. */
export interface WireAdapterStreamChunk {
  contentDelta?: string;
  thinkingDelta?: string;
  toolCall?: {
    /** Stable call id; the provider generates one when the dialect omits it. */
    id?: string;
    name?: string;
    /** Incremental JSON arguments fragment (streamed dialects). */
    argsDelta?: string;
    /** Complete arguments object — serialized once by the provider. */
    argsObject?: Record<string, unknown>;
  };
  finishReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop';
  usage?: {
    tokensIn?: number;
    tokensOut?: number;
    tokensCacheRead?: number;
    tokensCacheWrite?: number;
  };
}

/** How the provider frames the response body before parseEvent. */
export type WireAdapterStreamFormat = 'jsonl' | 'sse';

export interface WireAdapter {
  id: string;
  /** Human label shown in the settings override dropdown. */
  label: string;
  /** One-line description shown under the dropdown. */
  description: string;
  streamFormat: WireAdapterStreamFormat;
  /** Distinctive catalog paths probed during auto-detection (in addition to
   *  the three SDK families' paths). Empty = manual override only. */
  catalogPaths: string[];
  /** Recognize this adapter's catalog payload. `path` is the probe suffix
   *  that produced the payload, for disambiguation. */
  matchCatalog(payload: unknown, path?: string): boolean;
  /** Translate the canonical request into the dialect's wire shape. */
  buildChatRequest(
    request: WireAdapterChatRequest,
    ctx: WireAdapterRequestContext,
  ): WireAdapterHttpRequest;
  /** Map one parsed stream object to canonical terms, or null to skip. */
  parseEvent(raw: unknown): WireAdapterStreamChunk | null;
}
