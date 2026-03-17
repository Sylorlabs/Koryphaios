/**
 * Memory System Configuration
 * 
 * Configuration constants and path resolution for the memory system.
 */

import { join } from "node:path";
import { homedir } from "node:os";

// ============================================================================
// Configuration
// ============================================================================

export const MEMORY_CONFIG = {
  // Directory names (relative to project root or home)
  UNIVERSAL_MEMORY_DIR: ".koryphaios/universal-memory",
  PROJECT_MEMORY_DIR: ".koryphaios/project-memory",
  SESSIONS_DIR: ".koryphaios/sessions",
  RULES_FILE: ".koryrules",
  
  // File names
  UNIVERSAL_MEMORY_FILE: "universal-memory.md",
  PROJECT_MEMORY_FILE: "project-memory.md",
  SESSION_MEMORY_FILE: "memory.md",
  
  // Settings
  MAX_MEMORY_SIZE: 100_000, // 100KB max per memory file
  MAX_RULES_SIZE: 50_000,   // 50KB max for rules
} as const;

// ============================================================================
// Path Resolution
// ============================================================================

/**
 * Get the project root directory
 */
export function getProjectRoot(): string {
  // In production, this should be passed from the server
  return process.env.PROJECT_ROOT ?? process.cwd();
}

/**
 * Get universal memory path (in user's home directory)
 */
export function getUniversalMemoryPath(): string {
  return join(homedir(), MEMORY_CONFIG.UNIVERSAL_MEMORY_DIR, MEMORY_CONFIG.UNIVERSAL_MEMORY_FILE);
}

/**
 * Get project memory path
 */
export function getProjectMemoryPath(projectRoot: string): string {
  return join(projectRoot, MEMORY_CONFIG.PROJECT_MEMORY_DIR, MEMORY_CONFIG.PROJECT_MEMORY_FILE);
}

/**
 * Get session memory path
 */
export function getSessionMemoryPath(projectRoot: string, sessionId: string): string {
  return join(projectRoot, MEMORY_CONFIG.SESSIONS_DIR, sessionId, MEMORY_CONFIG.SESSION_MEMORY_FILE);
}

/**
 * Get .koryrules path
 */
export function getRulesPath(projectRoot: string): string {
  return join(projectRoot, MEMORY_CONFIG.RULES_FILE);
}

/**
 * Get memory settings path
 */
export function getSettingsPath(projectRoot: string): string {
  return join(projectRoot, ".koryphaios/memory-settings.json");
}
