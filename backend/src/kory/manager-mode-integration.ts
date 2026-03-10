/**
 * Mode Integration for KoryManager
 * 
 * This module provides mode-aware behavior for the KoryManager
 * without modifying the core manager.ts file extensively.
 */

import type { UIMode, ModeContext } from "@koryphaios/shared";
import { ModeManager, getModeManager } from "../mode";
import { getPrompts, type PromptTemplate } from "./prompts";
import type { GitManager } from "./git-manager";

/**
 * Mixin to add mode support to KoryManager
 * This is applied to the KoryManager to set up mode integration
 */
export function applyModeIntegration(
  manager: {
    git: GitManager;
  }
): void {
  // Initialize mode manager with git
  const modeManager = getModeManager();
  modeManager.setGitManager(manager.git);
}

/**
 * Get the current mode-aware system prompt
 */
export function getModeSystemPrompt(mode?: UIMode): string {
  const modeManager = getModeManager();
  const effectiveMode = mode ?? modeManager.getMode();
  return getPrompts(effectiveMode).managerSystem;
}

/**
 * Get the current mode-aware worker prompt
 */
export function getModeWorkerPrompt(mode?: UIMode): string {
  const modeManager = getModeManager();
  const effectiveMode = mode ?? modeManager.getMode();
  return getPrompts(effectiveMode).workerSystem;
}

/**
 * Get the current mode-aware critic prompt
 */
export function getModeCriticPrompt(mode?: UIMode): string {
  const modeManager = getModeManager();
  const effectiveMode = mode ?? modeManager.getMode();
  return getPrompts(effectiveMode).criticSystem;
}

/**
 * Get worker delegation message for current mode
 */
export function getWorkerDelegationMessage(domain: string, mode?: UIMode): string {
  const modeManager = getModeManager();
  const effectiveMode = mode ?? modeManager.getMode();
  return getPrompts(effectiveMode).workerDelegation(domain);
}

/**
 * Get critic review message for current mode
 */
export function getCriticReviewMessage(mode?: UIMode): string {
  const modeManager = getModeManager();
  const effectiveMode = mode ?? modeManager.getMode();
  return getPrompts(effectiveMode).criticReview;
}

/**
 * Get mode context for injection into prompts
 */
export function getModeContext(): ModeContext {
  const modeManager = getModeManager();
  return modeManager.getModeContext();
}

/**
 * Check if we should show the no-git-repo warning
 */
export function shouldShowNoGitWarning(): boolean {
  const modeManager = getModeManager();
  return modeManager.shouldWarnNoGitRepo();
}

/**
 * Get the no-git-repo warning message
 */
export function getNoGitWarningMessage(): string {
  const modeManager = getModeManager();
  return modeManager.getNoGitRepoWarning();
}

/**
 * Get mode-aware thought message
 */
export function getModeThought(
  type: keyof PromptTemplate["thoughts"],
  mode?: UIMode
): string {
  const modeManager = getModeManager();
  const effectiveMode = mode ?? modeManager.getMode();
  return getPrompts(effectiveMode).thoughts[type];
}

/**
 * Get mode-aware error message
 */
export function getModeError(
  type: keyof PromptTemplate["errors"],
  vars?: Record<string, string>,
  mode?: UIMode
): string {
  const modeManager = getModeManager();
  const effectiveMode = mode ?? modeManager.getMode();
  const template = getPrompts(effectiveMode).errors[type];
  
  if (!vars) return template;
  return template.replace(/\$\{(\w+)\}/g, (match, key) => vars[key] ?? match);
}

/**
 * Filter tools based on current mode
 */
export function filterToolsForMode<T extends { name: string }>(tools: T[]): T[] {
  const modeManager = getModeManager();
  return modeManager.filterTools(tools);
}

/**
 * Check if a specific tool is allowed in current mode
 */
export function isToolAllowed(toolName: string): boolean {
  const modeManager = getModeManager();
  return modeManager.isToolAllowed(toolName);
}

// Re-export for convenience
export { ModeManager, getModeManager } from "../mode";
