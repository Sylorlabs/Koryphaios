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
export type { AgentRole, AgentStatus, WorkerDomain, AgentIdentity } from './types/AgentTypes';

// ============== Tool System ==============
export type { ToolName, ToolCall, ToolResult } from './types/ToolTypes';

// ============== Message & Content Types ==============
export type {
  ContentBlockType,
  ContentBlock,
  Message,
  MessageAttachment,
  StoredMessage,
} from './types/MessageTypes';

// ============== Session Types ==============
export type {
  Session,
  SessionStatus,
  SessionMetadata,
  SessionSnapshot,
  SessionState,
  SessionRuntimeState,
  AgentInfo,
  TaskInfo,
} from './types/SessionTypes';

// ============== Task Types ==============
export type { WorkerTask } from './types/TaskTypes';

// ============== Process Supervision ==============
export type {
  ProcessClassification,
  ProcessProvenance,
  ProcessStatus,
  ProcessSupervision,
  ProcessTerminalReason,
} from './types/ProcessTypes';
export { isAgentBackgroundProcess } from './types/ProcessTypes';

// ============== Provider & Model Definitions ==============
export { ProviderName } from './providers/ProviderNames';

export type {
  ModelTier,
  ModelDef,
  ModelQuota,
  ProviderConfig,
  ProviderStatus,
} from './providers/ModelDefs';
export type {
  CollaborationRole,
  CollaborationJoinMode,
  CollaborationTierPermissions,
  CollaborationAccessTier,
  CollaborationPolicy,
} from './types/CollaborationTypes';
export {
  DEFAULT_COLLABORATION_POLICY,
  DEFAULT_COLLABORATION_TIERS,
} from './types/CollaborationTypes';
export type {
  ProviderShareRisk,
  ProviderShareClassification,
  SharedProviderModel,
  SharedProviderEntry,
  SharedProviderCatalog,
  ProjectSyncFile,
  ProjectSync,
  RemoteInferenceRequestPayload,
  RemoteInferenceRequestMessage,
  RemoteInferenceCancelMessage,
  RemoteInferenceEventMessage,
  RemoteInferenceDoneMessage,
  RemoteInferenceErrorMessage,
  ProviderCatalogMessage,
  RemoteProviderMessage,
} from './types/RemoteProviderTypes';
export { PROVIDER_SHARE_RISK, classifyProviderShare } from './types/RemoteProviderTypes';
export type { SandboxPreset, SandboxPolicy } from './types/SandboxTypes';
export { SANDBOX_PRESETS, DEFAULT_SANDBOX_POLICY, tightenSandbox } from './types/SandboxTypes';

// Re-export from existing providers.ts for backward compatibility
export { IMPLEMENTED_PROVIDERS, PROVIDER_AUTH_MODES, PROVIDER_ENV_VARS } from './providers';
export type { ProviderAuthMode } from './providers';

// Provider release support is intentionally separate from a machine-local
// connection state. A provider can verify on one machine while remaining
// Preview or Compatible for the release as a whole.
export {
  PROVIDER_SUPPORT,
  providerSupport,
  isProviderCertified,
  isProviderRunnableByTier,
} from './provider-support';
export type {
  ProviderSupportTier,
  ProviderCapabilityKind,
  ProviderEvidenceKind,
  ProviderSupportRecord,
} from './provider-support';

// ============== Permission System ==============
export type { PermissionRequest, PermissionResponse } from './permissions/PermissionTypes';

// ============== WebSocket Protocol ==============
export type { WSEventType, WSMessage, WSMessagePayload } from './websocket/WSEvents';

// ============== WebSocket Payloads ==============
export type {
  AgentSpawnedPayload,
  AgentStatusPayload,
  AgentHeartbeatPayload,
  AgentThreadMessagePayload,
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
  SessionIdlePayload,
  ChangeSummary,
  ChangeSummaryPayload,
  KorySessionChangesPayload,
  StreamUsagePayload,
  CompactionProgressPayload,
  ContextBreakdown,
  StreamFileDeltaPayload,
  StreamFileCompletePayload,
  StreamClearContentPayload,
  ContextDetectedPayload,
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
  NativeCommandPayload,
} from './websocket/WSPayloads';

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
} from './api/APITypes';

// ============== Reasoning Configuration ==============
export {
  getReasoningConfig,
  hasReasoningSupport,
  getDefaultReasoning,
  normalizeReasoningLevel,
  determineAutoReasoningLevel,
  DEFAULT_REASONING_RULES,
  STANDARD_REASONING_OPTIONS,
  buildReasoningConfigFromLevels,
} from './reasoning/ReasoningFunctions';
export type {
  Goal,
  GoalScope,
  GoalStatus,
  GoalItemStatus,
  GoalChecklistItem,
  GoalEvidence,
  GoalActivity,
  GoalExecutionConfig,
} from './types/GoalTypes';
export { goalProgress } from './types/GoalTypes';

export type {
  ReasoningLevel,
  ReasoningConfig,
  ReasoningOption,
  ReasoningRule,
} from './reasoning/ReasoningFunctions';

// ============== Configuration ==============
export type {
  KoryphaiosConfig,
  MCPServerConfig,
  SafetyLimits,
  WorkspaceConfig,
  ServerConfig,
  AgentSettings,
} from './config/ConfigTypes';

// ============== App Configuration ==============
export type { AppConfig } from './config';

export {
  getBackendUrl,
  getWebSocketUrl,
  getDefaultConfig,
  defaultConfig,
  parseConfig,
} from './config';

// ============== Mode System ==============
export type { UIMode, ModeConfig, UIModeConfig, ModeContext } from './types/ModeTypes';

export { MODE_DISPLAY_NAMES, MODE_DESCRIPTIONS } from './types/ModeTypes';

export {
  DEFAULT_BEGINNER_CONFIG,
  DEFAULT_ADVANCED_CONFIG,
  DEFAULT_UI_MODE_CONFIG,
  BEGINNER_TOOL_WHITELIST,
  BEGINNER_TOOL_BLACKLIST,
} from './config/ModeConfig';

// ============== Notes Network ==============
export * from './types/NoteTypes';

// ============== Voice Types ==============
export type {
  VoiceSettings,
  VoiceProviderDescriptor,
  VoicePackManifest,
  VoicePackStatus,
  TranscriptionResult,
  SynthesisRequest,
  SynthesisResult,
} from './types/VoiceTypes';

// ─────────────────────────────────────────────────────────────────────────────
// Backward Compatibility Re-exports
// ─────────────────────────────────────────────────────────────────────────────
// The following exports maintain backward compatibility with the original monolithic index.ts.
// New code should import directly from the specific modules above.
