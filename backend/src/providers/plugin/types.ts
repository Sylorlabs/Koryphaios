/**
 * Plugin-Based Provider Architecture
 *
 * Core types for the new provider system. Replaces the monolithic
 * registry with a composable, capability-based plugin system.
 */

import type { ProviderName, ModelDef, ProviderConfig, ModelTier } from '@koryphaios/shared';
import type { ProviderEvent, StreamRequest } from '../types';

// ─── Capability Definitions ─────────────────────────────────────────────────

export interface ModelCapabilities {
  /** Maximum context window in tokens */
  contextWindow: number;

  /** Maximum output tokens per request */
  maxOutputTokens: number;

  /** Supported modalities */
  modalities: Array<'text' | 'image' | 'audio' | 'video'>;

  /** Tool use capabilities */
  tools: {
    supported: boolean;
    streaming: boolean;
    parallel: boolean;
  };

  /** Reasoning/thinking capabilities */
  reasoning?: {
    supported: boolean;
    levels: Array<'low' | 'medium' | 'high' | 'max'>;
    budgetTokens?: boolean;
  };

  /** Vision capabilities */
  vision?: {
    supported: boolean;
    maxImages: number;
  };

  /** JSON mode / structured output */
  structuredOutput: boolean;

  /** Streaming support */
  streaming: boolean;
}

export interface ProviderCapabilities {
  /** Provider supports runtime model discovery */
  supportsDiscovery: boolean;

  /** Provider supports streaming responses */
  supportsStreaming: boolean;

  /** Authentication methods supported */
  authMethods: Array<'api_key' | 'oauth' | 'jwt' | 'cli'>;

  /** Rate limit information (if available) */
  rateLimits?: {
    requestsPerMinute: number;
    tokensPerMinute: number;
  };
}

// ─── Health & Status ────────────────────────────────────────────────────────

export type HealthStatus =
  | { status: 'healthy'; latencyMs: number }
  | { status: 'degraded'; latencyMs: number; issues: string[]; retryAfter?: number }
  | { status: 'unavailable'; reason: string; retryAfter?: number };

export interface ProviderHealth {
  provider: ProviderName;
  status: HealthStatus;
  lastChecked: number;
  consecutiveFailures: number;
}

// ─── Plugin Interface ───────────────────────────────────────────────────────

export interface ProviderPlugin {
  readonly name: ProviderName;
  readonly capabilities: ProviderCapabilities;
  readonly config: ProviderConfig;

  /** Initialize the plugin with configuration */
  initialize(config: ProviderConfig): Promise<void>;

  /**
   * Discover available models from the provider.
   * Returns empty array if discovery is not supported.
   */
  fetchModels(): Promise<DiscoveredModel[]>;

  /** Get capabilities for a specific model */
  getCapabilities(modelId: string): Promise<ModelCapabilities>;

  /** Perform health check */
  healthCheck(): Promise<HealthStatus>;

  /** Stream a response from the model */
  stream(request: StreamRequest): AsyncGenerator<ProviderEvent>;

  /** Check if plugin is properly configured and ready */
  isAvailable(): boolean;

  /** Dispose of resources */
  dispose(): Promise<void>;
}

// ─── Discovered Model ───────────────────────────────────────────────────────

export interface DiscoveredModel extends ModelDef {
  /** When this model was discovered */
  discoveredAt: number;

  /** Full capability information */
  capabilities: ModelCapabilities;

  /** Whether this is a new model not in static catalog */
  isDynamic: boolean;
}

// ─── Plugin Factory ─────────────────────────────────────────────────────────

export interface PluginFactory {
  readonly name: ProviderName;
  readonly displayName: string;
  readonly description?: string;

  /** Create a new plugin instance */
  create(config: ProviderConfig): ProviderPlugin;

  /** Validate configuration */
  validateConfig(config: ProviderConfig): { valid: boolean; errors?: string[] };

  /** Default base URL if applicable */
  defaultBaseUrl?: string;

  /** Required environment variables */
  requiredEnvVars?: string[];
}

// ─── Plugin Registry ────────────────────────────────────────────────────────

export interface PluginRegistry {
  /** Register a plugin factory */
  register(factory: PluginFactory): void;

  /** Get plugin factory by name */
  getFactory(name: ProviderName): PluginFactory | undefined;

  /** List all registered factories */
  listFactories(): PluginFactory[];

  /** Create and initialize a plugin */
  createPlugin(name: ProviderName, config: ProviderConfig): Promise<ProviderPlugin | null>;
}
