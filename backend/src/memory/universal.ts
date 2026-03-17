/**
 * Universal Memory
 * 
 * Global memory operations that persist across all projects.
 * Stored in the user's home directory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { serverLog } from "../logger";
import { MemoryFile } from "./types";
import { MEMORY_CONFIG, getUniversalMemoryPath } from "./config";

// ============================================================================
// Template
// ============================================================================

const UNIVERSAL_MEMORY_TEMPLATE = `# Universal Memory

> This memory is shared across ALL your Koryphaios projects. Use it for:
> - Personal coding preferences and style guidelines
> - Frequently used patterns and snippets
> - API keys and environment setup notes (be careful!)
> - Links to documentation you reference often
> - Custom instructions for the AI

## 🧑‍💻 Personal Preferences

### Coding Style
- Preferred naming conventions:
- Indentation preference:
- Comment style:

### Tech Stack Defaults
- Preferred frontend framework:
- Preferred backend language:
- Preferred database:
- Preferred testing framework:

## 📚 Frequently Used Patterns

### Code Snippets
\`\`\`typescript
// Your commonly used patterns here
\`\`\`

## 🔗 Quick References

### Documentation Links
- 

### Useful Commands
- 

## 🤖 AI Instructions

### How I Like Code Explained
- 

### Things to Always Check
- 

### Things to Avoid
- 

---
*This file is stored in: ~/.koryphaios/universal-memory/universal-memory.md*
*Last updated: {timestamp}*
`;

// ============================================================================
// Operations
// ============================================================================

export function initializeUniversalMemory(): MemoryFile {
  const filePath = getUniversalMemoryPath();
  
  if (!existsSync(filePath)) {
    // Create directory if needed
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    
    const content = UNIVERSAL_MEMORY_TEMPLATE.replace(
      "{timestamp}",
      new Date().toISOString()
    );
    
    writeFileSync(filePath, content, "utf-8");
    
    return {
      path: filePath,
      content,
      exists: true,
      lastModified: Date.now(),
      size: content.length,
    };
  }
  
  return readUniversalMemory();
}

export function readUniversalMemory(): MemoryFile {
  const filePath = getUniversalMemoryPath();
  
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
    serverLog.error({ err }, "Failed to read universal memory");
    return {
      path: filePath,
      content: "",
      exists: false,
      lastModified: null,
      size: 0,
    };
  }
}

export function writeUniversalMemory(content: string): MemoryFile {
  const filePath = getUniversalMemoryPath();
  const dir = dirname(filePath);
  
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  // Enforce size limit
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
