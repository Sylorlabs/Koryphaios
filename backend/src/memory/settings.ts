/**
 * Memory Settings
 * 
 * Settings management for the memory system.
 * Controls which memory types are enabled and context options.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { serverLog } from "../logger";
import { MemorySettings, DEFAULT_MEMORY_SETTINGS } from "./types";
import { getSettingsPath } from "./config";

// ============================================================================
// Operations
// ============================================================================

export function loadMemorySettings(projectRoot: string): MemorySettings {
  const filePath = getSettingsPath(projectRoot);
  
  if (!existsSync(filePath)) {
    return DEFAULT_MEMORY_SETTINGS;
  }
  
  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);
    return { ...DEFAULT_MEMORY_SETTINGS, ...parsed };
  } catch (err) {
    serverLog.error({ err }, "Failed to load memory settings");
    return DEFAULT_MEMORY_SETTINGS;
  }
}

export function saveMemorySettings(projectRoot: string, settings: MemorySettings): void {
  const filePath = getSettingsPath(projectRoot);
  const dir = dirname(filePath);
  
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  writeFileSync(filePath, JSON.stringify(settings, null, 2), "utf-8");
}
