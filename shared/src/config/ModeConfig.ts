/**
 * Default Mode Configuration
 */
import type { UIModeConfig, ModeConfig } from "../types/ModeTypes";

export const DEFAULT_BEGINNER_CONFIG: ModeConfig = {
  hideGitPanel: true,
  autoCommit: true,
  simplifiedPrompts: true,
  maxWorkers: 2,
  requireConfirmations: false,
  toolAccess: "curated",
  explanations: "verbose",
  enableShadowLoggerUI: false,
  enableWorktrees: false,
  enableCriticGate: false,
  showAgentDetails: false,
  showCostTracking: false,
};

export const DEFAULT_ADVANCED_CONFIG: ModeConfig = {
  hideGitPanel: false,
  autoCommit: false,
  simplifiedPrompts: false,
  maxWorkers: 8,
  requireConfirmations: true,
  toolAccess: "full",
  explanations: "minimal",
  enableShadowLoggerUI: true,
  enableWorktrees: true,
  enableCriticGate: true,
  showAgentDetails: true,
  showCostTracking: true,
};

export const DEFAULT_UI_MODE_CONFIG: UIModeConfig = {
  mode: "beginner",
  adaptiveThreshold: 10,
  beginner: DEFAULT_BEGINNER_CONFIG,
  advanced: DEFAULT_ADVANCED_CONFIG,
};

/** Tools available in beginner mode (curated whitelist) */
export const BEGINNER_TOOL_WHITELIST = [
  "read_file",
  "write_file",
  "edit_file",
  "bash",
  "web_search",
  "web_fetch",
  "ask_user",
];

/** Tools excluded from beginner mode */
export const BEGINNER_TOOL_BLACKLIST = [
  "delegate_to_worker",
  "shell_manage",
  "delete_file",
  "move_file",
  "diff",
  "patch",
];
