export * from './critic-mode';
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
// - providers/ProviderNames.ts: Provider registry (63 providers)
// - providers/ModelDefs.ts: Model definitions and provider config
// - websocket/WSEvents.ts: WebSocket event types
// - websocket/WSPayloads.ts: WebSocket payload types
// - api/APITypes.ts: REST API contracts
// - reasoning/ReasoningFunctions.ts: Reasoning configuration and utilities
// - config/ConfigTypes.ts: Application configuration
// - permissions/PermissionTypes.ts: Permission system
//
// ─────────────────────────────────────────────────────────────────────────────

export * from './computer-use';
export * from './git-workspace';
export * from './chat-git';
export * from './review-comments';
export * from './git-hunks';
export * from './pull-request-status';
export * from './provider-execution';
export * from './provider-permission-enforcement';
export * from './desktop-ui-settings';
export * from './notes/NoteIcons';
export * from './notes/NoteIconEmojiCatalog';
export * from './project-identity';
export * from './remote-target';
export * from './compute-delegation';
export * from './agent-controls';
export * from './run/RunRefs';
export * from './transcript';
export * from './source-control';
export * from './remote-protocol';
export * from './updates';

// ============== Agent & Worker Types ==============
export type { AgentRole, AgentStatus, WorkerDomain, AgentIdentity } from './types/AgentTypes';
export type { AgentSteeringCommand, AgentSteeringStatus } from './types/AgentSteeringTypes';

// ============== Tool System ==============
export type { ToolName, ToolCall, ToolResult } from './types/ToolTypes';

// ============== Message & Content Types ==============
export type {
  ContentBlockType,
  ContentBlock,
  ImportedTokenUsage,
  Message,
  MessageAttachment,
  StoredMessage,
} from './types/MessageTypes';

// ============== Session Types ==============
export type {
  Session,
  SessionAgentOverrides,
  SessionManagerControl,
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

// ============== Inter-Agent Messaging ==============
export type {
  AgentMessage,
  AgentMessagePartyRole,
  AgentMessageStatus,
  AgentMessageEventPayload,
} from './types/MessagingTypes';

export * from './messaging-permissions';

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
export { ProviderName, isValidProvider } from './providers/ProviderNames';

export type {
  ModelTier,
  ModelDef,
  ModelSpeedTier,
  ModelQuota,
  ProviderConfig,
  ProviderStatus,
  AcpAgentProviderConfig,
} from './providers/ModelDefs';
export type {
  ModelParameterKey,
  ModelParameterDef,
  ModelParameterValues,
} from './providers/model-parameters';
export {
  MODEL_PARAMETER_SPECS,
  HARNESS_OWNED_PARAMETER_KEYS,
  buildModelParameters,
  sanitizeModelParameterValues,
} from './providers/model-parameters';
export type {
  FusionCatalog,
  FusionPairingMeta,
  FusionSelection,
  FusionSlotOption,
} from './providers/ModelDefs';
export {
  splitFusionSlug,
  fusionPairingKey,
  resolveFusionSlug,
  fusionSidekickSpeedLabel,
  isFusionPairingAvailable,
  availableSidekicks,
  leadFastAvailable,
  adjustFusionSelection,
  parseFusionSlug,
} from './providers/fusion';
export type {
  CollaborationRole,
  CollaborationJoinMode,
  CollaborationTierPermissions,
  CollaborationAccessTier,
  CollaborationPolicy,
  SharedTeamFolder,
} from './types/CollaborationTypes';
export {
  DEFAULT_COLLABORATION_POLICY,
  DEFAULT_COLLABORATION_TIERS,
  sharedTeamFolders,
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
export {
  IMPLEMENTED_PROVIDERS,
  PROVIDER_AUTH_MODES,
  PROVIDER_ENV_VARS,
  RETIRED_PROVIDER_NAMES,
} from './providers';
export type { ProviderAuthMode } from './providers';

// Provider release support is intentionally separate from a machine-local
// connection state. A provider can verify on one machine while remaining
// Preview or Compatible for the release as a whole.
export {
  PROVIDER_SUPPORT,
  providerSupport,
  isProviderCertified,
  isProviderRunnableByTier,
  isProviderCapabilityOnly,
  providerCapabilityKinds,
  capabilityAdapterProviders,
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
export type {
  WSEventType,
  WSMessage,
  WSMessagePayload,
  SessionWSMessage,
} from './websocket/WSEvents';
export {
  SESSION_SCOPED_EVENT_TYPES,
  isSessionScopedEventType,
  hasRequiredSessionIdentity,
} from './websocket/WSEvents';
export {
  SESSION_RUN_ACTIVE_PHASES,
  SESSION_RUN_WAITING_PHASES,
  SESSION_RUN_TERMINAL_PHASES,
  SessionRunTransitionError,
  createIdleSessionRun,
  reduceSessionRun,
  sessionRunStatusForPhase,
} from './run/SessionRun';
export type {
  SessionRunActivePhase,
  SessionRunWaitingPhase,
  SessionRunTerminalPhase,
  SessionRunPhase,
  SessionRunStatus,
  SessionRunSnapshot,
  SessionRunCommand,
  SessionRunTransition,
  SessionRunStatePayload,
} from './run/SessionRun';

// ============== WebSocket Payloads ==============
export type {
  AgentSpawnedPayload,
  AgentStatusPayload,
  AgentHeartbeatPayload,
  AgentThreadMessagePayload,
  AgentSteeringQueuePayload,
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
  SessionTimelineRewrittenPayload,
  SessionHistoryPrunedPayload,
  ChangeSummary,
  ChangeSummaryPayload,
  KorySessionChangesPayload,
  KorySessionChangesResolvedPayload,
  KoryAskUserResolvedPayload,
  SessionActionableWaitsPayload,
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
  KorySkillPayload,
  KorySkillUse,
  KoryTaskBreakdownPayload,
  KoryAskUserPayload,
  KoryVerificationPayload,
  ProviderStatusPayload,
  ProviderInfo,
  RateLimitPayload,
  NativeCommandPayload,
  StreamCompletePayload,
  TurnProviderCompletedPayload,
  RunSettledPayload,
  RunSettledOutcome,
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
  resolveReasoningLevel,
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
  Checklist,
  ChecklistItem,
  ChecklistItemStatus,
  ChecklistScope,
  ChecklistActivity,
  ChecklistMutation,
  ChecklistToolName,
} from './types/ChecklistTypes';
export {
  checklistProgress,
  CHECKLIST_TOOL_NAMES,
  isChecklistToolName,
} from './types/ChecklistTypes';

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

// ============== Notes Network ==============
export * from './types/NoteTypes';
export * from './types/NoteWorkspaceTypes';
export * from './notes/NoteProperties';
export * from './notes/NoteCanvas';
export * from './notes/NoteWorkspaceTools';
export * from './notes/NotePermissionPolicy';
export * from './notes/NoteWorkspaceTemplates';
export * from './notes/NoteAppearanceMeta';

// ============== Voice Types ==============
export type {
  VoiceSettings,
  VoiceProviderDescriptor,
  TranscriptionResult,
  SynthesisRequest,
  SynthesisResult,
} from './types/VoiceTypes';

// ============== Chat Media ==============
export { MAX_CHAT_MEDIA_BYTES, chatMediaMimeType, chatMediaKind } from './media';

// ─────────────────────────────────────────────────────────────────────────────
// Backward Compatibility Re-exports
// ─────────────────────────────────────────────────────────────────────────────
// The following exports maintain backward compatibility with the original monolithic index.ts.
// New code should import directly from the specific modules above.
export {
  hasOpaqueContextHarness,
  reconcileContextBreakdown,
  boundOpaqueCumulativeOccupancy,
  CLI_HARNESS_ESTIMATE_FLOOR_TOKENS,
  CLI_HARNESS_ESTIMATE_CEILING_TOKENS,
  type BoundedOpaqueOccupancy,
} from './context-accounting';
export type { FreebuffBalance, FreebuffAccountSnapshot } from './freebuff-billing';
