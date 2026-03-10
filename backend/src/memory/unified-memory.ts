/**
 * Unified Memory System
 * 
 * A comprehensive memory and rules management system that provides:
 * - Universal Memory: Global across all projects
 * - Project Memory: Specific to current project
 * - Session Memory: Per-chat persistent storage
 * - Cursor-style Rules: .cursorrules file support
 * 
 * All files are stored relative to the project for portability.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";

// ============================================================================
// Configuration
// ============================================================================

export const MEMORY_CONFIG = {
  // Directory names (relative to project root or home)
  UNIVERSAL_MEMORY_DIR: ".koryphaios/universal-memory",
  PROJECT_MEMORY_DIR: ".koryphaios/project-memory",
  SESSIONS_DIR: ".koryphaios/sessions",
  RULES_FILE: ".cursorrules",
  
  // File names
  UNIVERSAL_MEMORY_FILE: "universal-memory.md",
  PROJECT_MEMORY_FILE: "project-memory.md",
  SESSION_MEMORY_FILE: "memory.md",
  
  // Settings
  MAX_MEMORY_SIZE: 100_000, // 100KB max per memory file
  MAX_RULES_SIZE: 50_000,   // 50KB max for rules
} as const;

// ============================================================================
// Types
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
  /** Enable .cursorrules file */
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
// Path Resolution
// ============================================================================

/**
 * Get the project root directory
 */
function getProjectRoot(): string {
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
 * Get .cursorrules path
 */
export function getRulesPath(projectRoot: string): string {
  return join(projectRoot, MEMORY_CONFIG.RULES_FILE);
}

// ============================================================================
// Universal Memory (Global)
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
    console.error("Failed to read universal memory:", err);
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

// ============================================================================
// Project Memory
// ============================================================================

const PROJECT_MEMORY_TEMPLATE = `# Project Memory

> This memory is specific to THIS project. Use it for:
> - Project overview and architecture decisions
> - Team conventions and standards
> - Important file locations and structure
> - Build/test commands
> - Deployment procedures
> - Environment setup

## 🎯 Project Overview

**Project Name:** 
**Description:** 
**Tech Stack:** 

## 🏗️ Architecture

### Directory Structure
\`\`\`
project-root/
├── 
\`\`\`

### Key Components
- 

## 📋 Conventions

### Naming Conventions
- Files: 
- Variables: 
- Components: 

### Code Style
- 

## 🚀 Development Workflow

### Setup Commands
\`\`\`bash
# Installation

# Environment setup
\`\`\`

### Build Commands
\`\`\`bash
# Development

# Production

# Testing
\`\`\`

### Test Commands
\`\`\`bash
# Run all tests

# Run specific test
\`\`\`

## 📦 Deployment

### Environments
- Development: 
- Staging: 
- Production: 

### Deploy Commands
\`\`\`bash
# Deploy to staging

# Deploy to production
\`\`\`

## 🔗 Resources

### Documentation
- 

### External Services
- 

### Team Contacts
- 

## ⚠️ Important Notes

### Known Issues
- 

### Workarounds
- 

---
*This file is stored in: .koryphaios/project-memory/project-memory.md*
*Last updated: {timestamp}*
`;

export function initializeProjectMemory(projectRoot: string): MemoryFile {
  const filePath = getProjectMemoryPath(projectRoot);
  
  if (!existsSync(filePath)) {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    
    const content = PROJECT_MEMORY_TEMPLATE.replace(
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
  
  return readProjectMemory(projectRoot);
}

export function readProjectMemory(projectRoot: string): MemoryFile {
  const filePath = getProjectMemoryPath(projectRoot);
  
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
    console.error("Failed to read project memory:", err);
    return {
      path: filePath,
      content: "",
      exists: false,
      lastModified: null,
      size: 0,
    };
  }
}

export function writeProjectMemory(projectRoot: string, content: string): MemoryFile {
  const filePath = getProjectMemoryPath(projectRoot);
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

// ============================================================================
// Session Memory (Per-Chat)
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
    console.error(`Failed to read session memory for ${sessionId}:`, err);
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
    } catch {
      // Ignore cleanup errors
    }
    
    return true;
  } catch (err) {
    console.error(`Failed to delete session memory for ${sessionId}:`, err);
    return false;
  }
}

// ============================================================================
// Rules (.cursorrules)
// ============================================================================

const DEFAULT_RULES_TEMPLATE = `# Koryphaios Rules

> This file defines rules and conventions for AI assistance in this project.
> Similar to .cursorrules, these instructions guide the AI's behavior.

## 🎯 General Principles

### Code Quality
- Write clean, readable, and maintainable code
- Follow existing code style and patterns in the project
- Add comments for complex logic, but prefer self-documenting code
- Handle errors gracefully with appropriate error messages

### Performance
- Consider performance implications of changes
- Avoid unnecessary computations or memory allocations
- Use appropriate data structures for the task

### Security
- Never commit secrets or API keys
- Validate all user inputs
- Use parameterized queries to prevent SQL injection
- Sanitize data before displaying in UI

## 🏗️ Architecture Guidelines

### File Organization
- Keep related code together
- Use clear, descriptive file names
- Maintain consistent directory structure

### Naming Conventions
- Use descriptive variable and function names
- Follow language-specific conventions
- Be consistent with existing codebase

## 📝 Code Style

### TypeScript/JavaScript
- Use TypeScript for type safety when available
- Prefer const over let, avoid var
- Use async/await over raw promises
- Destructure objects for cleaner code

### React/Svelte Components
- Keep components focused and single-purpose
- Extract reusable logic into hooks/utilities
- Use proper prop typing
- Handle loading and error states

### CSS/Styling
- Use CSS variables for theming
- Prefer utility classes for common patterns
- Keep styles co-located with components when possible

## 🤖 AI Instructions

### When Writing Code
- Always consider edge cases
- Add error handling
- Write tests when appropriate
- Follow the principle of least surprise

### When Explaining Code
- Explain the "why" not just the "what"
- Provide context for decisions
- Suggest alternatives when relevant

### When Refactoring
- Preserve existing behavior unless asked otherwise
- Make incremental changes
- Explain the benefits of the refactoring

## 🧪 Testing

### Test Coverage
- Write tests for critical paths
- Test edge cases and error conditions
- Use descriptive test names

### Test Structure
- Arrange-Act-Assert pattern
- One concept per test
- Clear setup and teardown

## 📚 Documentation

### Code Comments
- Explain complex algorithms
- Document public APIs
- Keep comments up-to-date with code

### README Updates
- Update README for significant changes
- Document new environment variables
- Keep setup instructions current

---
*Place this file at: .cursorrules (project root)*
*Or at: .koryphaios/rules.md*
`;

export function initializeRules(projectRoot: string): MemoryFile {
  const filePath = getRulesPath(projectRoot);
  
  if (!existsSync(filePath)) {
    writeFileSync(filePath, DEFAULT_RULES_TEMPLATE, "utf-8");
    
    return {
      path: filePath,
      content: DEFAULT_RULES_TEMPLATE,
      exists: true,
      lastModified: Date.now(),
      size: DEFAULT_RULES_TEMPLATE.length,
    };
  }
  
  return readRules(projectRoot);
}

export function readRules(projectRoot: string): MemoryFile {
  const filePath = getRulesPath(projectRoot);
  
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
    console.error("Failed to read rules:", err);
    return {
      path: filePath,
      content: "",
      exists: false,
      lastModified: null,
      size: 0,
    };
  }
}

export function writeRules(projectRoot: string, content: string): MemoryFile {
  const filePath = getRulesPath(projectRoot);
  
  if (content.length > MEMORY_CONFIG.MAX_RULES_SIZE) {
    throw new Error(`Rules file exceeds maximum size of ${MEMORY_CONFIG.MAX_RULES_SIZE} bytes`);
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

// ============================================================================
// Settings Management
// ============================================================================

const SETTINGS_FILE = ".koryphaios/memory-settings.json";

export function getSettingsPath(projectRoot: string): string {
  return join(projectRoot, SETTINGS_FILE);
}

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
    console.error("Failed to load memory settings:", err);
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

// ============================================================================
// Context Assembly
// ============================================================================

export interface MemoryContext {
  universal: MemoryFile | null;
  project: MemoryFile | null;
  session: MemoryFile | null;
  rules: MemoryFile | null;
  settings: MemorySettings;
}

export function assembleMemoryContext(
  projectRoot: string,
  sessionId: string | null,
  settings?: MemorySettings
): MemoryContext {
  const effectiveSettings = settings ?? loadMemorySettings(projectRoot);
  
  return {
    universal: effectiveSettings.universalMemoryEnabled ? readUniversalMemory() : null,
    project: effectiveSettings.projectMemoryEnabled ? readProjectMemory(projectRoot) : null,
    session: effectiveSettings.sessionMemoryEnabled && sessionId
      ? readSessionMemory(projectRoot, sessionId)
      : null,
    rules: effectiveSettings.rulesEnabled ? readRules(projectRoot) : null,
    settings: effectiveSettings,
  };
}

export function formatMemoryForContext(context: MemoryContext): string {
  const parts: string[] = [];
  
  if (context.rules?.exists && context.rules.content) {
    parts.push(`## Project Rules (.cursorrules)\n\n${context.rules.content}`);
  }
  
  if (context.universal?.exists && context.universal.content) {
    parts.push(`## Universal Memory\n\n${context.universal.content}`);
  }
  
  if (context.project?.exists && context.project.content) {
    parts.push(`## Project Memory\n\n${context.project.content}`);
  }
  
  if (context.session?.exists && context.session.content) {
    parts.push(`## Session Memory\n\n${context.session.content}`);
  }
  
  if (parts.length === 0) {
    return "";
  }
  
  return `# Memory Context\n\n${parts.join("\n\n---\n\n")}`;
}

// ============================================================================
// Stats and Diagnostics
// ============================================================================

export function getMemoryStats(projectRoot: string, sessionId?: string) {
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
