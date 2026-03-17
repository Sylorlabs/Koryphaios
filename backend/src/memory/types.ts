/**
 * Memory System Types
 * 
 * Core interfaces and types for the unified memory system.
 */

// ============================================================================
// Core Types
// ============================================================================

export interface MemoryFile {
  path: string;
  content: string;
  exists: boolean;
  lastModified: number | null;
  size: number;
}

export interface MemorySettings {
  /** Enable universal (global) memory */
  universalMemoryEnabled: boolean;
  /** Enable project-specific memory */
  projectMemoryEnabled: boolean;
  /** Enable session memory */
  sessionMemoryEnabled: boolean;
  /** Enable agent-added memories */
  agentMemoryEnabled: boolean;
  /** Enable .koryrules file */
  rulesEnabled: boolean;
  /** Auto-include memories in agent context */
  autoIncludeInContext: boolean;
  /** Maximum tokens to use for memories in context */
  maxContextTokens: number;
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  universalMemoryEnabled: true,
  projectMemoryEnabled: true,
  sessionMemoryEnabled: true,
  agentMemoryEnabled: true,
  rulesEnabled: true,
  autoIncludeInContext: true,
  maxContextTokens: 2000,
};

// ============================================================================
// Context Types
// ============================================================================

export interface MemoryContext {
  universal: MemoryFile | null;
  project: MemoryFile | null;
  session: MemoryFile | null;
  rules: MemoryFile | null;
  settings: MemorySettings;
}

// ============================================================================
// Stats Types
// ============================================================================

export interface MemoryStats {
  settings: MemorySettings;
  files: {
    universal: MemoryFile;
    project: MemoryFile;
    session: MemoryFile | null;
    rules: MemoryFile;
  };
  paths: {
    universal: string;
    project: string;
    session: string | null;
    rules: string;
    settings: string;
  };
}
