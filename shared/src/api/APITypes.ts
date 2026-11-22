// REST API Types
// Domain: HTTP API contracts and request/response structures

export interface APIResponse<T = unknown> {
  ok?: boolean;
  data?: T;
  error?: string;
  message?: string;
  detail?: string;
  [key: string]: unknown;
}

export interface SendMessageRequest {
  sessionId: string;
  content: string;
  attachments?: Array<{
    type: 'image' | 'file';
    data: string;
    name: string;
    mimeType?: string;
  }>;
  model?: string;
  reasoningLevel?: string;
  /** Route-aware acceleration chosen in the composer. Codex uses its Fast tier;
   * OpenAI API uses Priority processing. Deprecated in favour of `speedTier`;
   * the API boundary normalizes it for old clients. */
  fastMode?: boolean;
  /** Faster serving tier id from the model's `speedTiers` ('fast' | 'priority' |
   * 'highspeed' | 'ultraspeed' | …). Absent means standard serving. */
  speedTier?: string;
  /** User-tunable request parameter overrides from the composer's Model
   * settings panel, keyed by the model's `parameters` entries. Unset keys
   * mean the provider's own default applies. */
  modelParameters?: Record<string, number | string>;
  /** Devin Fusion slot selection — only for the `fusion` model. */
  fusion?: {
    lead: string;
    leadEffort: string;
    leadFast: boolean;
    sidekick: string;
    sidekickEffort: string | null;
  };
  /** Explicit user decision when image support is unconfirmed. Allow retains
   * image input after the user confirms that the selected model supports it. */
  imageInputMode?: 'reject' | 'omit' | 'allow';
}

export interface CreateSessionRequest {
  title?: string;
  parentSessionId?: string;
}

export interface UpdateSessionRequest {
  title?: string;
}

export interface GetMessagesRequest {
  sessionId: string;
  limit?: number;
  before?: string; // Message ID for pagination
  after?: string; // Message ID for pagination
}

export interface DeleteSessionRequest {
  sessionId: string;
  confirm?: boolean;
}

export interface AcceptChangesRequest {
  sessionId: string;
}

export interface RejectChangesRequest {
  sessionId: string;
}

export interface ProviderConfigRequest {
  providers: Record<
    string,
    {
      apiKey?: string;
      authToken?: string;
      baseUrl?: string;
      disabled?: boolean;
    }
  >;
}

// Pagination types
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset?: number;
  hasMore: boolean;
  cursor?: string;
}
