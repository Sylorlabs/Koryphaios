// Routes index — exports all route modules

export * from "./types";
export * from "./router";
export * from "./sessions";
export * from "./providers";
export * from "./messages";
export * from "./git";
export * from "./mode";
export * from "./memory";
export * from "./agent-settings";
export { 
  loadAgentSettings, 
  saveAgentSettings,
  initializePreferences,
  readPreferences,
  criticReview,
  assembleAgentContext,
  DEFAULT_AGENT_SETTINGS,
  type AgentSettings,
  type CriticReviewResult 
} from "../agent-settings";