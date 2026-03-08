/**
 * Mode Manager - Handles UI mode state and configuration
 */

import type { 
  UIMode, 
  ModeConfig, 
  ModeContext,
  UIModeConfig 
} from "@koryphaios/shared";
import { 
  DEFAULT_UI_MODE_CONFIG,
  DEFAULT_BEGINNER_CONFIG,
  DEFAULT_ADVANCED_CONFIG,
  BEGINNER_TOOL_WHITELIST,
} from "@koryphaios/shared";
import { getPrompts, type PromptTemplate } from "../kory/prompts";
import type { GitManager } from "../kory/git-manager";

export class ModeManager {
  private currentMode: UIMode = "beginner";
  private config: UIModeConfig;
  private gitManager: GitManager | null = null;

  constructor(config?: Partial<UIModeConfig>) {
    this.config = {
      ...DEFAULT_UI_MODE_CONFIG,
      ...config,
      beginner: { ...DEFAULT_BEGINNER_CONFIG, ...config?.beginner },
      advanced: { ...DEFAULT_ADVANCED_CONFIG, ...config?.advanced },
    };
    
    // Set initial mode
    if (this.config.mode !== "adaptive") {
      this.currentMode = this.config.mode;
    }
  }

  /**
   * Set the GitManager for checking repo status
   */
  setGitManager(gitManager: GitManager): void {
    this.gitManager = gitManager;
  }

  /**
   * Get current mode
   */
  getMode(): UIMode {
    return this.currentMode;
  }

  /**
   * Set mode explicitly
   */
  setMode(mode: UIMode): void {
    this.currentMode = mode;
  }

  /**
   * Toggle between beginner and advanced
   */
  toggleMode(): UIMode {
    this.currentMode = this.currentMode === "beginner" ? "advanced" : "beginner";
    return this.currentMode;
  }

  /**
   * Get current mode configuration
   */
  getModeConfig(): ModeConfig {
    return this.currentMode === "beginner" 
      ? this.config.beginner 
      : this.config.advanced;
  }

  /**
   * Get full mode context for agents
   */
  getModeContext(): ModeContext {
    return {
      mode: this.currentMode,
      config: this.getModeConfig(),
      hasGitRepo: this.gitManager?.isGitRepo() ?? false,
    };
  }

  /**
   * Get prompts for current mode
   */
  getPrompts(): PromptTemplate {
    return getPrompts(this.currentMode);
  }

  /**
   * Check if a tool is allowed in current mode
   */
  isToolAllowed(toolName: string): boolean {
    const modeConfig = this.getModeConfig();
    
    if (modeConfig.toolAccess === "full") {
      return true;
    }
    
    // Curated mode - check whitelist
    return BEGINNER_TOOL_WHITELIST.includes(toolName);
  }

  /**
   * Filter tools for current mode
   */
  filterTools<T extends { name: string }>(tools: T[]): T[] {
    const modeConfig = this.getModeConfig();
    
    if (modeConfig.toolAccess === "full") {
      return tools;
    }
    
    return tools.filter(t => BEGINNER_TOOL_WHITELIST.includes(t.name));
  }

  /**
   * Check if Git panel should be hidden
   */
  shouldHideGitPanel(): boolean {
    return this.getModeConfig().hideGitPanel;
  }

  /**
   * Check if auto-commit is enabled
   */
  shouldAutoCommit(): boolean {
    return this.getModeConfig().autoCommit;
  }

  /**
   * Check if agent details should be shown
   */
  shouldShowAgentDetails(): boolean {
    return this.getModeConfig().showAgentDetails;
  }

  /**
   * Check if cost tracking should be shown
   */
  shouldShowCostTracking(): boolean {
    return this.getModeConfig().showCostTracking;
  }

  /**
   * Get max workers for current mode
   */
  getMaxWorkers(): number {
    return this.getModeConfig().maxWorkers;
  }

  /**
   * Check if confirmations are required
   */
  requireConfirmations(): boolean {
    return this.getModeConfig().requireConfirmations;
  }

  /**
   * Check if worktrees are enabled
   */
  areWorktreesEnabled(): boolean {
    return this.getModeConfig().enableWorktrees;
  }

  /**
   * Check if critic gate is enabled
   */
  isCriticGateEnabled(): boolean {
    return this.getModeConfig().enableCriticGate;
  }

  /**
   * Get formatted thought message
   */
  getThought(type: keyof PromptTemplate["thoughts"]): string {
    return this.getPrompts().thoughts[type];
  }

  /**
   * Get error message for current mode
   */
  getError(type: keyof PromptTemplate["errors"], vars?: Record<string, string>): string {
    const template = this.getPrompts().errors[type];
    if (!vars) return template;
    
    // Simple variable substitution
    return template.replace(/\$\{(\w+)\}/g, (match, key) => vars[key] ?? match);
  }

  /**
   * Check if we should warn about missing git repo (beginner mode only)
   */
  shouldWarnNoGitRepo(): boolean {
    if (this.currentMode !== "beginner") return false;
    return !this.gitManager?.isGitRepo();
  }

  /**
   * Get no-repo warning message
   */
  getNoGitRepoWarning(): string {
    return this.getPrompts().errors.noGitRepo;
  }
}

// Singleton instance
let modeManagerInstance: ModeManager | null = null;

export function getModeManager(config?: Partial<UIModeConfig>): ModeManager {
  if (!modeManagerInstance) {
    modeManagerInstance = new ModeManager(config);
  }
  return modeManagerInstance;
}

export function resetModeManager(): void {
  modeManagerInstance = null;
}
