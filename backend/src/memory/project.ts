/**
 * Project Memory
 * 
 * Project-specific memory operations.
 * Stored in the project's .koryphaios directory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { serverLog } from "../logger";
import { MemoryFile } from "./types";
import { MEMORY_CONFIG, getProjectMemoryPath } from "./config";

// ============================================================================
// Template
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

// ============================================================================
// Operations
// ============================================================================

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
    serverLog.error({ err }, "Failed to read project memory");
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
