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
  attachments?: Array<{ type: "image" | "file"; data: string; name: string }>;
  model?: string;
  reasoningLevel?: string;
}

export interface CreateSessionRequest {
  title?: string;
  parentSessionId?: string;
}

export interface UpdateSessionRequest {
  title?: string;
  status?: "active" | "archived";
}

export interface GetMessagesRequest {
  sessionId: string;
  limit?: number;
  before?: string;  // Message ID for pagination
  after?: string;   // Message ID for pagination
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
  providers: Record<string, {
    apiKey?: string;
    authToken?: string;
    baseUrl?: string;
    disabled?: boolean;
  }>;
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
