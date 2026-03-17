/**
 * Unified Memory System
 * 
 * A comprehensive memory and rules management system that provides:
 * - Universal Memory: Global across all projects
 * - Project Memory: Specific to current project
 * - Session Memory: Per-chat persistent storage
 * - Koryphaios-style Rules: .koryrules file support
 * 
 * All files are stored relative to the project for portability.
 * 
 * This file re-exports all memory system modules for backward compatibility.
 * Consider importing directly from the specific module files for new code.
 */

// ============================================================================
// Re-exports from types.ts
// ============================================================================

export type {
  MemoryFile,
  MemorySettings,
  MemoryContext,
  MemoryStats,
} from "./types";

export { DEFAULT_MEMORY_SETTINGS } from "./types";

// ============================================================================
// Re-exports from config.ts
// ============================================================================

export { MEMORY_CONFIG } from "./config";

export {
  getProjectRoot,
  getUniversalMemoryPath,
  getProjectMemoryPath,
  getSessionMemoryPath,
  getRulesPath,
  getSettingsPath,
} from "./config";

// ============================================================================
// Re-exports from universal.ts
// ============================================================================

export {
  initializeUniversalMemory,
  readUniversalMemory,
  writeUniversalMemory,
} from "./universal";

// ============================================================================
// Re-exports from project.ts
// ============================================================================

export {
  initializeProjectMemory,
  readProjectMemory,
  writeProjectMemory,
} from "./project";

// ============================================================================
// Re-exports from session.ts
// ============================================================================

export {
  initializeSessionMemory,
  readSessionMemory,
  writeSessionMemory,
  deleteSessionMemory,
} from "./session";

// ============================================================================
// Re-exports from rules.ts
// ============================================================================

export {
  initializeRules,
  readRules,
  writeRules,
} from "./rules";

// ============================================================================
// Re-exports from settings.ts
// ============================================================================

export {
  loadMemorySettings,
  saveMemorySettings,
} from "./settings";

// ============================================================================
// Re-exports from context.ts
// ============================================================================

export {
  assembleMemoryContext,
  formatMemoryForContext,
  getMemoryContextSummary,
  filterMemoryContent,
} from "./context";

// ============================================================================
// Re-exports from stats.ts
// ============================================================================

export { getMemoryStats } from "./stats";
