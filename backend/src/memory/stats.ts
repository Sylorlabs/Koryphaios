/**
 * Memory Stats and Diagnostics
 * 
 * Functions for gathering statistics and diagnostics about the memory system.
 */

import { MemoryStats } from "./types";
import { readUniversalMemory } from "./universal";
import { readProjectMemory } from "./project";
import { readSessionMemory } from "./session";
import { readRules } from "./rules";
import { loadMemorySettings } from "./settings";
import { getUniversalMemoryPath, getProjectMemoryPath, getSessionMemoryPath, getRulesPath, getSettingsPath } from "./config";

// ============================================================================
// Stats
// ============================================================================

export function getMemoryStats(projectRoot: string, sessionId?: string): MemoryStats {
  const settings = loadMemorySettings(projectRoot);
  
  return {
    settings,
    files: {
      universal: readUniversalMemory(),
      project: readProjectMemory(projectRoot),
      session: sessionId ? readSessionMemory(projectRoot, sessionId) : null,
      rules: readRules(projectRoot),
    },
    paths: {
      universal: getUniversalMemoryPath(),
      project: getProjectMemoryPath(projectRoot),
      session: sessionId ? getSessionMemoryPath(projectRoot, sessionId) : null,
      rules: getRulesPath(projectRoot),
      settings: getSettingsPath(projectRoot),
    },
  };
}
