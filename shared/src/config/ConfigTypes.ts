// Configuration Types
// Domain: Application configuration structure

// Import types to avoid circular dependency
import type { ProviderConfig } from "../providers/ModelDefs";
import type { WorkerDomain } from "../types/AgentTypes";

export interface MCPServerConfig {
  type: "stdio" | "sse";
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
}

export interface TelegramConfig {
  botToken: string;
  adminId: number;
  webhookUrl?: string;
  secretToken?: string;
}

export interface ServerConfig {
  port: number;
  host: string;
}

export interface KoryphaiosConfig {
  providers: Record<string, ProviderConfig>;
  agents: {
    manager: { model: string; maxTokens?: number; reasoningLevel?: string };
    coder: { model: string; maxTokens?: number; reasoningLevel?: string };
    task: { model: string; maxTokens?: number };
  };
  /** Mapping of worker domains to specific models. Example: "ui": "openai:gpt-4.1" */
  assignments?: Partial<Record<WorkerDomain, string>>;
  /**
   * Per-model fallback chains. When a model's provider is unavailable or quota-limited,
   * try these models in order before falling back to other available providers.
   * Example: { "gemini-2.5-pro": ["gpt-4.1", "claude-sonnet-4-5"] }
   */
  fallbacks?: Record<string, string[]>;
  mcpServers?: Record<string, MCPServerConfig>;
  telegram?: TelegramConfig;
  server: ServerConfig;
  contextPaths?: string[];
  dataDirectory: string;
  /** Allowed CORS origins */
  corsOrigins?: string[];
  /** Safety limits for tool execution and token budgets */
  safety?: SafetyLimits;
  /** Workspace/Worktree configuration for parallel agent isolation */
  workspace?: WorkspaceConfig;
}
