/**
 * Model Discovery Service
 *
 * Runtime model discovery with caching and capability probing.
 * Replaces static model catalogs with dynamic, up-to-date model information.
 */

import type { DiscoveredModel, ProviderPlugin } from './plugin/types';
import type { ProviderName } from '@koryphaios/shared';
import { pluginRegistry } from './plugin/registry';
import { providerLog } from '../logger';

// ─── Configuration ──────────────────────────────────────────────────────────

export interface DiscoveryConfig {
  /** How often to refresh model lists (ms) */
  refreshIntervalMs: number;

  /** Cache TTL for model lists (ms) */
  cacheTtlMs: number;

  /** Whether to probe capabilities for discovered models */
  probeCapabilities: boolean;

  /** Maximum models to cache per provider */
  maxModelsPerProvider: number;
}

const DEFAULT_CONFIG: DiscoveryConfig = {
  refreshIntervalMs: 15 * 60 * 1000, // 15 minutes
  cacheTtlMs: 60 * 60 * 1000, // 1 hour
  probeCapabilities: true,
  maxModelsPerProvider: 100,
};

// ─── Cache Entry ────────────────────────────────────────────────────────────

interface CacheEntry {
  models: DiscoveredModel[];
  fetchedAt: number;
  provider: ProviderName;
}

// ─── Discovery Service ──────────────────────────────────────────────────────

export class ModelDiscoveryService {
  private cache = new Map<ProviderName, CacheEntry>();
  private config: DiscoveryConfig;
  private refreshTimers = new Map<ProviderName, NodeJS.Timeout>();
  private isRunning = false;

  constructor(config: Partial<DiscoveryConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start automatic background refresh
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    providerLog.info('Model discovery service started');

    // Initial discovery for all available plugins
    for (const plugin of pluginRegistry.listActivePlugins()) {
      if (plugin.capabilities.supportsDiscovery) {
        this.scheduleRefresh(plugin.name);
      }
    }
  }

  /**
   * Stop background refresh
   */
  stop(): void {
    this.isRunning = false;

    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }
    this.refreshTimers.clear();

    providerLog.info('Model discovery service stopped');
  }

  /**
   * Get models for a provider (from cache or fetch fresh)
   */
  async getModels(
    provider: ProviderName,
    options: { forceRefresh?: boolean } = {},
  ): Promise<DiscoveredModel[]> {
    const cached = this.cache.get(provider);

    // Return cached if valid
    if (!options.forceRefresh && cached && this.isCacheValid(cached)) {
      return cached.models;
    }

    // Fetch fresh
    return this.fetchModels(provider);
  }

  /**
   * Get all models from all providers
   */
  async getAllModels(options: { forceRefresh?: boolean } = {}): Promise<
    {
      provider: ProviderName;
      models: DiscoveredModel[];
    }[]
  > {
    const plugins = pluginRegistry
      .listActivePlugins()
      .filter((p) => p.capabilities.supportsDiscovery);

    const results = await Promise.allSettled(
      plugins.map(async (p) => ({
        provider: p.name,
        models: await this.getModels(p.name, options),
      })),
    );

    return results
      .filter(
        (
          r,
        ): r is PromiseFulfilledResult<{
          provider: ProviderName;
          models: DiscoveredModel[];
        }> => r.status === 'fulfilled',
      )
      .map((r) => r.value);
  }

  /**
   * Search models across all providers
   */
  async searchModels(query: string): Promise<DiscoveredModel[]> {
    const all = await this.getAllModels();
    const lowerQuery = query.toLowerCase();

    return all.flatMap(({ models }) =>
      models.filter(
        (m) => m.id.toLowerCase().includes(lowerQuery) || m.name.toLowerCase().includes(lowerQuery),
      ),
    );
  }

  /**
   * Force refresh for a specific provider
   */
  async refreshProvider(provider: ProviderName): Promise<DiscoveredModel[]> {
    return this.fetchModels(provider);
  }

  /**
   * Invalidate cache for a provider
   */
  invalidate(provider: ProviderName): void {
    this.cache.delete(provider);
    providerLog.info({ provider }, 'Model cache invalidated');
  }

  /**
   * Get model by ID across all providers
   */
  async findModel(modelId: string): Promise<DiscoveredModel | null> {
    const all = await this.getAllModels();

    for (const { models } of all) {
      const model = models.find((m) => m.id === modelId);
      if (model) return model;
    }

    return null;
  }

  /**
   * Get capability-aware model matching
   */
  async findModelsWithCapabilities(
    requirements: CapabilityRequirements,
  ): Promise<DiscoveredModel[]> {
    const all = await this.getAllModels();

    return all.flatMap(({ models }) =>
      models.filter((m) => this.meetsRequirements(m, requirements)),
    );
  }

  // ─── Private Methods ──────────────────────────────────────────────────────

  private async fetchModels(provider: ProviderName): Promise<DiscoveredModel[]> {
    const plugin = pluginRegistry.getPlugin(provider);
    if (!plugin) {
      providerLog.warn({ provider }, 'Plugin not found for discovery');
      return [];
    }

    if (!plugin.capabilities.supportsDiscovery) {
      providerLog.debug({ provider }, 'Plugin does not support discovery');
      return [];
    }

    try {
      providerLog.info({ provider }, 'Fetching models...');

      const models = await plugin.fetchModels();

      // Limit cache size
      const limited = models.slice(0, this.config.maxModelsPerProvider);

      // Enhance with capabilities if enabled
      const enhanced = this.config.probeCapabilities
        ? await this.enhanceWithCapabilities(provider, limited)
        : limited;

      // Update cache
      this.cache.set(provider, {
        models: enhanced,
        fetchedAt: Date.now(),
        provider,
      });

      providerLog.info(
        {
          provider,
          count: enhanced.length,
        },
        'Models discovered',
      );

      // Reschedule refresh
      if (this.isRunning) {
        this.scheduleRefresh(provider);
      }

      return enhanced;
    } catch (error) {
      providerLog.error(
        {
          provider,
          error: (error as Error).message,
        },
        'Failed to fetch models',
      );
      return [];
    }
  }

  private async enhanceWithCapabilities(
    provider: ProviderName,
    models: DiscoveredModel[],
  ): Promise<DiscoveredModel[]> {
    const plugin = pluginRegistry.getPlugin(provider);
    if (!plugin) return models;

    // Probe capabilities for a sample of models (not all to avoid rate limits)
    const toProbe = models.slice(0, 5);

    const probed = await Promise.allSettled(
      toProbe.map(async (m) => {
        const caps = await plugin.getCapabilities(m.id);
        return {
          ...m,
          capabilities: caps,
          contextWindow: caps.contextWindow || m.contextWindow,
          maxOutputTokens: caps.maxOutputTokens || m.maxOutputTokens,
        };
      }),
    );

    // Build capability inference from probed models
    const capabilityPatterns = probed
      .filter((r): r is PromiseFulfilledResult<DiscoveredModel> => r.status === 'fulfilled')
      .map((r) => r.value);

    // Apply inferred capabilities to all models
    return models.map((m) => {
      const probed = capabilityPatterns.find((p) => p.id === m.id);
      if (probed) return probed;

      // Infer from model ID patterns
      return this.inferCapabilitiesFromPatterns(m);
    });
  }

  private inferCapabilitiesFromPatterns(model: DiscoveredModel): DiscoveredModel {
    const id = model.id.toLowerCase();

    // Context window patterns
    let contextWindow = model.contextWindow;
    if (id.includes('128k') || id.includes('128k')) contextWindow = 128000;
    else if (id.includes('32k')) contextWindow = 32768;
    else if (id.includes('200k')) contextWindow = 200000;
    else if (id.includes('1m')) contextWindow = 1000000;

    // Vision support
    const hasVision =
      id.includes('vision') ||
      id.includes('gpt-4o') ||
      id.includes('claude-3') ||
      id.includes('gemini');

    return {
      ...model,
      contextWindow,
      capabilities: {
        ...model.capabilities,
        contextWindow,
        modalities: hasVision ? ['text', 'image'] : model.capabilities.modalities,
        vision: hasVision
          ? {
              supported: true,
              maxImages: 10,
            }
          : model.capabilities.vision,
      },
    };
  }

  private isCacheValid(entry: CacheEntry): boolean {
    return Date.now() - entry.fetchedAt < this.config.cacheTtlMs;
  }

  private scheduleRefresh(provider: ProviderName): void {
    // Clear existing timer
    const existing = this.refreshTimers.get(provider);
    if (existing) {
      clearTimeout(existing);
    }

    // Schedule next refresh
    const timer = setTimeout(() => {
      this.fetchModels(provider).catch(() => {});
    }, this.config.refreshIntervalMs);

    this.refreshTimers.set(provider, timer);
  }

  private meetsRequirements(model: DiscoveredModel, requirements: CapabilityRequirements): boolean {
    const caps = model.capabilities;

    if (requirements.minContextWindow && caps.contextWindow < requirements.minContextWindow) {
      return false;
    }

    if (requirements.vision && !caps.vision?.supported) {
      return false;
    }

    if (requirements.tools && !caps.tools.supported) {
      return false;
    }

    if (requirements.reasoning && !caps.reasoning?.supported) {
      return false;
    }

    return true;
  }
}

// ─── Capability Requirements ────────────────────────────────────────────────

export interface CapabilityRequirements {
  minContextWindow?: number;
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
  streaming?: boolean;
}

// ─── Singleton Export ───────────────────────────────────────────────────────

export const discoveryService = new ModelDiscoveryService();
