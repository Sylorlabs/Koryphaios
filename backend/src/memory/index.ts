/**
 * Memory System
 * 
 * A comprehensive memory and rules management system.
 * 
 * @example
 * // Import everything
 * import * as memory from "./memory";
 * 
 * // Or import specific modules
 * import { readUniversalMemory, writeUniversalMemory } from "./memory/universal";
 * import { readProjectMemory } from "./memory/project";
 */

// Types
export type {
  MemoryFile,
  MemorySettings,
  MemoryContext,
  MemoryStats,
} from "./types";

export { DEFAULT_MEMORY_SETTINGS } from "./types";

// Config
export { MEMORY_CONFIG } from "./config";
export {
  getProjectRoot,
  getUniversalMemoryPath,
  getProjectMemoryPath,
  getSessionMemoryPath,
  getRulesPath,
  getSettingsPath,
} from "./config";

// Universal Memory
export {
  initializeUniversalMemory,
  readUniversalMemory,
  writeUniversalMemory,
} from "./universal";

// Project Memory
export {
  initializeProjectMemory,
  readProjectMemory,
  writeProjectMemory,
} from "./project";

// Session Memory
export {
  initializeSessionMemory,
  readSessionMemory,
  writeSessionMemory,
  deleteSessionMemory,
} from "./session";

// Rules
export {
  initializeRules,
  readRules,
  writeRules,
} from "./rules";

// Settings
export {
  loadMemorySettings,
  saveMemorySettings,
} from "./settings";

// Context
export {
  assembleMemoryContext,
  formatMemoryForContext,
  getMemoryContextSummary,
  filterMemoryContent,
} from "./context";

// Stats
export { getMemoryStats } from "./stats";
