/**
 * Rules (.koryrules)
 * 
 * Cursor-style rules file operations.
 * Stored as .koryrules in the project root.
 */

import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { serverLog } from "../logger";
import { MemoryFile } from "./types";
import { MEMORY_CONFIG, getRulesPath } from "./config";

// ============================================================================
// Template
// ============================================================================

const DEFAULT_RULES_TEMPLATE = `# Koryphaios Rules

> This file defines rules and conventions for AI assistance in this project.
> Similar to .koryrules, these instructions guide the AI's behavior.

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
*Place this file at: .koryrules (project root)*
*Or at: .koryphaios/rules.md*
`;

// ============================================================================
// Operations
// ============================================================================

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
    serverLog.error({ err }, "Failed to read rules");
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
