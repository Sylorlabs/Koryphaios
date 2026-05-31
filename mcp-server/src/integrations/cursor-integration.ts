/**
 * Cursor IDE Integration for Error Debugging MCP Server
 * Provides seamless integration with Cursor's AI-powered development environment
 */

import { EventEmitter } from 'events';
import { DevelopmentEnvironment } from '../debug/development-environment.js';
import { SupportedLanguage } from '../types/languages.js';
import { Logger } from '../utils/logger.js';

export interface CursorIntegrationConfig {
  enabled: boolean;
  aiAssistance: boolean;
  realTimeAnalysis: boolean;
  contextSharing: boolean;
  autoSuggestions: boolean;
  debugIntegration: boolean;
  performanceInsights: boolean;
  codeActions: boolean;
  hoverProvider: boolean;
  completionProvider: boolean;
}

export interface CursorDiagnostic {
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
  tags?: Array<'unnecessary' | 'deprecated'>;
  data?: any;
}

export interface CursorCodeAction {
  title: string;
  kind: 'quickfix' | 'refactor' | 'source' | 'source.organizeImports';
  diagnostics?: CursorDiagnostic[];
  isPreferred?: boolean;
  disabled?: {
    reason: string;
  };
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

export interface CursorHoverInfo {
  contents: Array<{
    language?: string;
    value: string;
  }>;
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export interface CursorCompletionItem {
  label: string;
  kind:
    | 'text'
    | 'method'
    | 'function'
    | 'constructor'
    | 'field'
    | 'variable'
    | 'class'
    | 'interface'
    | 'module'
    | 'property'
    | 'unit'
    | 'value'
    | 'enum'
    | 'keyword'
    | 'snippet'
    | 'color'
    | 'file'
    | 'reference'
    | 'folder'
    | 'enumMember'
    | 'constant'
    | 'struct'
    | 'event'
    | 'operator'
    | 'typeParameter';
  detail?: string;
  documentation?: string;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: 'plainText' | 'snippet';
  textEdit?: {
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    newText: string;
  };
  additionalTextEdits?: Array<{
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    newText: string;
  }>;
  commitCharacters?: string[];
  command?: {
    title: string;
    command: string;
    arguments?: any[];
  };
  data?: any;
}

export class CursorIntegration extends EventEmitter {
  private config: CursorIntegrationConfig;
  private devEnvironment: DevelopmentEnvironment;
  private logger: Logger;
  private isActive = false;
  private documentCache = new Map<string, string>();
  private diagnosticsCache = new Map<string, CursorDiagnostic[]>();

  constructor(devEnvironment: DevelopmentEnvironment, config: CursorIntegrationConfig) {
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
   * Initialize Cursor integration
   */
  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.info('Cursor integration is disabled');
      return;
    }

    this.logger.info('Initializing Cursor IDE integration', this.config);

    try {
      // Register with Cursor's extension API
      await this.registerWithCursor();

      // Set up real-time analysis if enabled
      if (this.config.realTimeAnalysis) {
        await this.setupRealTimeAnalysis();
      }

      // Initialize AI assistance features
      if (this.config.aiAssistance) {
        await this.initializeAIAssistance();
      }

      this.isActive = true;
      this.emit('initialized');
      this.logger.info('Cursor integration initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize Cursor integration', error);
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
  ): Promise<CursorDiagnostic[]> {
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

      // Convert to Cursor diagnostics format
      const diagnostics: CursorDiagnostic[] = errors.map(error => ({
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
        tags: error.category === 'deprecated' ? ['deprecated'] : [],
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
    context: { diagnostics: CursorDiagnostic[] }
  ): Promise<CursorCodeAction[]> {
    if (!this.config.codeActions) {
      return [];
    }

    try {
      this.logger.debug('Providing code actions', {
        uri,
        range,
        diagnostics: context.diagnostics.length,
      });

      const actions: CursorCodeAction[] = [];

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

        actions.push({
          title: 'Analyze performance',
          kind: 'source',
          command: {
            title: 'Analyze performance',
            command: 'errorDebugging.analyzePerformance',
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
  ): Promise<CursorHoverInfo | null> {
    if (!this.config.hoverProvider) {
      return null;
    }

    try {
      this.logger.debug('Providing hover information', { uri, position });

      const content = this.documentCache.get(uri);
      if (!content) {
        return null;
      }

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

        // Add AI-powered suggestions if available
        if (this.config.aiAssistance) {
          const suggestions = await this.getAISuggestions(diagnostic);
          if (suggestions.length > 0) {
            contents.push({
              value: `**AI Suggestions**:\n${suggestions.map(s => `• ${s}`).join('\n')}`,
            });
          }
        }
      }

      const hoverInfo: CursorHoverInfo = {
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
   * Provide completion items
   */
  async provideCompletions(
    uri: string,
    position: { line: number; character: number },
    context: {
      triggerKind: 'invoked' | 'triggerCharacter' | 'incomplete';
      triggerCharacter?: string;
    }
  ): Promise<CursorCompletionItem[]> {
    if (!this.config.completionProvider) {
      return [];
    }

    try {
      this.logger.debug('Providing completions', { uri, position, context });

      const content = this.documentCache.get(uri);
      if (!content) {
        return [];
      }

      const completions: CursorCompletionItem[] = [];

      // Add error-related completions
      const diagnostics = this.diagnosticsCache.get(uri) || [];
      const nearbyDiagnostics = diagnostics.filter(
        diag => Math.abs(diag.range.start.line - position.line) <= 2
      );

      for (const diagnostic of nearbyDiagnostics) {
        if (diagnostic.severity === 'error') {
          // Suggest fixes for common errors
          const fixes = await this.generateCompletionFixes(diagnostic);
          completions.push(...fixes);
        }
      }

      // Add performance-related completions
      if (this.config.performanceInsights) {
        const perfCompletions = await this.generatePerformanceCompletions(uri, position);
        completions.push(...perfCompletions);
      }

      this.emit('completionsProvided', uri, completions);
      return completions;
    } catch (error) {
      this.logger.error('Failed to provide completions', { uri, error });
      return [];
    }
  }

  /**
   * Handle document changes for real-time analysis
   */
  async onDocumentChange(uri: string, content: string, language: string): Promise<void> {
    if (!this.config.realTimeAnalysis) {
      return;
    }

    try {
      // Debounce rapid changes
      clearTimeout((this as any).changeTimeout);
      (this as any).changeTimeout = setTimeout(async () => {
        await this.provideDiagnostics(uri, content, language);
      }, 500);
    } catch (error) {
      this.logger.error('Failed to handle document change', { uri, error });
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): CursorIntegrationConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<CursorIntegrationConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.logger.info('Cursor integration configuration updated', this.config);
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
    this.logger.info('Disposing Cursor integration');

    this.isActive = false;
    this.documentCache.clear();
    this.diagnosticsCache.clear();
    this.removeAllListeners();

    this.logger.info('Cursor integration disposed');
  }

  /**
   * Register with Cursor's extension API
   */
  private async registerWithCursor(): Promise<void> {
    // This would integrate with Cursor's actual extension API
    // For now, we'll simulate the registration
    this.logger.debug('Registering with Cursor extension API');

    // In a real implementation, this would:
    // 1. Register diagnostic provider
    // 2. Register code action provider
    // 3. Register hover provider
    // 4. Register completion provider
    // 5. Set up event listeners for document changes
  }

  /**
   * Set up real-time analysis
   */
  private async setupRealTimeAnalysis(): Promise<void> {
    this.logger.debug('Setting up real-time analysis');

    // Set up document change listeners
    // In a real implementation, this would listen to Cursor's document change events
  }

  /**
   * Initialize AI assistance features
   */
  private async initializeAIAssistance(): Promise<void> {
    this.logger.debug('Initializing AI assistance features');

    // Set up AI-powered error analysis and suggestions
    // This would integrate with Cursor's AI capabilities
  }

  /**
   * Set up event handlers
   */
  private setupEventHandlers(): void {
    // Listen to development environment events
    this.devEnvironment.on('errorsDetected', (errors, language, filePath) => {
      this.emit('errorsDetected', errors, language, filePath);
    });

    this.devEnvironment.on('performanceAnalyzed', (analysis, language) => {
      this.emit('performanceAnalyzed', analysis, language);
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
    diagnostic: CursorDiagnostic
  ): Promise<CursorCodeAction[]> {
    const actions: CursorCodeAction[] = [];

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

  /**
   * Get AI-powered suggestions for diagnostics
   */
  private async getAISuggestions(diagnostic: CursorDiagnostic): Promise<string[]> {
    // This would integrate with AI services to provide intelligent suggestions
    const suggestions: string[] = [];

    // Basic pattern-based suggestions
    if (diagnostic.message.includes('unused')) {
      suggestions.push('Consider removing this unused code');
    }

    if (diagnostic.message.includes('deprecated')) {
      suggestions.push('Update to use the recommended alternative');
    }

    return suggestions;
  }

  /**
   * Generate completion fixes for diagnostics
   */
  private async generateCompletionFixes(
    diagnostic: CursorDiagnostic
  ): Promise<CursorCompletionItem[]> {
    const completions: CursorCompletionItem[] = [];

    if (diagnostic.message.includes('missing semicolon')) {
      completions.push({
        label: 'Add semicolon',
        kind: 'text',
        insertText: ';',
        detail: 'Fix missing semicolon',
      });
    }

    return completions;
  }

  /**
   * Generate performance-related completions
   */
  private async generatePerformanceCompletions(
    _uri: string,
    _position: { line: number; character: number }
  ): Promise<CursorCompletionItem[]> {
    const completions: CursorCompletionItem[] = [];

    // Add performance optimization suggestions
    completions.push({
      label: 'Performance: Use const instead of let',
      kind: 'snippet',
      insertText: 'const ${1:variableName} = ${2:value};',
      insertTextFormat: 'snippet',
      detail: 'Performance optimization',
    });

    return completions;
  }
}
