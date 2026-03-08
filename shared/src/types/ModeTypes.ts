/**
 * Mode Types - Beginner vs Advanced mode configuration
 */

export type UIMode = "beginner" | "advanced";

export interface ModeConfig {
  /** Hide all Git UI elements */
  hideGitPanel: boolean;
  /** Automatically commit changes (beginner) or manual (advanced) */
  autoCommit: boolean;
  /** Use simplified, friendly prompts */
  simplifiedPrompts: boolean;
  /** Maximum parallel workers */
  maxWorkers: number;
  /** Require confirmations before actions */
  requireConfirmations: boolean;
  /** Tools available in this mode (whitelist for beginner, blacklist for advanced) */
  toolAccess: "curated" | "full";
  /** Explanation verbosity */
  explanations: "verbose" | "minimal";
  /** Enable shadow logger UI */
  enableShadowLoggerUI: boolean;
  /** Enable git worktrees */
  enableWorktrees: boolean;
  /** Enable critic gate */
  enableCriticGate: boolean;
  /** Show agent cards and technical details */
  showAgentDetails: boolean;
  /** Show cost/token tracking */
  showCostTracking: boolean;
}

export interface UIModeConfig {
  /** Current mode or adaptive */
  mode: UIMode | "adaptive";
  /** Number of sessions before suggesting advanced (adaptive mode) */
  adaptiveThreshold?: number;
  /** Beginner mode settings */
  beginner: ModeConfig;
  /** Advanced mode settings */
  advanced: ModeConfig;
}

/** Mode context passed to agents */
export interface ModeContext {
  mode: UIMode;
  config: ModeConfig;
  /** Whether git is available */
  hasGitRepo: boolean;
}

/** User-friendly mode names */
export const MODE_DISPLAY_NAMES: Record<UIMode, string> = {
  beginner: "Beginner",
  advanced: "Advanced",
};

/** Mode descriptions for UI */
export const MODE_DESCRIPTIONS: Record<UIMode, string> = {
  beginner: "Simple and guided - I'll handle the technical details",
  advanced: "Full control - Access all features and Git operations",
};
