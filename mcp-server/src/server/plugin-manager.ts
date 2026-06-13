/**
 * Plugin management system for extensible functionality
 */

import type { EventEmitter } from '@/types/index.js';

export interface Plugin {
  name: string;
  version: string;
  description: string;
  dependencies?: string[];
  initialize(context: PluginContext): Promise<void>;
  shutdown(): Promise<void>;
}

export interface PluginContext {
  eventEmitter: EventEmitter<any>;
  registerTool: (tool: any) => Promise<void>;
  registerResource: (resource: any) => Promise<void>;
  registerPrompt: (prompt: any) => Promise<void>;
  config: Record<string, unknown>;
}

export class PluginManager {
  private plugins: Map<string, Plugin> = new Map();
  private loadedPlugins: Set<string> = new Set();
  private context: PluginContext | undefined = undefined;

  async initialize(context?: PluginContext): Promise<void> {
    this.context = context;

    // Load core plugins
    await this.loadCorePlugins();
  }

  async loadPlugin(plugin: Plugin): Promise<void> {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin ${plugin.name} is already loaded`);
    }

    // Check dependencies
    if (plugin.dependencies) {
      for (const dep of plugin.dependencies) {
        if (!this.loadedPlugins.has(dep)) {
          throw new Error(`Plugin ${plugin.name} requires dependency ${dep} which is not loaded`);
        }
      }
    }

    try {
      this.plugins.set(plugin.name, plugin);

      if (this.context) {
        await plugin.initialize(this.context);
      }

      this.loadedPlugins.add(plugin.name);
    } catch (error) {
      this.plugins.delete(plugin.name);
      throw new Error(
        `Failed to load plugin ${plugin.name}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async unloadPlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Plugin ${name} is not loaded`);
    }

    // Check if other plugins depend on this one
    for (const [pluginName, pluginInstance] of this.plugins) {
      if (pluginName !== name && pluginInstance.dependencies?.includes(name)) {
        throw new Error(`Cannot unload plugin ${name} because ${pluginName} depends on it`);
      }
    }

    try {
      await plugin.shutdown();
      this.plugins.delete(name);
      this.loadedPlugins.delete(name);
    } catch (error) {
      throw new Error(
        `Failed to unload plugin ${name}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async shutdown(): Promise<void> {
    const shutdownPromises: Promise<void>[] = [];

    for (const plugin of this.plugins.values()) {
      shutdownPromises.push(
        plugin.shutdown().catch(error => {
          console.error(`Error shutting down plugin ${plugin.name}:`, error);
        })
      );
    }

    await Promise.all(shutdownPromises);
    this.plugins.clear();
    this.loadedPlugins.clear();
  }

  getLoadedPlugins(): string[] {
    return Array.from(this.loadedPlugins);
  }

  getPlugin(name: string): Plugin | undefined {
    return this.plugins.get(name);
  }

  isPluginLoaded(name: string): boolean {
    return this.loadedPlugins.has(name);
  }

  private async loadCorePlugins(): Promise<void> {
    // Core plugins will be loaded here
    // For now, we'll implement basic error detection and analysis plugins

    const errorDetectionPlugin: Plugin = {
      name: 'error-detection',
      version: '1.0.0',
      description: 'Core error detection functionality',

      async initialize(_context: PluginContext): Promise<void> {
        // Initialize error detection capabilities
        // Error detection plugin initialized
      },

      async shutdown(): Promise<void> {
        // Error detection plugin shutdown
      },
    };

    const errorAnalysisPlugin: Plugin = {
      name: 'error-analysis',
      version: '1.0.0',
      description: 'Core error analysis functionality',
      dependencies: ['error-detection'],

      async initialize(_context: PluginContext): Promise<void> {
        // Error analysis plugin initialized
      },

      async shutdown(): Promise<void> {
        // Error analysis plugin shutdown
      },
    };

    const debuggingPlugin: Plugin = {
      name: 'debugging',
      version: '1.0.0',
      description: 'Core debugging functionality',

      async initialize(_context: PluginContext): Promise<void> {
        // Debugging plugin initialized
      },

      async shutdown(): Promise<void> {
        // Debugging plugin shutdown
      },
    };

    // Load plugins in dependency order
    await this.loadPlugin(errorDetectionPlugin);
    await this.loadPlugin(errorAnalysisPlugin);
    await this.loadPlugin(debuggingPlugin);
  }
}
