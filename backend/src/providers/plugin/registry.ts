/**
 * Plugin Registry
 *
 * Central registry for provider plugins. Manages plugin lifecycle,
 * discovery, and access.
 */

import type { PluginRegistry as IPluginRegistry, PluginFactory, ProviderPlugin } from './types';
import type { ProviderName, ProviderConfig } from '@koryphaios/shared';
import { providerLog } from '../../logger';

// ─── Plugin Registry Implementation ─────────────────────────────────────────

class PluginRegistryImpl implements IPluginRegistry {
  private factories = new Map<ProviderName, PluginFactory>();
  private instances = new Map<ProviderName, ProviderPlugin>();

  register(factory: PluginFactory): void {
    this.factories.set(factory.name, factory);
    providerLog.info(
      {
        provider: factory.name,
        displayName: factory.displayName,
      },
      'Plugin factory registered',
    );
  }

  getFactory(name: ProviderName): PluginFactory | undefined {
    return this.factories.get(name);
  }

  listFactories(): PluginFactory[] {
    return Array.from(this.factories.values());
  }

  async createPlugin(name: ProviderName, config: ProviderConfig): Promise<ProviderPlugin | null> {
    // Return existing instance if available and matches config
    const existing = this.instances.get(name);
    if (existing && this.configMatches(existing.config, config)) {
      return existing;
    }

    const factory = this.factories.get(name);
    if (!factory) {
      providerLog.warn({ provider: name }, 'No plugin factory found');
      return null;
    }

    // Validate config
    const validation = factory.validateConfig(config);
    if (!validation.valid) {
      providerLog.warn(
        {
          provider: name,
          errors: validation.errors,
        },
        'Plugin config validation failed',
      );
      return null;
    }

    try {
      const plugin = factory.create(config);
      await plugin.initialize(config);

      if (plugin.isAvailable()) {
        this.instances.set(name, plugin);
        providerLog.info({ provider: name }, 'Plugin created and initialized');
        return plugin;
      } else {
        providerLog.warn({ provider: name }, 'Plugin created but not available');
        return null;
      }
    } catch (error) {
      providerLog.error(
        {
          provider: name,
          error: (error as Error).message,
        },
        'Failed to create plugin',
      );
      return null;
    }
  }

  async disposePlugin(name: ProviderName): Promise<void> {
    const plugin = this.instances.get(name);
    if (plugin) {
      await plugin.dispose();
      this.instances.delete(name);
      providerLog.info({ provider: name }, 'Plugin disposed');
    }
  }

  getPlugin(name: ProviderName): ProviderPlugin | undefined {
    return this.instances.get(name);
  }

  listActivePlugins(): ProviderPlugin[] {
    return Array.from(this.instances.values());
  }

  private configMatches(a: ProviderConfig, b: ProviderConfig): boolean {
    return a.apiKey === b.apiKey && a.authToken === b.authToken && a.baseUrl === b.baseUrl;
  }
}

// ─── Singleton Export ───────────────────────────────────────────────────────

export const pluginRegistry = new PluginRegistryImpl();

// ─── Factory Registration Helpers ───────────────────────────────────────────

export function registerPluginFactory(factory: PluginFactory): void {
  pluginRegistry.register(factory);
}

export function createStandardOpenAIFactory(
  name: ProviderName,
  displayName: string,
  defaultBaseUrl: string,
  description?: string,
): PluginFactory {
  return {
    name,
    displayName,
    description,
    defaultBaseUrl,
    requiredEnvVars: [`${name.toUpperCase()}_API_KEY`],

    validateConfig(config): { valid: boolean; errors?: string[] } {
      const errors: string[] = [];

      if (!config.apiKey && !config.authToken) {
        errors.push(`API key or auth token required`);
      }

      return {
        valid: errors.length === 0,
        errors: errors.length > 0 ? errors : undefined,
      };
    },

    create(config): ProviderPlugin {
      const { OpenAICompatiblePlugin } = require('./openai-compatible');
      return new OpenAICompatiblePlugin(name, {
        ...config,
        baseUrl: config.baseUrl ?? defaultBaseUrl,
      });
    },
  };
}
