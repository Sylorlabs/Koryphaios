/**
 * Session Memory
 * 
 * Per-chat session memory operations.
 * Each session has its own memory file stored in the project's sessions directory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, unlinkSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { serverLog } from "../logger";
import { MemoryFile } from "./types";
import { MEMORY_CONFIG, getSessionMemoryPath } from "./config";

// ============================================================================
// Template
// ============================================================================

const SESSION_MEMORY_TEMPLATE = `# Session Memory

> This memory is specific to THIS chat session. It survives compactions and stores:
> - Context from our conversation
> - Decisions made during this session
> - Code patterns and solutions discovered
> - Links to relevant files and resources

## 🎯 Session Context

**Started:** {timestamp}
**Purpose:** 

## 💡 Key Learnings

### Patterns Discovered
- 

### Solutions Found
- 

## 🔧 Technical Decisions

### Decisions Made
- **Decision:** 
  - **Rationale:** 
  - **Status:** Implemented / Pending / Abandoned

## 📁 Files Worked On

| File | Changes | Notes |
|------|---------|-------|
| | | |

## ⚠️ Gotchas & Edge Cases

- 

## 🎯 Next Steps

- [ ] 

## 🔗 References

### Related Sessions
- 

### External Links
- 

---
*This file is stored in: .koryphaios/sessions/{sessionId}/memory.md*
*Last updated: {timestamp}*
`;

// ============================================================================
// Operations
// ============================================================================

export function initializeSessionMemory(projectRoot: string, sessionId: string): MemoryFile {
  const filePath = getSessionMemoryPath(projectRoot, sessionId);
  const dir = dirname(filePath);
  
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  if (!existsSync(filePath)) {
    const timestamp = new Date().toISOString();
    const content = SESSION_MEMORY_TEMPLATE
      .replace(/{timestamp}/g, timestamp)
      .replace(/{sessionId}/g, sessionId);
    
    writeFileSync(filePath, content, "utf-8");
    
    return {
      path: filePath,
      content,
      exists: true,
      lastModified: Date.now(),
      size: content.length,
    };
  }
  
  return readSessionMemory(projectRoot, sessionId);
}

export function readSessionMemory(projectRoot: string, sessionId: string): MemoryFile {
  const filePath = getSessionMemoryPath(projectRoot, sessionId);
  
  if (!existsSync(filePath)) {
    return {
      path: filePath,
      content: "",
      exists: false,
      lastModified: null,
      size: 0,
    };
  }
  
  try {
    const content = readFileSync(filePath, "utf-8");
    const stats = statSync(filePath);
    
    return {
      path: filePath,
      content,
      exists: true,
      lastModified: stats.mtimeMs,
      size: content.length,
    };
  } catch (err) {
    serverLog.error({ err, sessionId }, "Failed to read session memory");
    return {
      path: filePath,
      content: "",
      exists: false,
      lastModified: null,
      size: 0,
    };
  }
}

export function writeSessionMemory(projectRoot: string, sessionId: string, content: string): MemoryFile {
  const filePath = getSessionMemoryPath(projectRoot, sessionId);
  const dir = dirname(filePath);
  
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  if (content.length > MEMORY_CONFIG.MAX_MEMORY_SIZE) {
    throw new Error(`Memory file exceeds maximum size of ${MEMORY_CONFIG.MAX_MEMORY_SIZE} bytes`);
  }
  
  writeFileSync(filePath, content, "utf-8");
  
  return {
    path: filePath,
    content,
    exists: true,
    lastModified: Date.now(),
    size: content.length,
  };
}

export function deleteSessionMemory(projectRoot: string, sessionId: string): boolean {
  const filePath = getSessionMemoryPath(projectRoot, sessionId);
  const dir = dirname(filePath);
  
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    
    // Try to clean up empty session directory
    try {
      if (existsSync(dir)) {
        const files = readdirSync(dir);
        if (files.length === 0) {
          const { rmdirSync } = require("node:fs");
          rmdirSync(dir);
        }
      }
    } catch (err) {
      serverLog.debug({ dir, error: err instanceof Error ? err.message : String(err) }, "Session directory cleanup failed (ignoring)");
    }
    
    return true;
  } catch (err) {
    serverLog.error({ err, sessionId }, "Failed to delete session memory");
    return false;
  }
}
