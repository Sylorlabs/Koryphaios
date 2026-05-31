import { loadConfig, type BackendConfig } from './config';
import { wsBroker } from '../pubsub';
import { serverLog } from '../logger';
import { PROJECT_ROOT } from './paths';

/**
 * ConfigManager
 * Provides a reactive, cached view of the application configuration.
 * Listens for system.config_updated events to refresh the cache.
 */
export class ConfigManager {
  private static instance: ConfigManager;
  private currentConfig: BackendConfig;
  private projectRoot: string;

  private constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.currentConfig = loadConfig(projectRoot);
    this.setupListeners();
  }

  public static getInstance(projectRoot: string = PROJECT_ROOT): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager(projectRoot);
    }
    return ConfigManager.instance;
  }

  private setupListeners() {
    // Listen for global configuration updates
    const subscription = wsBroker.subscribe();
    const reader = subscription.getReader();

    const processEvents = async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          // wsBroker sends WSMessage as payload
          if (value.payload && value.payload.type === 'system.config_updated') {
            serverLog.info('ConfigManager: Refreshing config due to update event');
            this.refresh();
          }
        }
      } catch (err) {
        serverLog.error({ err }, 'ConfigManager: Event listener error');
      }
    };

    processEvents().catch((err) => serverLog.error({ err }, 'ConfigManager: Background process error'));
  }

  /**
   * Refresh the in-memory configuration from disk.
   */
  public refresh(): void {
    try {
      this.currentConfig = loadConfig(this.projectRoot);
    } catch (err) {
      serverLog.error({ err }, 'ConfigManager: Failed to refresh config');
    }
  }

  /**
   * Get the current configuration.
   */
  public getConfig(): BackendConfig {
    return this.currentConfig;
  }

  /**
   * Get agent settings.
   */
  public getAgentSettings() {
    return this.currentConfig.agentSettings;
  }
}

export const configManager = ConfigManager.getInstance();
