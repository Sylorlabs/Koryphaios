// Kory Manager — modular entry point.
//
// This module re-exports the KoryManager from the core implementation and
// bundles the extracted service modules that were refactored out of manager.ts.
// server.ts imports KoryManager from here, keeping the monolith (manager.ts)
// as the implementation detail and this file as the public API boundary.

// ─── Core Manager (100% feature parity with manager.ts) ────────────────────

export { KoryManager } from "./manager";
export type { KoryTask } from "./manager";

// ─── Extracted Services ────────────────────────────────────────────────────

export {
  clarificationService,
  parseClarificationDecision,
  resolveClarificationDecision,
  CLARIFICATION_SYSTEM_PROMPT,
} from "./clarification-service";
export type { ClarificationDecision } from "./clarification-service";

export { RoutingService } from "./routing-service";
export type { RoutingDecision, RoutingServiceDependencies } from "./routing-service";

export {
  WebSocketEmitter,
  initWebSocketEmitter,
  getWebSocketEmitter,
} from "./websocket-emitter";

export { AgentLifecycleManager } from "./agent-lifecycle-manager";
export type {
  WorkerState,
  WorkerUsage,
  AgentLifecycleManagerDependencies,
} from "./agent-lifecycle-manager";

export { MessageProcessor } from "./message-processor";
export type {
  ProcessTurnResult,
  CompletedToolCall,
  MessageProcessorDependencies,
} from "./message-processor";
