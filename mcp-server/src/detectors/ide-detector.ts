/**
 * IDE integration detector for capturing errors from IDE diagnostic APIs
 */

import type { DetectedError, ErrorSource, ErrorContext, ErrorStackFrame } from '@/types/index.js';
import {
  BaseErrorDetector,
  type ErrorDetectorOptions,
  type ErrorDetectorCapabilities,
} from './base-detector.js';

interface IDEDiagnostic {
  file: string;
  line: number;
  column: number;
  code: string | number;
  message: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  source: string;
}

interface IDEConfig {
  enableVSCodeIntegration: boolean;
  enableLanguageServerIntegration: boolean;
  pollInterval: number;
  watchWorkspace: boolean;
}

export class IDEErrorDetector extends BaseErrorDetector {
  private _config: IDEConfig;
  private pollingTimer?: NodeJS.Timeout | undefined;
  private diagnosticsCache = new Map<string, IDEDiagnostic[]>();

  constructor(options: ErrorDetectorOptions, config?: Partial<IDEConfig>) {
    super(options);

    this._config = {
      enableVSCodeIntegration: true,
      enableLanguageServerIntegration: true,
      pollInterval: 2000,
      watchWorkspace: true,
      ...config,
    };
  }

  private get config(): IDEConfig {
    return this._config;
  }

  getSource(): ErrorSource {
    return {
      type: 'ide',
      tool: 'ide-detector',
      version: '1.0.0',
    };
  }

  getCapabilities(): ErrorDetectorCapabilities {
    return {
      supportsRealTime: true,
      supportsPolling: true,
      supportsFileWatching: false, // IDE handles file watching
      supportedLanguages: ['javascript', 'typescript', 'python', 'go', 'rust', 'java', 'c', 'cpp'],
      supportedFrameworks: ['vscode', 'language-server-protocol'],
    };
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    try {
      // Check if we're running in VS Code environment
      if (this.config.enableVSCodeIntegration && this.isVSCodeEnvironment()) {
        await this.initializeVSCodeIntegration();
      }

      // Start polling for diagnostics
      if (this.options.polling) {
        this.startPolling();
      }

      // Run initial diagnostic check
      await this.collectDiagnostics();

      this.emit('detector-started');
    } catch (error) {
      this.isRunning = false;
      this.emit('detector-error', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    // Stop polling
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }

    // Clear diagnostics cache
    this.diagnosticsCache.clear();

    this.emit('detector-stopped');
  }

  async detectErrors(target?: string): Promise<DetectedError[]> {
    if (!this.isRunning) {
      await this.start();
    }

    // If target is specified, get diagnostics for specific file
    if (target) {
      return await this.getDiagnosticsForFile(target);
    }

    // Otherwise collect all diagnostics
    await this.collectDiagnostics();
    return this.getBufferedErrors();
  }

  private isVSCodeEnvironment(): boolean {
    // Check if we're running in VS Code extension context
    return (
      (typeof globalThis !== 'undefined' && 'vscode' in globalThis) ||
      process.env['VSCODE_PID'] !== undefined ||
      process.env['TERM_PROGRAM'] === 'vscode'
    );
  }

  private async initializeVSCodeIntegration(): Promise<void> {
    try {
      // This would be implemented when running as a VS Code extension
      // For now, we'll simulate IDE integration by checking common diagnostic sources
      // In a real VS Code extension, you would:
      // 1. Register with vscode.languages.onDidChangeDiagnostics
      // 2. Access vscode.languages.getDiagnostics()
      // 3. Listen for workspace changes
      // IDE integration initialized (simulation mode)
    } catch (error) {
      throw new Error(`Failed to initialize VS Code integration: ${error}`);
    }
  }

  private startPolling(): void {
    if (this.options.polling?.interval) {
      this.pollingTimer = setInterval(() => {
        this.collectDiagnostics().catch(error => {
          this.emit('detector-error', error);
        });
      }, this.options.polling.interval);
    }
  }

  private async collectDiagnostics(): Promise<void> {
    try {
      // In a real implementation, this would:
      // 1. Query VS Code's diagnostic collection
      // 2. Query Language Server Protocol diagnostics
      // 3. Query other IDE diagnostic sources

      const diagnostics = await this.simulateIDEDiagnostics();

      // Clear previous diagnostics and add new ones
      this.clearBuffer();

      for (const diagnostic of diagnostics) {
        const detectedError = this.convertIDEDiagnosticToDetectedError(diagnostic);
        this.addToBuffer(detectedError);
      }

      // Update timestamp for debugging purposes
      // this.lastUpdateTime = Date.now();
    } catch (error) {
      this.emit('detector-error', error);
    }
  }

  private async simulateIDEDiagnostics(): Promise<IDEDiagnostic[]> {
    // This is a simulation - in real implementation, this would query actual IDE APIs
    const diagnostics: IDEDiagnostic[] = [];

    // Simulate some common TypeScript/JavaScript diagnostics
    // In reality, these would come from the IDE's diagnostic collection

    return diagnostics;
  }

  private convertIDEDiagnosticToDetectedError(diagnostic: IDEDiagnostic): DetectedError {
    const stackTrace: ErrorStackFrame[] = [
      {
        location: {
          file: diagnostic.file,
          line: diagnostic.line,
          column: diagnostic.column,
          function: undefined,
        },
        source: `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}`,
      },
    ];

    const baseError = this.createBaseError(
      `${diagnostic.code}: ${diagnostic.message}`,
      'IDEDiagnostic',
      stackTrace
    );

    const context: ErrorContext = {
      timestamp: new Date(),
      environment: 'ide',
      metadata: {
        tool: 'ide',
        source: diagnostic.source,
        code: diagnostic.code.toString(),
        severity: diagnostic.severity,
        file: diagnostic.file,
        line: diagnostic.line,
        column: diagnostic.column,
      },
    };

    return {
      id: this.generateErrorId(),
      ...baseError,
      context,
      source: this.getSource(),
    };
  }

  private async getDiagnosticsForFile(filePath: string): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];

    try {
      // Get cached diagnostics for the specific file
      const fileDiagnostics = this.diagnosticsCache.get(filePath) || [];

      for (const diagnostic of fileDiagnostics) {
        errors.push(this.convertIDEDiagnosticToDetectedError(diagnostic));
      }
    } catch (error) {
      this.emit('detector-error', error);
    }

    return errors;
  }

  // Method to be called by IDE extension or external integration
  public updateDiagnostics(filePath: string, diagnostics: IDEDiagnostic[]): void {
    this.diagnosticsCache.set(filePath, diagnostics);

    // Convert and add to buffer
    for (const diagnostic of diagnostics) {
      const detectedError = this.convertIDEDiagnosticToDetectedError(diagnostic);
      this.addToBuffer(detectedError);
    }

    // Emit event for real-time updates
    this.emit('diagnostics-updated', { filePath, diagnostics });
  }

  // Method to clear diagnostics for a file
  public clearDiagnosticsForFile(filePath: string): void {
    this.diagnosticsCache.delete(filePath);
  }

  // Get current diagnostics cache (for debugging/monitoring)
  public getDiagnosticsCache(): Map<string, IDEDiagnostic[]> {
    return new Map(this.diagnosticsCache);
  }
}

// Alias for backward compatibility
export { IDEErrorDetector as IDEDetector };
