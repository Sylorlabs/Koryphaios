/**
 * VS Code Integration for Error Debugging MCP Server
 * Provides seamless integration with VS Code's diagnostic and development features
 */

import { EventEmitter } from 'events';
import { DevelopmentEnvironment } from '../debug/development-environment.js';
import { SupportedLanguage } from '../types/languages.js';
import { Logger } from '../utils/logger.js';

export interface VSCodeIntegrationConfig {
  enabled: boolean;
  diagnosticsProvider: boolean;
  codeActionsProvider: boolean;
  hoverProvider: boolean;
  completionProvider: boolean;
  realTimeAnalysis: boolean;
  autoSuggestions: boolean;
}

export interface VSCodeDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source: string;
  code?: string | number;
  relatedInformation?: Array<{
    location: {
      uri: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    };
    message: string;
  }>;
}

export interface VSCodeCodeAction {
  title: string;
  kind: 'quickfix' | 'refactor' | 'source';
  diagnostics?: VSCodeDiagnostic[];
  isPreferred?: boolean;
  edit?: {
    changes: Record<
      string,
      Array<{
        range: {
          start: { line: number; character: number };
          end: { line: number; character: number };
        };
        newText: string;
      }>
    >;
  };
  command?: {
    title: string;
    command: string;
    arguments?: any[];
  };
}

export interface VSCodeHoverInfo {
  contents: Array<{
    language?: string;
    value: string;
  }>;
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export class VSCodeIntegration extends EventEmitter {
  private config: VSCodeIntegrationConfig;
  private devEnvironment: DevelopmentEnvironment;
  private logger: Logger;
  private isActive = false;
  private documentCache = new Map<string, string>();
  private diagnosticsCache = new Map<string, VSCodeDiagnostic[]>();

  constructor(devEnvironment: DevelopmentEnvironment, config: VSCodeIntegrationConfig) {
    super();
    this.devEnvironment = devEnvironment;
    this.config = config;
    this.logger = new Logger('info', {
      logFile: undefined,
      enableConsole: true,
    });

    this.setupEventHandlers();
  }

  /**
   * Initialize VS Code integration
   */
  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.info('VS Code integration is disabled');
      return;
    }

    this.logger.info('Initializing VS Code integration', this.config);

    try {
      // Register with VS Code's extension API
      await this.registerWithVSCode();

      // Set up real-time analysis if enabled
      if (this.config.realTimeAnalysis) {
        await this.setupRealTimeAnalysis();
      }

      this.isActive = true;
      this.emit('initialized');
      this.logger.info('VS Code integration initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize VS Code integration', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Provide diagnostics for a document
   */
  async provideDiagnostics(
    uri: string,
    content: string,
    language: string
  ): Promise<VSCodeDiagnostic[]> {
    if (!this.isActive) {
      return [];
    }

    try {
      this.logger.debug('Providing diagnostics for document', { uri, language });

      // Cache the document content
      this.documentCache.set(uri, content);

      // Detect errors using our development environment
      const supportedLanguage = this.mapLanguage(language);
      if (!supportedLanguage) {
        this.logger.warn(`Unsupported language: ${language}`);
        return [];
      }

      const errors = await this.devEnvironment.detectErrors(content, supportedLanguage, uri);

      // Convert to VS Code diagnostics format
      const diagnostics: VSCodeDiagnostic[] = errors.map(error => ({
        range: {
          start: {
            line: Math.max(0, error.location.line - 1), // Convert to 0-based
            character: Math.max(0, error.location.column - 1),
          },
          end: {
            line: Math.max(0, (error.location.endLine || error.location.line) - 1),
            character: Math.max(0, (error.location.endColumn || error.location.column) - 1),
          },
        },
        severity: error.severity as any,
        message: error.message,
        source: `Error Debugging MCP (${error.source})`,
        code: error.code,
      }));

      // Cache diagnostics
      this.diagnosticsCache.set(uri, diagnostics);

      this.emit('diagnosticsProvided', uri, diagnostics);
      return diagnostics;
    } catch (error) {
      this.logger.error('Failed to provide diagnostics', { uri, error });
      return [];
    }
  }

  /**
   * Provide code actions for diagnostics
   */
  async provideCodeActions(
    uri: string,
    range: { start: { line: number; character: number }; end: { line: number; character: number } },
    context: { diagnostics: VSCodeDiagnostic[] }
  ): Promise<VSCodeCodeAction[]> {
    if (!this.config.codeActionsProvider) {
      return [];
    }

    try {
      this.logger.debug('Providing code actions', {
        uri,
        range,
        diagnostics: context.diagnostics.length,
      });

      const actions: VSCodeCodeAction[] = [];

      for (const diagnostic of context.diagnostics) {
        if (diagnostic.source?.includes('Error Debugging MCP')) {
          // Generate quick fixes based on error type
          const quickFixes = await this.generateQuickFixes(uri, diagnostic);
          actions.push(...quickFixes);
        }
      }

      // Add general code actions
      if (context.diagnostics.length > 0) {
        actions.push({
          title: 'Fix all auto-fixable problems',
          kind: 'source',
          command: {
            title: 'Fix all problems',
            command: 'errorDebugging.fixAll',
            arguments: [uri],
          },
        });
      }

      this.emit('codeActionsProvided', uri, actions);
      return actions;
    } catch (error) {
      this.logger.error('Failed to provide code actions', { uri, error });
      return [];
    }
  }

  /**
   * Provide hover information
   */
  async provideHover(
    uri: string,
    position: { line: number; character: number }
  ): Promise<VSCodeHoverInfo | null> {
    if (!this.config.hoverProvider) {
      return null;
    }

    try {
      this.logger.debug('Providing hover information', { uri, position });

      // Get diagnostics at position
      const diagnostics = this.diagnosticsCache.get(uri) || [];
      const relevantDiagnostics = diagnostics.filter(diag =>
        this.isPositionInRange(position, diag.range)
      );

      if (relevantDiagnostics.length === 0) {
        return null;
      }

      const contents: Array<{ language?: string; value: string }> = [];

      for (const diagnostic of relevantDiagnostics) {
        contents.push({
          value: `**${diagnostic.severity.toUpperCase()}**: ${diagnostic.message}`,
        });

        if (diagnostic.code) {
          contents.push({
            value: `**Code**: ${diagnostic.code}`,
          });
        }
      }

      const hoverInfo: VSCodeHoverInfo = {
        contents,
        range: relevantDiagnostics[0]?.range || {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
      };

      this.emit('hoverProvided', uri, hoverInfo);
      return hoverInfo;
    } catch (error) {
      this.logger.error('Failed to provide hover information', { uri, error });
      return null;
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): VSCodeIntegrationConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<VSCodeIntegrationConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.logger.info('VS Code integration configuration updated', this.config);
    this.emit('configUpdated', this.config);
  }

  /**
   * Get integration statistics
   */
  getStatistics() {
    return {
      isActive: this.isActive,
      documentsTracked: this.documentCache.size,
      diagnosticsCached: this.diagnosticsCache.size,
      config: this.config,
    };
  }

  /**
   * Dispose and cleanup
   */
  async dispose(): Promise<void> {
    this.logger.info('Disposing VS Code integration');

    this.isActive = false;
    this.documentCache.clear();
    this.diagnosticsCache.clear();
    this.removeAllListeners();

    this.logger.info('VS Code integration disposed');
  }

  /**
   * Register with VS Code's extension API
   */
  private async registerWithVSCode(): Promise<void> {
    // This would integrate with VS Code's actual extension API
    // For now, we'll simulate the registration
    this.logger.debug('Registering with VS Code extension API');
  }

  /**
   * Set up real-time analysis
   */
  private async setupRealTimeAnalysis(): Promise<void> {
    this.logger.debug('Setting up real-time analysis');
    // Set up document change listeners
  }

  /**
   * Set up event handlers
   */
  private setupEventHandlers(): void {
    // Listen to development environment events
    this.devEnvironment.on('errorsDetected', (errors, language, filePath) => {
      this.emit('errorsDetected', errors, language, filePath);
    });
  }

  /**
   * Map language string to supported language enum
   */
  private mapLanguage(language: string): SupportedLanguage | null {
    const languageMap: Record<string, SupportedLanguage> = {
      typescript: SupportedLanguage.TYPESCRIPT,
      javascript: SupportedLanguage.JAVASCRIPT,
      python: SupportedLanguage.PYTHON,
      go: SupportedLanguage.GO,
      rust: SupportedLanguage.RUST,
    };

    return languageMap[language.toLowerCase()] || null;
  }

  /**
   * Check if position is within range
   */
  private isPositionInRange(
    position: { line: number; character: number },
    range: { start: { line: number; character: number }; end: { line: number; character: number } }
  ): boolean {
    if (position.line < range.start.line || position.line > range.end.line) {
      return false;
    }

    if (position.line === range.start.line && position.character < range.start.character) {
      return false;
    }

    if (position.line === range.end.line && position.character > range.end.character) {
      return false;
    }

    return true;
  }

  /**
   * Generate quick fixes for diagnostics
   */
  private async generateQuickFixes(
    _uri: string,
    diagnostic: VSCodeDiagnostic
  ): Promise<VSCodeCodeAction[]> {
    const actions: VSCodeCodeAction[] = [];

    // Generate fixes based on error patterns
    if (diagnostic.message.includes('is not assignable to type')) {
      actions.push({
        title: 'Add type assertion',
        kind: 'quickfix',
        diagnostics: [diagnostic],
        isPreferred: true,
      });
    }

    if (diagnostic.message.includes('Cannot find name')) {
      actions.push({
        title: 'Import missing dependency',
        kind: 'quickfix',
        diagnostics: [diagnostic],
      });
    }

    return actions;
  }
}
