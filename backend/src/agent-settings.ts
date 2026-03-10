/**
 * Agent Settings System
 * 
 * Manages agent behavior, rule enforcement, and workflow preferences.
 * Rules are ALWAYS applied - no option to disable.
 * Critic strongly enforces rules and workflow from preferences.md
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

// ============================================================================
// Configuration
// ============================================================================

export const AGENT_SETTINGS_CONFIG = {
  SETTINGS_FILE: ".koryphaios/agent-settings.json",
  PREFERENCES_FILE: ".koryphaios/preferences.md",
  RULES_ENFORCEMENT: {
    STRICT: "strict",      // Critic blocks violations
    MODERATE: "moderate",  // Critic warns on violations
    LENIENT: "lenient",    // Critic suggests improvements
  },
} as const;

// ============================================================================
// Types
// ============================================================================

export interface AgentSettings {
  /** Rule enforcement level - always applied, but critic can be strict/moderate/lenient */
  ruleEnforcementLevel: "strict" | "moderate" | "lenient";
  
  /** Whether to use preferences.md for workflow guidance */
  preferencesEnabled: boolean;
  
  /** Critic gate enabled - critic reviews all changes */
  criticGateEnabled: boolean;
  
  /** Critic enforces preferences.md workflow strictly */
  criticEnforcesPreferences: boolean;
  
  /** Auto-apply fixes that don't violate rules */
  autoApplySafeFixes: boolean;
  
  /** Require confirmation for rule violations */
  confirmRuleViolations: boolean;
  
  /** Agent memory - allow agents to update memory files */
  agentMemoryEnabled: boolean;
  
  /** Agent can update preferences.md based on learned patterns */
  agentCanUpdatePreferences: boolean;
  
  /** Max iterations for critic review loop */
  maxCriticIterations: number;
  
  /** Require human approval for changes that modify >N files */
  approvalThresholdFiles: number;
  
  /** Require human approval for changes >N lines */
  approvalThresholdLines: number;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  ruleEnforcementLevel: "strict",
  preferencesEnabled: true,
  criticGateEnabled: true,
  criticEnforcesPreferences: true,
  autoApplySafeFixes: false,
  confirmRuleViolations: true,
  agentMemoryEnabled: true,
  agentCanUpdatePreferences: false,
  maxCriticIterations: 3,
  approvalThresholdFiles: 5,
  approvalThresholdLines: 100,
};

// ============================================================================
// Preferences.md Template
// ============================================================================

const PREFERENCES_TEMPLATE = `# Agent Preferences & Workflow

> This file defines your preferred workflow and standards.
> The AI will ALWAYS follow these preferences.
> The CRITIC will STRONGLY ENFORCE these rules.

## 🎯 Core Principles

### Code Quality Standards
- **Mandatory**: All code must have proper error handling
- **Mandatory**: No console.log in production code
- **Mandatory**: All functions must have JSDoc comments
- **Mandatory**: No any types in TypeScript
- **Mandatory**: 100% test coverage for critical paths

### Architecture Rules
- **Mandatory**: Follow existing folder structure
- **Mandatory**: Use dependency injection for services
- **Mandatory**: No circular dependencies
- **Mandatory**: Single responsibility principle

### Performance Requirements
- **Mandatory**: No N+1 queries
- **Mandatory**: Lazy load heavy components
- **Mandatory**: Optimize images before commit
- **Mandatory**: Bundle size < 500KB

## 🔄 Workflow Preferences

### Before Starting Work
1. Read the relevant memory files
2. Check for existing similar implementations
3. Review recent commits for patterns
4. Understand the testing strategy

### During Development
1. Write tests BEFORE implementation
2. Run linting and type checking frequently
3. Commit logical chunks with descriptive messages
4. Update documentation as you go

### Before Committing
1. All tests must pass
2. No lint errors
3. Type check passes
4. Self-review against these preferences
5. Update relevant memory files

### Code Review Checklist
- [ ] Follows project conventions
- [ ] Has appropriate error handling
- [ ] Includes tests
- [ ] Documentation updated
- [ ] No security vulnerabilities
- [ ] Performance considered

## 🚫 Forbidden Patterns

### Never Do This
- **CRITICAL**: Never commit secrets or API keys
- **CRITICAL**: Never disable security features
- **CRITICAL**: Never skip tests in CI
- **CRITICAL**: Never modify production data in migrations
- **CRITICAL**: Never use eval() or similar

### Avoid If Possible
- Global state mutations
- Deep nesting (>3 levels)
- Magic numbers (use constants)
- Copy-pasted code (extract to functions)

## ✅ Preferred Patterns

### Do This Instead
- Use early returns to reduce nesting
- Prefer const over let
- Use destructuring for cleaner code
- Extract complex logic to pure functions
- Use meaningful variable names

### Testing Approach
- Unit tests for business logic
- Integration tests for APIs
- E2E tests for critical user flows
- Property-based tests for complex algorithms

## 🎨 Style Preferences

### Naming Conventions
- PascalCase for components/classes
- camelCase for functions/variables
- SCREAMING_SNAKE_CASE for constants
- kebab-case for file names

### Code Organization
- Imports: external → internal → relative
- Group by: types → hooks → components → utils
- One export per file (prefer default)
- Co-locate tests with source files

## 🔍 Review Criteria

### Critic Will Block If:
- Security vulnerability detected
- Performance regression >10%
- Test coverage drops
- Type errors introduced
- Linting fails
- Documentation missing

### Critic Will Warn If:
- Code could be simplified
- Better alternative exists
- Edge case not handled
- Naming could be clearer

## 📝 Memory Management

### What to Remember
- User's preferred tech stack
- Common patterns used
- Frequent mistakes to avoid
- Project-specific conventions

### Update Triggers
- After significant refactoring
- When new patterns emerge
- After resolving complex bugs
- When workflow changes

## 🚨 Escalation Rules

### When to Ask for Help
- Unclear requirements
- Architectural decisions
- Security concerns
- Performance bottlenecks

### When to Override Preferences
- Emergency fixes (document why)
- Proven better approach
- Team consensus
- Security requirements

---
*This file is located at: .koryphaios/preferences.md*
*The AI MUST follow these preferences*
*The CRITIC MUST enforce these rules*
*Last updated: {timestamp}*
`;

// ============================================================================
// Settings Management
// ============================================================================

export function getSettingsPath(projectRoot: string): string {
  return join(projectRoot, AGENT_SETTINGS_CONFIG.SETTINGS_FILE);
}

export function getPreferencesPath(projectRoot: string): string {
  return join(projectRoot, AGENT_SETTINGS_CONFIG.PREFERENCES_FILE);
}

export function loadAgentSettings(projectRoot: string): AgentSettings {
  const filePath = getSettingsPath(projectRoot);
  
  if (!existsSync(filePath)) {
    return DEFAULT_AGENT_SETTINGS;
  }
  
  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);
    return { ...DEFAULT_AGENT_SETTINGS, ...parsed };
  } catch (err) {
    console.error("Failed to load agent settings:", err);
    return DEFAULT_AGENT_SETTINGS;
  }
}

export function saveAgentSettings(projectRoot: string, settings: AgentSettings): void {
  const filePath = getSettingsPath(projectRoot);
  const dir = dirname(filePath);
  
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  writeFileSync(filePath, JSON.stringify(settings, null, 2), "utf-8");
}

export function resetAgentSettings(projectRoot: string): AgentSettings {
  saveAgentSettings(projectRoot, DEFAULT_AGENT_SETTINGS);
  return DEFAULT_AGENT_SETTINGS;
}

// ============================================================================
// Preferences.md Management
// ============================================================================

export function initializePreferences(projectRoot: string): { path: string; content: string; exists: boolean } {
  const filePath = getPreferencesPath(projectRoot);
  
  if (!existsSync(filePath)) {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    
    const content = PREFERENCES_TEMPLATE.replace(
      "{timestamp}",
      new Date().toISOString()
    );
    
    writeFileSync(filePath, content, "utf-8");
    
    return { path: filePath, content, exists: true };
  }
  
  return readPreferences(projectRoot);
}

export function readPreferences(projectRoot: string): { path: string; content: string; exists: boolean } {
  const filePath = getPreferencesPath(projectRoot);
  
  if (!existsSync(filePath)) {
    return { path: filePath, content: "", exists: false };
  }
  
  try {
    const content = readFileSync(filePath, "utf-8");
    return { path: filePath, content, exists: true };
  } catch (err) {
    console.error("Failed to read preferences:", err);
    return { path: filePath, content: "", exists: false };
  }
}

export function writePreferences(projectRoot: string, content: string): void {
  const filePath = getPreferencesPath(projectRoot);
  const dir = dirname(filePath);
  
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  writeFileSync(filePath, content, "utf-8");
}

// ============================================================================
// Rule Enforcement
// ============================================================================

export interface RuleEnforcementResult {
  passed: boolean;
  violations: RuleViolation[];
  warnings: RuleWarning[];
}

export interface RuleViolation {
  rule: string;
  severity: "critical" | "error" | "warning";
  message: string;
  file?: string;
  line?: number;
}

export interface RuleWarning {
  rule: string;
  message: string;
  suggestion: string;
}

/**
 * Check if code complies with rules from preferences.md
 * This is called by the Critic agent
 */
export function enforceRules(
  code: string,
  filePath: string,
  preferences: string,
  enforcementLevel: AgentSettings["ruleEnforcementLevel"]
): RuleEnforcementResult {
  const violations: RuleViolation[] = [];
  const warnings: RuleWarning[] = [];
  
  // Parse preferences for forbidden patterns
  const forbiddenPatterns = extractForbiddenPatterns(preferences);
  const requiredPatterns = extractRequiredPatterns(preferences);
  
  // Check for forbidden patterns
  for (const pattern of forbiddenPatterns) {
    if (code.includes(pattern.pattern)) {
      if (pattern.critical || enforcementLevel === "strict") {
        violations.push({
          rule: pattern.name,
          severity: pattern.critical ? "critical" : "error",
          message: pattern.message,
          file: filePath,
        });
      } else if (enforcementLevel === "moderate") {
        warnings.push({
          rule: pattern.name,
          message: pattern.message,
          suggestion: pattern.suggestion || "Remove this pattern",
        });
      }
    }
  }
  
  // Check for required patterns
  for (const pattern of requiredPatterns) {
    if (!pattern.check(code)) {
      if (enforcementLevel === "strict") {
        violations.push({
          rule: pattern.name,
          severity: "error",
          message: pattern.message,
          file: filePath,
        });
      } else {
        warnings.push({
          rule: pattern.name,
          message: pattern.message,
          suggestion: pattern.suggestion,
        });
      }
    }
  }
  
  return {
    passed: violations.length === 0,
    violations,
    warnings,
  };
}

interface Pattern {
  name: string;
  pattern: string;
  message: string;
  suggestion?: string;
  critical?: boolean;
}

interface RequiredPattern {
  name: string;
  check: (code: string) => boolean;
  message: string;
  suggestion: string;
}

function extractForbiddenPatterns(preferences: string): Pattern[] {
  const patterns: Pattern[] = [];
  
  // Extract "Never Do This" patterns
  const neverSection = preferences.match(/### Never Do This[\s\S]*?(?=###|$)/);
  if (neverSection) {
    const lines = neverSection[0].split("\n");
    for (const line of lines) {
      const match = line.match(/-\s*\*\*CRITICAL\*\*:\s*(.+)/);
      if (match) {
        patterns.push({
          name: "Critical Rule",
          pattern: match[1].toLowerCase(),
          message: match[1],
          critical: true,
        });
      }
    }
  }
  
  // Default security patterns (always enforced)
  patterns.push(
    { name: "No Secrets", pattern: "apikey", message: "Potential API key detected", critical: true },
    { name: "No Eval", pattern: "eval(", message: "eval() is dangerous", critical: true },
    { name: "No Console", pattern: "console.log", message: "console.log should not be in production" }
  );
  
  return patterns;
}

function extractRequiredPatterns(preferences: string): RequiredPattern[] {
  const patterns: RequiredPattern[] = [];
  
  // Check for error handling
  patterns.push({
    name: "Error Handling",
    check: (code) => code.includes("try") || code.includes("catch") || code.includes("throw"),
    message: "Code should have error handling",
    suggestion: "Add try/catch or error checks",
  });
  
  // Check for JSDoc (for functions)
  patterns.push({
    name: "Documentation",
    check: (code) => !code.includes("function") || code.includes("/**"),
    message: "Functions should have JSDoc comments",
    suggestion: "Add JSDoc documentation",
  });
  
  return patterns;
}

// ============================================================================
// Critic Integration
// ============================================================================

export interface CriticReviewRequest {
  code: string;
  filePath: string;
  changeDescription: string;
  settings: AgentSettings;
  preferences: string;
  rules: string;
}

export interface CriticReviewResult {
  approved: boolean;
  canAutoFix: boolean;
  violations: RuleViolation[];
  warnings: RuleWarning[];
  suggestions: string[];
  requiredChanges: string[];
}

/**
 * Critic review function - strongly enforces rules
 */
export function criticReview(request: CriticReviewRequest): CriticReviewResult {
  const { code, filePath, settings, preferences, rules } = request;
  
  // Always enforce rules
  const ruleCheck = enforceRules(code, filePath, preferences, settings.ruleEnforcementLevel);
  
  const violations = ruleCheck.violations;
  const warnings = ruleCheck.warnings;
  const requiredChanges: string[] = [];
  
  // Critical violations always block
  const criticalViolations = violations.filter(v => v.severity === "critical");
  
  // In strict mode, all violations block
  const blockingViolations = settings.ruleEnforcementLevel === "strict" 
    ? violations 
    : criticalViolations;
  
  // Generate required changes
  for (const violation of blockingViolations) {
    requiredChanges.push(`${violation.severity.toUpperCase()}: ${violation.message}`);
  }
  
  // Check preferences workflow
  if (settings.criticEnforcesPreferences && preferences) {
    const workflowCheck = checkWorkflowCompliance(code, preferences);
    if (!workflowCheck.compliant) {
      requiredChanges.push(...workflowCheck.issues);
    }
  }
  
  // Determine if can auto-fix
  const canAutoFix = violations.length === 0 && warnings.length > 0;
  
  // Auto-apply if safe and enabled
  const approved = settings.criticGateEnabled 
    ? requiredChanges.length === 0 
    : true;
  
  return {
    approved,
    canAutoFix,
    violations,
    warnings,
    suggestions: warnings.map(w => w.suggestion),
    requiredChanges,
  };
}

function checkWorkflowCompliance(code: string, preferences: string): { compliant: boolean; issues: string[] } {
  const issues: string[] = [];
  
  // Check if code follows "Write tests BEFORE implementation"
  if (preferences.includes("Write tests BEFORE implementation")) {
    const hasTest = code.includes("test(") || code.includes("it(") || code.includes("describe(");
    const hasImplementation = code.includes("function") || code.includes("const") || code.includes("class");
    
    if (hasImplementation && !hasTest) {
      issues.push("WORKFLOW: Tests should be written before implementation");
    }
  }
  
  return { compliant: issues.length === 0, issues };
}

// ============================================================================
// Agent Context Assembly
// ============================================================================

export function assembleAgentContext(
  projectRoot: string,
  settings: AgentSettings
): {
  settings: AgentSettings;
  preferences: string;
  rules: string;
  enforcementMessage: string;
} {
  const prefs = settings.preferencesEnabled 
    ? readPreferences(projectRoot).content 
    : "";
  
  const rulesContent = readFileSync(
    join(projectRoot, ".cursorrules"), 
    "utf-8"
  ).toString() || "";
  
  const enforcementMessage = generateEnforcementMessage(settings);
  
  return {
    settings,
    preferences: prefs,
    rules: rulesContent,
    enforcementMessage,
  };
}

function generateEnforcementMessage(settings: AgentSettings): string {
  const messages = [
    "🚨 RULE ENFORCEMENT IS ACTIVE",
    "",
    "The following rules MUST be followed:",
    "1. ALL rules from .cursorrules are mandatory",
    "2. ALL preferences from preferences.md are mandatory",
  ];
  
  if (settings.criticGateEnabled) {
    messages.push("3. CRITIC WILL REVIEW and may BLOCK violations");
  }
  
  if (settings.criticEnforcesPreferences) {
    messages.push("4. CRITIC STRICTLY ENFORCES workflow preferences");
  }
  
  if (settings.ruleEnforcementLevel === "strict") {
    messages.push("5. STRICT MODE: Any rule violation blocks the change");
  }
  
  messages.push("");
  messages.push("Before submitting changes:");
  messages.push("- Verify compliance with ALL rules");
  messages.push("- Check against preferences.md workflow");
  messages.push("- Ensure no forbidden patterns");
  messages.push("- Run all checks (lint, test, type)");
  
  return messages.join("\n");
}

// ============================================================================
// Stats
// ============================================================================

export function getAgentSettingsStats(projectRoot: string) {
  const settings = loadAgentSettings(projectRoot);
  const preferences = readPreferences(projectRoot);
  
  return {
    settings,
    preferences: {
      ...preferences,
      wordCount: preferences.content.split(/\s+/).length,
    },
    enforcementActive: true,
    criticActive: settings.criticGateEnabled,
    strictMode: settings.ruleEnforcementLevel === "strict",
  };
}
