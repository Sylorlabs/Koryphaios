// Kory Manager — modular entry point.
//
// This module re-exports the KoryManager from the core implementation and
// bundles the extracted service modules that were refactored out of manager.ts.
// server.ts imports KoryManager from here, keeping the implementation
// in manager.ts as the detail and this file as the public API boundary.

// Core Manager (refactored with service decomposition)
export { KoryManager } from "./manager";
export type { KoryTask } from "./agent-lifecycle-manager";

// Extracted Services (for advanced usage/testing)
export { ClarificationService } from "./services/ClarificationService";
export { RoutingService } from "./services/RoutingService";
export { SessionStateService } from "./services/SessionStateService";
export { CriticReviewService } from "./services/CriticReviewService";
export { UserInteractionService } from "./services/UserInteractionService";
export { WorkerOrchestrationService } from "./services/WorkerOrchestrationService";

// Supporting modules
export { GitManager } from "./git-manager";
export { WorkspaceManager } from "./workspace-manager";
export { AutoCommitService } from "./auto-commit-service";
export { AgentLifecycleManager } from "./agent-lifecycle-manager";
export {
  WebSocketEmitter,
  initWebSocketEmitter,
  getWebSocketEmitter,
} from "./websocket-emitter";

// Utility exports
export * from "./utils";
