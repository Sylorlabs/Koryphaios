// Configuration Types
// Domain: Application configuration structure

// Import types to avoid circular dependency
import type { ProviderConfig } from '../providers/ModelDefs';
import type { WorkerDomain } from '../types/AgentTypes';

export interface MCPServerConfig {
  type: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface SafetyLimits {
  /** Maximum tokens per agent turn. @default 4096 */
  maxTokensPerTurn?: number;
  /** Maximum file size in bytes for file operations. @default 10_000_000 */
  maxFileSizeBytes?: number;
  /** Timeout in ms for tool execution. @default 60_000 */
  toolExecutionTimeoutMs?: number;
}

export interface WorkspaceConfig {
  /**
   * Maximum number of concurrent Git worktrees allowed.
   * Each worktree consumes RAM (roughly 200-500MB per active agent).
   * Set based on your system's available memory:
   * - 8GB RAM: 3-4 worktrees
   * - 16GB RAM: 6-8 worktrees
   * - 32GB+ RAM: 10+ worktrees
   * @default 4
   */
  worktreeLimit?: number;
  /** Base directory for worktrees (relative to repo root). @default ".trees" */
  worktreeDir?: string;
  /** Whether to copy .env files into worktrees. @default false */
  copyEnvFiles?: boolean;
  /** Skip pre-commit hooks on AI-generated commits during reconcile. @default true */
  skipHooks?: boolean;
  /**
   * Write the worktree directory into the tracked `.gitignore` instead of the
   * clone-local `.git/info/exclude`. Off by default so Koryphaios never edits
   * a tracked file without being asked to.
   * @default false
   */
  modifyGitignore?: boolean;
  /**
   * Kernel sandbox for delegated agents.
   * - 'auto'     → sandbox whenever a real enforcement engine is installed
   *                 (bubblewrap on Linux, sandbox-exec on macOS)
   * - 'always'   → require it; sandboxed commands are refused when unavailable
   * - 'off'      → never sandbox delegated bash
   *
   * This controls filesystem/network confinement only, never approval prompts —
   * those follow the session's permission mode.
   * @default 'auto'
   */
  sandbox?: 'auto' | 'always' | 'off';
}

export interface ServerConfig {
  port: number;
  host: string;
}

export interface AgentSettings {
  /** Rule enforcement level - always applied, but critic can be strict/moderate/lenient */
  ruleEnforcementLevel: 'strict' | 'moderate' | 'lenient';
  /** Agent orchestration mode preference. Auto lets Kory decide when to delegate. */
  agentExecutionMode?: 'auto' | 'single' | 'multi';
  /** Whether to use preferences.md for workflow guidance */
  preferencesEnabled: boolean;
  /** Critic gate enabled - critic reviews all changes */
  criticGateEnabled: boolean;
  gateStrictness?: 'strict' | 'advisory' | 'off';
  intentInterview?: 'off' | 'adaptive' | 'deep';
  designDiscovery?: boolean;
  planApproval?: 'always' | 'material' | 'never';
  modelQualification?: 'enforce' | 'warn' | 'off';
  skillLearningMode?: 'human-only' | 'propose-then-verify' | 'automatic';
  /** Critic enforces preferences.md workflow strictly */
  criticEnforcesPreferences: boolean;
  /** Auto-apply fixes that don't violate rules */
  autoApplySafeFixes: boolean;
  /** Require confirmation for rule violations */
  confirmRuleViolations: boolean;
  /** Inter-agent messaging (AgentMail) policy. */
  agentMessaging?: 'open' | 'approval-cross-project' | 'off';
  /** Run the agent's tools without an upfront "proceed?" prompt (on by default). */
  autoRunTools?: boolean;
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
  /** Experimental: Local Web Search (DuckDuckGo) */
  localWebSearch?: 'off' | 'on' | 'fallback';
  /** Experimental: Multi-source research requirements */
  multiSourceResearch?: boolean;
  /** Opt into first-turn prompt-cache prewarming while composing. */
  promptCacheColdPrewarmEnabled?: boolean;
  /** Prompt-cache keepalive policy. Economic is the safe default; always is an explicit spend choice. */
  promptCacheKeepaliveMode?: 'economic' | 'always' | 'off';
  /** Context-window percentage at which automatic compaction triggers. */
  autoCompactThreshold?: number;
  /** Timestamp of last update for synchronization */
  updatedAt?: number;
}

export interface KoryphaiosConfig {
  providers: Record<string, ProviderConfig>;
  agents: {
    manager: { model: string; maxTokens?: number; reasoningLevel?: string };
    coder: { model: string; maxTokens?: number; reasoningLevel?: string };
    task: { model: string; maxTokens?: number };
  };
  /** Enable critic quality gate after worker completion. Disabled = faster/cheaper but less thorough. @default true */
  enableCritic?: boolean;
  /** UI Mode - beginner or advanced. @default "beginner" */
  mode?: 'beginner' | 'advanced';
  /** Full agent behavioral settings. If provided, overrides enableCritic. */
  agentSettings?: AgentSettings;
  /** Mapping of worker domains to specific models. Example: "ui": "openai:gpt-4.1" */
  assignments?: Partial<Record<WorkerDomain, string>>;
  /**
   * Per-model fallback chains. When a model's provider is unavailable or quota-limited,
   * try these models in order before falling back to other available providers.
   * Example: { "gemini-2.5-pro": ["gpt-4.1", "claude-sonnet-4-5"] }
   */
  fallbacks?: Record<string, string[]>;
  mcpServers?: Record<string, MCPServerConfig>;
  /** Server infrastructure settings. Deprecated: Use app.config.json instead. */
  server?: ServerConfig;
  contextPaths?: string[];
  dataDirectory: string;
  /** Allowed CORS origins */
  corsOrigins?: string[];
  /** Safety limits for tool execution and token budgets */
  safety?: SafetyLimits;
  /** Workspace/Worktree configuration for parallel agent isolation */
  workspace?: WorkspaceConfig;
  /** Timestamp of last update for synchronization */
  updatedAt?: number;
}
