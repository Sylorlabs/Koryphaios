/**
 * Integration Manager for Error Debugging MCP Server
 * Manages all IDE integrations and provides unified interface
 */

import { EventEmitter } from 'events';
import { DevelopmentEnvironment } from '../debug/development-environment.js';
import { VSCodeIntegration } from './vscode-integration.js';
import type { VSCodeIntegrationConfig } from './vscode-integration.js';
import { CursorIntegration } from './cursor-integration.js';
import type { CursorIntegrationConfig } from './cursor-integration.js';
import { WindsurfIntegration } from './windsurf-integration.js';
import type { WindsurfIntegrationConfig } from './windsurf-integration.js';
import { AugmentIntegration } from './augment-integration.js';
import type { AugmentIntegrationConfig } from './augment-integration.js';
import { Logger } from '../utils/logger.js';

export interface IntegrationManagerConfig {
  vscode: VSCodeIntegrationConfig;
  cursor: CursorIntegrationConfig;
  windsurf: WindsurfIntegrationConfig;
  augment: AugmentIntegrationConfig;
  enabledIntegrations: ('vscode' | 'cursor' | 'windsurf' | 'augment')[];
  autoDetectIDE: boolean;
  fallbackIntegration: 'vscode' | 'cursor' | 'windsurf' | 'augment';
}

export interface IntegrationStatus {
  name: string;
  enabled: boolean;
  active: boolean;
  initialized: boolean;
  lastActivity: Date | null;
  statistics: any;
  errors: string[];
}

export class IntegrationManager extends EventEmitter {
  private config: IntegrationManagerConfig;
  private devEnvironment: DevelopmentEnvironment;
  private logger: Logger;
  private integrations = new Map<string, any>();
  private activeIntegration: string | null = null;
  private isInitialized = false;

  constructor(devEnvironment: DevelopmentEnvironment, config: IntegrationManagerConfig) {
    super();
    this.devEnvironment = devEnvironment;
    this.config = config;
    this.logger = new Logger('info', {
      logFile: undefined,
      enableConsole: true,
    });
  }

  /**
   * Initialize all enabled integrations
   */
  async initialize(): Promise<void> {
    this.logger.info('Initializing Integration Manager', {
      enabledIntegrations: this.config.enabledIntegrations,
      autoDetectIDE: this.config.autoDetectIDE,
    });

    try {
      // Initialize enabled integrations
      for (const integrationName of this.config.enabledIntegrations) {
        await this.initializeIntegration(integrationName);
      }

      // Auto-detect active IDE if enabled
      if (this.config.autoDetectIDE) {
        await this.autoDetectActiveIDE();
      }

      // Set fallback integration if no active integration
      if (!this.activeIntegration && this.config.fallbackIntegration) {
        await this.setActiveIntegration(this.config.fallbackIntegration);
      }

      this.isInitialized = true;
      this.emit('initialized');
      this.logger.info('Integration Manager initialized successfully', {
        activeIntegration: this.activeIntegration,
        totalIntegrations: this.integrations.size,
      });
    } catch (error) {
      this.logger.error('Failed to initialize Integration Manager', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Initialize a specific integration
   */
  async initializeIntegration(name: string): Promise<void> {
    try {
      this.logger.debug(`Initializing ${name} integration`);

      let integration: any;
      switch (name) {
        case 'vscode':
          integration = new VSCodeIntegration(this.devEnvironment, this.config.vscode);
          break;
        case 'cursor':
          integration = new CursorIntegration(this.devEnvironment, this.config.cursor);
          break;
        case 'windsurf':
          integration = new WindsurfIntegration(this.devEnvironment, this.config.windsurf);
          break;
        case 'augment':
          integration = new AugmentIntegration(this.devEnvironment, this.config.augment);
          break;
        default:
          throw new Error(`Unknown integration: ${name}`);
      }

      // Set up event forwarding
      this.setupIntegrationEvents(integration, name);

      // Initialize the integration
      await integration.initialize();

      // Store the integration
      this.integrations.set(name, integration);

      this.emit('integrationInitialized', name);
      this.logger.info(`${name} integration initialized successfully`);
    } catch (error) {
      this.logger.error(`Failed to initialize ${name} integration`, error);
      this.emit('integrationError', name, error);
      throw error;
    }
  }

  /**
   * Set the active integration
   */
  async setActiveIntegration(name: string): Promise<void> {
    if (!this.integrations.has(name)) {
      throw new Error(`Integration ${name} is not initialized`);
    }

    const previousActive = this.activeIntegration;
    this.activeIntegration = name;

    this.emit('activeIntegrationChanged', name, previousActive);
    this.logger.info(`Active integration changed to ${name}`, { previous: previousActive });
  }

  /**
   * Get the active integration
   */
  getActiveIntegration(): any | null {
    if (!this.activeIntegration) {
      return null;
    }
    return this.integrations.get(this.activeIntegration) || null;
  }

  /**
   * Get a specific integration
   */
  getIntegration(name: string): any | null {
    return this.integrations.get(name) || null;
  }

  /**
   * Get all integration statuses
   */
  getIntegrationStatuses(): IntegrationStatus[] {
    const statuses: IntegrationStatus[] = [];

    for (const [name, integration] of this.integrations) {
      try {
        const statistics = integration.getStatistics ? integration.getStatistics() : {};

        statuses.push({
          name,
          enabled: this.config.enabledIntegrations.includes(name as any),
          active: this.activeIntegration === name,
          initialized: true,
          lastActivity: statistics.lastActivity || null,
          statistics,
          errors: [],
        });
      } catch (error) {
        statuses.push({
          name,
          enabled: this.config.enabledIntegrations.includes(name as any),
          active: false,
          initialized: false,
          lastActivity: null,
          statistics: {},
          errors: [error instanceof Error ? error.message : 'Unknown error'],
        });
      }
    }

    // Add statuses for enabled but not initialized integrations
    for (const name of this.config.enabledIntegrations) {
      if (!this.integrations.has(name)) {
        statuses.push({
          name,
          enabled: true,
          active: false,
          initialized: false,
          lastActivity: null,
          statistics: {},
          errors: ['Not initialized'],
        });
      }
    }

    return statuses;
  }

  /**
   * Update configuration for a specific integration
   */
  async updateIntegrationConfig(name: string, config: Record<string, unknown>): Promise<void> {
    const integration = this.integrations.get(name);
    if (!integration) {
      throw new Error(`Integration ${name} is not initialized`);
    }

    if (integration.updateConfig) {
      integration.updateConfig(config);
      this.emit('integrationConfigUpdated', name, config);
      this.logger.info(`${name} integration configuration updated`);
    } else {
      throw new Error(`Integration ${name} does not support configuration updates`);
    }
  }

  /**
   * Enable an integration
   */
  async enableIntegration(name: string): Promise<void> {
    if (!this.config.enabledIntegrations.includes(name as any)) {
      this.config.enabledIntegrations.push(name as any);
    }

    if (!this.integrations.has(name)) {
      await this.initializeIntegration(name);
    }

    this.emit('integrationEnabled', name);
    this.logger.info(`${name} integration enabled`);
  }

  /**
   * Disable an integration
   */
  async disableIntegration(name: string): Promise<void> {
    // Remove from enabled list
    this.config.enabledIntegrations = this.config.enabledIntegrations.filter(
      integrationName => integrationName !== name
    );

    // Dispose integration if it exists
    const integration = this.integrations.get(name);
    if (integration) {
      if (integration.dispose) {
        await integration.dispose();
      }
      this.integrations.delete(name);
    }

    // Change active integration if this was active
    if (this.activeIntegration === name) {
      this.activeIntegration = null;

      // Try to set fallback
      if (
        this.config.fallbackIntegration &&
        this.integrations.has(this.config.fallbackIntegration)
      ) {
        await this.setActiveIntegration(this.config.fallbackIntegration);
      }
    }

    this.emit('integrationDisabled', name);
    this.logger.info(`${name} integration disabled`);
  }

  /**
   * Auto-detect the active IDE
   */
  async autoDetectActiveIDE(): Promise<void> {
    this.logger.debug('Auto-detecting active IDE');

    // Detection logic would check for IDE-specific environment variables,
    // process names, or other indicators
    const detectionResults = await this.performIDEDetection();

    for (const [ideName, confidence] of detectionResults) {
      if (confidence > 0.8 && this.integrations.has(ideName)) {
        await this.setActiveIntegration(ideName);
        this.logger.info(`Auto-detected active IDE: ${ideName} (confidence: ${confidence})`);
        return;
      }
    }

    this.logger.debug('No IDE auto-detected with high confidence');
  }

  /**
   * Get comprehensive statistics
   */
  getStatistics() {
    return {
      isInitialized: this.isInitialized,
      activeIntegration: this.activeIntegration,
      totalIntegrations: this.integrations.size,
      enabledIntegrations: this.config.enabledIntegrations,
      integrationStatuses: this.getIntegrationStatuses(),
      config: this.config,
    };
  }

  /**
   * Dispose all integrations
   */
  async dispose(): Promise<void> {
    this.logger.info('Disposing Integration Manager');

    // Dispose all integrations
    for (const [name, integration] of this.integrations) {
      try {
        if (integration.dispose) {
          await integration.dispose();
        }
        this.logger.debug(`${name} integration disposed`);
      } catch (error) {
        this.logger.warn(`Failed to dispose ${name} integration`, error);
      }
    }

    this.integrations.clear();
    this.activeIntegration = null;
    this.isInitialized = false;
    this.removeAllListeners();

    this.logger.info('Integration Manager disposed');
  }

  /**
   * Set up event forwarding for an integration
   */
  private setupIntegrationEvents(integration: any, name: string): void {
    // Forward common events
    const eventsToForward = [
      'errorsDetected',
      'diagnosticsProvided',
      'codeActionsProvided',
      'hoverProvided',
      'completionsProvided',
      'performanceAnalyzed',
      'debugSessionCreated',
      'breakpointHit',
      'variablesUpdated',
      'callStackUpdated',
    ];

    for (const eventName of eventsToForward) {
      integration.on(eventName, (...args: any[]) => {
        this.emit(`${name}:${eventName}`, ...args);
        this.emit(eventName, name, ...args);
      });
    }

    // Forward error events
    integration.on('error', (error: Error) => {
      this.emit('integrationError', name, error);
      this.logger.error(`${name} integration error`, error);
    });

    // Forward configuration updates
    integration.on('configUpdated', (config: Record<string, unknown>) => {
      this.emit('integrationConfigUpdated', name, config);
    });
  }

  /**
   * Perform IDE detection
   */
  private async performIDEDetection(): Promise<Array<[string, number]>> {
    const results: Array<[string, number]> = [];

    // Check for VS Code
    if (process.env['VSCODE_PID'] || process.env['TERM_PROGRAM'] === 'vscode') {
      results.push(['vscode', 0.9]);
    }

    // Check for Cursor
    if (process.env['CURSOR_PID'] || process.env['TERM_PROGRAM'] === 'cursor') {
      results.push(['cursor', 0.9]);
    }

    // Check for Windsurf
    if (process.env['WINDSURF_PID'] || process.env['TERM_PROGRAM'] === 'windsurf') {
      results.push(['windsurf', 0.9]);
    }

    // Check for Augment Code
    if (process.env['AUGMENT_PID'] || process.env['TERM_PROGRAM'] === 'augment') {
      results.push(['augment', 0.9]);
    }

    // Additional detection logic could be added here
    // For example, checking running processes, window titles, etc.

    return results.sort((a, b) => b[1] - a[1]); // Sort by confidence descending
  }
}

/**
 * Create default integration manager configuration
 */
export function createDefaultIntegrationConfig(): IntegrationManagerConfig {
  return {
    vscode: {
      enabled: true,
      diagnosticsProvider: true,
      codeActionsProvider: true,
      hoverProvider: true,
      completionProvider: false,
      realTimeAnalysis: true,
      autoSuggestions: true,
    },
    cursor: {
      enabled: true,
      aiAssistance: true,
      realTimeAnalysis: true,
      contextSharing: true,
      autoSuggestions: true,
      debugIntegration: true,
      performanceInsights: true,
      codeActions: true,
      hoverProvider: true,
      completionProvider: false,
    },
    windsurf: {
      enabled: true,
      advancedFeatures: true,
      realTimeDebugging: true,
      performanceAnalysis: true,
      codeIntelligence: true,
      collaborativeDebugging: false,
      visualDebugging: true,
      memoryProfiling: true,
      networkAnalysis: true,
      securityScanning: true,
      aiPoweredInsights: true,
    },
    augment: {
      enabled: true,
      contextEngine: true,
      aiAssistance: true,
      codebaseAnalysis: true,
      semanticSearch: true,
      intelligentSuggestions: true,
      contextualDebugging: true,
      crossFileAnalysis: true,
      dependencyTracking: true,
      refactoringAssistance: true,
      codeGeneration: true,
      documentationGeneration: true,
    },
    enabledIntegrations: ['vscode', 'cursor', 'windsurf', 'augment'],
    autoDetectIDE: true,
    fallbackIntegration: 'vscode',
  };
}
