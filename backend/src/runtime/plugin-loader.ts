/**
 * Plugin Architecture for Koryphaios
 *
 * Core principle: Load features dynamically, not at build time.
 * This allows:
 * - Core to stay small (~2MB)
 * - Heavy features (Discord, Slack) as optional plugins
 * - Users only download what they need
 */

import { serverLog } from '../logger';
import { existsSync } from 'fs';
import { resolve } from 'path';

export interface Plugin {
  name: string;
  version: string;
  description: string;
  size: string; // Estimated size
  dependencies: string[];
  initialize: () => Promise<void> | void;
  shutdown?: () => Promise<void> | void;
}

// Registry of available plugins
const PLUGIN_REGISTRY: Record<string, () => Promise<Plugin>> = {
  // Core plugins (always loaded)
  core: async () => ({
    name: 'core',
    version: '1.0.0',
    description: 'Essential AI functionality',
    size: '2 MB',
    dependencies: [],
    initialize: () => {
      serverLog.info('Core plugin loaded');
    },
  }),

  postgres: async () => {
    return {
      name: 'postgres',
      version: '1.0.0',
      description: 'PostgreSQL database support',
      size: '3 MB',
      dependencies: ['pg'],
      initialize: () => {
        serverLog.info('PostgreSQL plugin loaded');
      },
    };
  },
};

class PluginManager {
  private loadedPlugins: Map<string, Plugin> = new Map();
  private pluginPath: string;

  constructor() {
    this.pluginPath = process.env.KORYPHAIOS_PLUGIN_PATH || resolve(process.cwd(), 'plugins');
  }

  /**
   * Load a plugin by name
   */
  async load(name: string): Promise<boolean> {
    if (this.loadedPlugins.has(name)) {
      serverLog.debug(`Plugin ${name} already loaded`);
      return true;
    }

    const loader = PLUGIN_REGISTRY[name];
    if (!loader) {
      serverLog.error(`Unknown plugin: ${name}`);
      return false;
    }

    try {
      serverLog.info(`Loading plugin: ${name}...`);
      const plugin = await loader();
      await plugin.initialize();
      this.loadedPlugins.set(name, plugin);
      serverLog.info(`✓ Plugin ${name} loaded (${plugin.size})`);
      return true;
    } catch (err) {
      serverLog.error({ err }, `Failed to load plugin ${name}`);
      return false;
    }
  }

  /**
   * Unload a plugin
   */
  async unload(name: string): Promise<boolean> {
    const plugin = this.loadedPlugins.get(name);
    if (!plugin) {
      return false;
    }

    if (plugin.shutdown) {
      await plugin.shutdown();
    }

    this.loadedPlugins.delete(name);
    serverLog.info(`Plugin ${name} unloaded`);
    return true;
  }

  /**
   * Get list of available plugins
   */
  listAvailable(): Array<{ name: string; description: string; size: string }> {
    return Object.entries(PLUGIN_REGISTRY).map(([name, loader]) => ({
      name,
      description: 'Loading...',
      size: 'Unknown',
    }));
  }

  /**
   * Get list of loaded plugins
   */
  listLoaded(): Plugin[] {
    return Array.from(this.loadedPlugins.values());
  }

  /**
   * Load plugins from environment/config
   */
  async loadFromConfig(config: { plugins?: string[] }): Promise<void> {
    const plugins = config.plugins || ['core'];

    for (const name of plugins) {
      await this.load(name);
    }
  }

  /**
   * Get total size of loaded plugins
   */
  getLoadedSize(): string {
    let totalMB = 0;
    for (const plugin of this.loadedPlugins.values()) {
      const sizeMB = parseFloat(plugin.size.replace(/[^0-9.]/g, ''));
      totalMB += sizeMB;
    }
    return `${totalMB.toFixed(1)} MB`;
  }
}

// Singleton instance
export const pluginManager = new PluginManager();
