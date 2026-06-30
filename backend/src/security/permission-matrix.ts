/**
 * Permission Matrix - Smart approval system
 *
 * Replaces binary YOLO mode with granular permissions based on:
 * - Operation risk level
 * - Cost thresholds
 * - File patterns
 * - Tool types
 */

import { koryLog } from '../logger';

export type PermissionLevel = 'auto' | 'ask' | 'block';

export interface ToolPermission {
  tool: string;
  level: PermissionLevel;
  conditions?: {
    maxCost?: number;
    filePattern?: string;
    commandPattern?: string;
  };
}

export interface PermissionMatrix {
  // Default for unspecified tools
  defaultLevel: PermissionLevel;

  // Per-tool permissions
  tools: Record<string, ToolPermission>;

  // Cost-based rules
  costThresholds: {
    askAbove: number; // Ask if cost > this (in cents)
    blockAbove: number; // Block if cost > this
  };

  // File-based rules
  fileRules: Array<{
    pattern: RegExp;
    level: PermissionLevel;
    tools?: string[]; // Only apply to these tools
  }>;

  // Command-based rules (for bash tool)
  commandRules: Array<{
    pattern: RegExp;
    level: PermissionLevel;
  }>;
}

export interface PermissionCheck {
  allowed: boolean;
  level: PermissionLevel;
  reason?: string;
  requiresApproval: boolean;
  riskScore: number; // 0-100
}

// Default safe permissions
export const DEFAULT_PERMISSION_MATRIX: PermissionMatrix = {
  defaultLevel: 'ask',

  tools: {
    // Read operations - safe
    read_file: { tool: 'read_file', level: 'auto' },
    glob: { tool: 'glob', level: 'auto' },
    grep: { tool: 'grep', level: 'auto' },
    ls: { tool: 'ls', level: 'auto' },
    web_search: { tool: 'web_search', level: 'auto' },

    // Notes network — reads auto, writes ask
    read_note: { tool: 'read_note', level: 'auto' },
    search_notes: { tool: 'search_notes', level: 'auto' },
    list_notes: { tool: 'list_notes', level: 'auto' },
    recall_notes: { tool: 'recall_notes', level: 'auto' },
    get_note_backlinks: { tool: 'get_note_backlinks', level: 'auto' },
    get_note_graph_summary: { tool: 'get_note_graph_summary', level: 'auto' },
    create_note: { tool: 'create_note', level: 'ask' },
    update_note: { tool: 'update_note', level: 'ask' },
    delete_note: { tool: 'delete_note', level: 'ask' },
    link_notes: { tool: 'link_notes', level: 'ask' },
    unlink_notes: { tool: 'unlink_notes', level: 'ask' },

    // Write operations - depends
    write_file: {
      tool: 'write_file',
      level: 'ask',
      conditions: {
        filePattern: '\\.(test|spec)\\.(ts|js|py)$', // Auto-allow test files
      },
    },
    apply_diff: { tool: 'apply_diff', level: 'ask' },

    // Destructive operations - always ask
    delete_file: { tool: 'delete_file', level: 'ask' },
    bash: {
      tool: 'bash',
      level: 'ask',
    },

    // Expensive operations - ask based on cost
    delegate_to_worker: {
      tool: 'delegate_to_worker',
      level: 'ask',
      conditions: { maxCost: 10.0 }, // Auto if under 10 cents
    },
    delegate_to_jules: {
      tool: 'delegate_to_jules',
      level: 'ask',
      conditions: { maxCost: 10.0 },
    },
  },

  costThresholds: {
    askAbove: 5.0, // 5 cents
    blockAbove: 50.0, // 50 cents
  },

  fileRules: [
    { pattern: /\.(test|spec)\.(ts|js|py)$/, level: 'auto' }, // Test files
    { pattern: /\.md$/, level: 'auto' }, // Docs
    { pattern: /package\.json$/, level: 'ask' }, // Critical files
    { pattern: /\.env/, level: 'block' }, // Secrets
  ],

  commandRules: [
    { pattern: /^ls|^pwd|^echo|^cat|^head|^tail|^grep/, level: 'auto' }, // Safe commands
    { pattern: /rm\s+-rf|\/|\*|;|&&|\|/, level: 'block' }, // Dangerous patterns
    { pattern: /^git\s+(push|reset--hard)/, level: 'ask' }, // Git operations
    { pattern: /npm\s+test|pytest|cargo\s+test/, level: 'auto' }, // Test commands
    { pattern: /npm\s+install|pip\s+install/, level: 'ask' }, // Package installs
  ],
};

// YOLO mode - everything auto (use with caution)
export const YOLO_PERMISSION_MATRIX: PermissionMatrix = {
  defaultLevel: 'auto',
  tools: {},
  costThresholds: {
    askAbove: 100.0,
    blockAbove: 500.0,
  },
  fileRules: [
    { pattern: /\.env/, level: 'ask' }, // Still protect secrets
  ],
  commandRules: [
    { pattern: /rm\s+-rf\s*\/|\/\.\*;rm/, level: 'block' }, // Still block rm -rf /
  ],
};

// Conservative mode - everything asks
export const CONSERVATIVE_PERMISSION_MATRIX: PermissionMatrix = {
  defaultLevel: 'ask',
  tools: {
    read_file: { tool: 'read_file', level: 'auto' },
    glob: { tool: 'glob', level: 'auto' },
    grep: { tool: 'grep', level: 'auto' },
    ls: { tool: 'ls', level: 'auto' },
  },
  costThresholds: {
    askAbove: 1.0,
    blockAbove: 10.0,
  },
  fileRules: [],
  commandRules: [{ pattern: /^ls|^pwd|^echo|^cat/, level: 'auto' }],
};

export class PermissionEngine {
  constructor(private matrix: PermissionMatrix = DEFAULT_PERMISSION_MATRIX) {}

  /**
   * Check if an operation is allowed.
   */
  checkPermission(
    toolName: string,
    input: Record<string, unknown>,
    context?: {
      estimatedCost?: number;
      filePath?: string;
      isTestEnvironment?: boolean;
    },
  ): PermissionCheck {
    let level = this.matrix.defaultLevel;
    let reason = 'Default permission level';
    let riskScore = 50;

    // Check tool-specific permission
    const toolPerm = this.matrix.tools[toolName];
    if (toolPerm) {
      level = toolPerm.level;
      reason = `Tool '${toolName}' default`;

      // Check tool-specific conditions
      if (toolPerm.conditions) {
        // Cost check
        if (context?.estimatedCost && toolPerm.conditions.maxCost) {
          if (context.estimatedCost < toolPerm.conditions.maxCost) {
            level = 'auto';
            reason = `Cost ${context.estimatedCost}c below threshold ${toolPerm.conditions.maxCost}c`;
            riskScore = 10;
          }
        }
      }
    }

    // Check cost thresholds (global)
    if (context?.estimatedCost) {
      if (context.estimatedCost > this.matrix.costThresholds.blockAbove) {
        return {
          allowed: false,
          level: 'block',
          reason: `Cost ${context.estimatedCost}c exceeds maximum ${this.matrix.costThresholds.blockAbove}c`,
          requiresApproval: false,
          riskScore: 100,
        };
      }
      if (context.estimatedCost > this.matrix.costThresholds.askAbove && level === 'auto') {
        level = 'ask';
        reason = `Cost ${context.estimatedCost}c above threshold ${this.matrix.costThresholds.askAbove}c`;
        riskScore = 70;
      }
    }

    // Check file rules
    if (context?.filePath) {
      for (const rule of this.matrix.fileRules) {
        if (rule.pattern.test(context.filePath)) {
          // Check if rule applies to this tool
          if (!rule.tools || rule.tools.includes(toolName)) {
            level = rule.level;
            reason = `File pattern '${rule.pattern}' matched`;
            riskScore = rule.level === 'block' ? 100 : rule.level === 'ask' ? 60 : 20;
            break;
          }
        }
      }
    }

    // Check command rules (for bash tool)
    if (toolName === 'bash' && input.command) {
      const command = String(input.command);

      for (const rule of this.matrix.commandRules) {
        if (rule.pattern.test(command)) {
          level = rule.level;
          reason = `Command pattern '${rule.pattern}' matched`;
          riskScore = rule.level === 'block' ? 100 : rule.level === 'ask' ? 70 : 10;
          break;
        }
      }

      // Additional heuristics
      if (command.includes('sudo')) {
        level = 'ask';
        reason = 'Command uses sudo';
        riskScore = 80;
      }
    }

    // Test environment override
    if (context?.isTestEnvironment && level === 'ask') {
      level = 'auto';
      reason = 'Test environment - auto-approving';
      riskScore = 20;
    }

    return {
      allowed: level !== 'block',
      level,
      reason,
      requiresApproval: level === 'ask',
      riskScore,
    };
  }

  /**
   * Get human-readable explanation of why permission was required.
   */
  explainDecision(check: PermissionCheck): string {
    if (check.level === 'auto') {
      return `Auto-approved: ${check.reason}`;
    }
    if (check.level === 'block') {
      return `Blocked: ${check.reason}`;
    }
    return `Approval required: ${check.reason} (risk: ${check.riskScore}/100)`;
  }

  /**
   * Update permission matrix.
   */
  updateMatrix(updates: Partial<PermissionMatrix>): void {
    this.matrix = { ...this.matrix, ...updates };
    koryLog.info('Permission matrix updated');
  }

  /**
   * Set permission for a specific tool.
   */
  setToolPermission(
    tool: string,
    level: PermissionLevel,
    conditions?: ToolPermission['conditions'],
  ): void {
    this.matrix.tools[tool] = { tool, level, conditions };
  }

  /**
   * Get current matrix.
   */
  getMatrix(): PermissionMatrix {
    return { ...this.matrix };
  }

  /**
   * Load matrix from config.
   */
  loadFromConfig(config: unknown): void {
    // Basic validation
    if (typeof config === 'object' && config !== null) {
      const c = config as Partial<PermissionMatrix>;

      // Parse file rules from strings
      if (c.fileRules) {
        c.fileRules = c.fileRules.map((r) => ({
          ...r,
          pattern: new RegExp(r.pattern),
        }));
      }

      // Parse command rules from strings
      if (c.commandRules) {
        c.commandRules = c.commandRules.map((r) => ({
          ...r,
          pattern: new RegExp(r.pattern),
        }));
      }

      this.matrix = { ...DEFAULT_PERMISSION_MATRIX, ...c };
    }
  }
}

// Singleton instance
export const permissionEngine = new PermissionEngine();
