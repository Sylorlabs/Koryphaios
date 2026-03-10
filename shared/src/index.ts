// Koryphaios Shared Types — The contract between backend and frontend.
//
// This file now serves as the main export point, re-exporting from domain-specific modules.
// The original monolithic 1079-line file has been split into focused modules:
//
// Module Structure:
// - types/AgentTypes.ts: Agent roles, status, identity
// - types/ToolTypes.ts: Tool system types
// - types/MessageTypes.ts: Message and content blocks
// - types/SessionTypes.ts: Session management
// - types/TaskTypes.ts: Task types
// - providers/ProviderNames.ts: Provider registry (59 providers)
// - providers/ModelDefs.ts: Model definitions and provider config
// - websocket/WSEvents.ts: WebSocket event types
// - websocket/WSPayloads.ts: WebSocket payload types
// - api/APITypes.ts: REST API contracts
// - reasoning/ReasoningFunctions.ts: Reasoning configuration and utilities
// - config/ConfigTypes.ts: Application configuration
// - permissions/PermissionTypes.ts: Permission system
//
// ─────────────────────────────────────────────────────────────────────────────

// ============== Agent & Worker Types ==============
export type {
  AgentRole,
  AgentStatus,
  WorkerDomain,
  AgentIdentity,
} from "./types/AgentTypes";

// ============== Tool System ==============
export type {
  ToolName,
  ToolCall,
  ToolResult,
} from "./types/ToolTypes";

// ============== Message & Content Types ==============
export type {
  ContentBlockType,
  ContentBlock,
  Message,
  StoredMessage,
} from "./types/MessageTypes";

// ============== Session Types ==============
export type {
  Session,
  SessionStatus,
  SessionMetadata,
  SessionSnapshot,
  SessionState,
  AgentInfo,
  TaskInfo,
} from "./types/SessionTypes";

// ============== Task Types ==============
export type { WorkerTask } from "./types/TaskTypes";

// ============== Provider & Model Definitions ==============
export { ProviderName } from "./providers/ProviderNames";

export type {
  ModelTier,
  ModelDef,
  ProviderConfig,
  ProviderStatus,
} from "./providers/ModelDefs";

// Re-export from existing providers.ts for backward compatibility
export {
  IMPLEMENTED_PROVIDERS,
  PROVIDER_AUTH_MODES,
  PROVIDER_ENV_VARS,
} from "./providers";

export type { ProviderAuthMode } from "./providers";

// ============== Permission System ==============
export type {
  PermissionRequest,
  PermissionResponse,
} from "./permissions/PermissionTypes";

// ============== WebSocket Protocol ==============
export type {
  WSEventType,
  WSMessage,
  WSMessagePayload,
} from "./websocket/WSEvents";

// ============== WebSocket Payloads ==============
export type {
  AgentSpawnedPayload,
  AgentStatusPayload,
  ThinkingPayload,
  StreamThinkingPayload,
  StreamDeltaPayload,
  MessagePendingPayload,
  MessageDeltaPayload,
  MessageCompletePayload,
  ToolCallPayload,
  StreamToolCallPayload,
  StreamToolResultPayload,
  SessionCreatedPayload,
  SessionUpdatedPayload,
  ChangeSummary,
  ChangeSummaryPayload,
  KorySessionChangesPayload,
  StreamUsagePayload,
  StreamFileDeltaPayload,
  StreamFileCompletePayload,
  ErrorPayload,
  NotificationPayload,
  KoryThoughtPayload,
  KoryRoutingPayload,
  KoryTaskBreakdownPayload,
  KoryAskUserPayload,
  KoryVerificationPayload,
  ProviderStatusPayload,
  ProviderInfo,
  RateLimitPayload,
} from "./websocket/WSPayloads";

// ============== REST API Types ==============
export type {
  APIResponse,
  SendMessageRequest,
  CreateSessionRequest,
  UpdateSessionRequest,
  GetMessagesRequest,
  DeleteSessionRequest,
  AcceptChangesRequest,
  RejectChangesRequest,
  ProviderConfigRequest,
  PaginatedResponse,
} from "./api/APITypes";

// ============== Reasoning Configuration ==============
export {
  getReasoningConfig,
  hasReasoningSupport,
  getDefaultReasoning,
  normalizeReasoningLevel,
  determineAutoReasoningLevel,
  DEFAULT_REASONING_RULES,
  STANDARD_REASONING_OPTIONS,
} from "./reasoning/ReasoningFunctions";

export type {
  ReasoningLevel,
  ReasoningConfig,
  ReasoningOption,
  ReasoningRule,
} from "./reasoning/ReasoningFunctions";

// ============== Configuration ==============
export type {
  KoryphaiosConfig,
  MCPServerConfig,
  SafetyLimits,
  WorkspaceConfig,
  TelegramConfig,
  DiscordConfig,
  SlackConfig,
  ServerConfig,
} from "./config/ConfigTypes";

// ============== App Configuration ==============
export type {
  AppConfig,
} from "./config";

export {
  getBackendUrl,
  getWebSocketUrl,
  getDefaultConfig,
  defaultConfig,
  parseConfig,
} from "./config";

// ============== Mode System ==============
export type {
  UIMode,
  ModeConfig,
  UIModeConfig,
  ModeContext,
} from "./types/ModeTypes";

export {
  MODE_DISPLAY_NAMES,
  MODE_DESCRIPTIONS,
} from "./types/ModeTypes";

export {
  DEFAULT_BEGINNER_CONFIG,
  DEFAULT_ADVANCED_CONFIG,
  DEFAULT_UI_MODE_CONFIG,
  BEGINNER_TOOL_WHITELIST,
  BEGINNER_TOOL_BLACKLIST,
} from "./config/ModeConfig";

// ─────────────────────────────────────────────────────────────────────────────
// Backward Compatibility Re-exports
// ─────────────────────────────────────────────────────────────────────────────
// The following exports maintain backward compatibility with the original monolithic index.ts.
// New code should import directly from the specific modules above.
