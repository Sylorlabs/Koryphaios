/**
 * Console error detector for capturing browser and Node.js console errors
 */

import type { DetectedError, ErrorSource, ErrorContext, ErrorStackFrame } from '@/types/index.js';
import {
  BaseErrorDetector,
  type ErrorDetectorOptions,
  type ErrorDetectorCapabilities,
} from './base-detector.js';

export class ConsoleErrorDetector extends BaseErrorDetector {
  private originalConsoleError: typeof console.error;
  private originalConsoleWarn: typeof console.warn;
  private capturedLogs: Array<{ level: string; args: any[]; timestamp: Date }> = [];
  private uncaughtExceptionHandler?: ((error: Error) => void) | undefined;
  private unhandledRejectionHandler?: ((reason: any) => void) | undefined;

  constructor(options: ErrorDetectorOptions) {
    super(options);
    this.originalConsoleError = console.error.bind(console);
    this.originalConsoleWarn = console.warn.bind(console);
  }

  getSource(): ErrorSource {
    return {
      type: 'console',
      tool: 'console-detector',
      version: '1.0.0',
    };
  }

  getCapabilities(): ErrorDetectorCapabilities {
    return {
      supportsRealTime: true,
      supportsPolling: false,
      supportsFileWatching: false,
      supportedLanguages: ['javascript', 'typescript'],
      supportedFrameworks: ['node', 'browser', 'react', 'vue', 'angular'],
    };
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.interceptConsole();
    this.emit('detector-started');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    this.restoreConsole();
    this.emit('detector-stopped');
  }

  async detectErrors(_target?: string): Promise<DetectedError[]> {
    // For console detector, we return buffered errors
    // Target parameter is not used for console detection
    return this.getBufferedErrors();
  }

  private interceptConsole(): void {
    // Intercept console.error
    console.error = (...args: any[]) => {
      this.captureConsoleOutput('error', args);
      this.originalConsoleError(...args);
    };

    // Intercept console.warn if warnings are enabled
    if (this.options.includeWarnings) {
      console.warn = (...args: any[]) => {
        this.captureConsoleOutput('warn', args);
        this.originalConsoleWarn(...args);
      };
    }

    // Intercept unhandled errors in Node.js
    if (typeof process !== 'undefined') {
      this.uncaughtExceptionHandler = (error: Error) => {
        this.handleUncaughtError(error);
      };
      this.unhandledRejectionHandler = (reason: any) => {
        this.handleUnhandledRejection(reason);
      };

      process.on('uncaughtException', this.uncaughtExceptionHandler);
      process.on('unhandledRejection', this.unhandledRejectionHandler);
    }

    // Intercept window errors in browser
    if (typeof globalThis !== 'undefined' && 'window' in globalThis) {
      const win = globalThis as any;
      win.window.addEventListener('error', (event: any) => {
        this.handleWindowError(event);
      });

      win.window.addEventListener('unhandledrejection', (event: any) => {
        this.handleUnhandledPromiseRejection(event);
      });
    }
  }

  private restoreConsole(): void {
    console.error = this.originalConsoleError;
    console.warn = this.originalConsoleWarn;

    // Remove process listeners to prevent memory leaks
    if (typeof process !== 'undefined') {
      if (this.uncaughtExceptionHandler) {
        process.removeListener('uncaughtException', this.uncaughtExceptionHandler);
        this.uncaughtExceptionHandler = undefined;
      }
      if (this.unhandledRejectionHandler) {
        process.removeListener('unhandledRejection', this.unhandledRejectionHandler);
        this.unhandledRejectionHandler = undefined;
      }
    }
  }

  private captureConsoleOutput(level: string, args: any[]): void {
    const timestamp = new Date();
    this.capturedLogs.push({ level, args, timestamp });

    // Convert console output to error if it looks like an error
    const shouldCreateError =
      level === 'error' ||
      (level === 'warn' && this.options.includeWarnings) ||
      this.looksLikeError(args);

    if (shouldCreateError) {
      const error = this.createErrorFromConsoleOutput(level, args, timestamp);
      if (error) {
        this.addToBuffer(error);
      }
    }
  }

  private looksLikeError(args: any[]): boolean {
    const text = args.join(' ').toLowerCase();
    return (
      text.includes('error') ||
      text.includes('exception') ||
      text.includes('failed') ||
      text.includes('cannot') ||
      text.includes('undefined') ||
      text.includes('null')
    );
  }

  private createErrorFromConsoleOutput(
    level: string,
    args: any[],
    timestamp: Date
  ): DetectedError | null {
    try {
      const message = args
        .map(arg => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg)))
        .join(' ');

      if (!message.trim()) {
        return null;
      }

      // Filter out routine internal warnings from the MCP server itself
      const internalWarnings = [
        'TypeScript not available, build detector will run in limited mode',
        'Static analysis timeout',
        'File watching disabled',
        'Initial build check failed',
        'TypeScript verification timed out',
      ];
      if (level === 'warn' && internalWarnings.some(w => message.includes(w))) {
        return null;
      }

      const stackTrace = this.extractStackTrace(args);
      const baseError = this.createBaseError(message, `console.${level}`, stackTrace);

      const context: ErrorContext = {
        timestamp,
        environment:
          typeof globalThis !== 'undefined' && 'window' in globalThis ? 'browser' : 'node',
        metadata: {
          consoleLevel: level,
          originalArgs: args.length,
        },
      };

      return {
        id: this.generateErrorId(),
        ...baseError,
        context,
        source: this.getSource(),
      };
    } catch (error) {
      // Don't create errors for error creation failures
      return null;
    }
  }

  private extractStackTrace(args: any[]): ErrorStackFrame[] {
    const stackFrames: ErrorStackFrame[] = [];

    for (const arg of args) {
      if (arg instanceof Error && arg.stack) {
        const frames = this.parseStackTrace(arg.stack);
        stackFrames.push(...frames);
        break;
      }
    }

    // If no stack trace found, try to get current stack
    if (stackFrames.length === 0) {
      const error = new Error();
      if (error.stack) {
        const frames = this.parseStackTrace(error.stack);
        // Remove the first few frames that are from this detector
        stackFrames.push(...frames.slice(3));
      }
    }

    return stackFrames;
  }

  private parseStackTrace(stack: string): ErrorStackFrame[] {
    const frames: ErrorStackFrame[] = [];
    const lines = stack.split('\n');

    for (const line of lines) {
      const frame = this.parseStackFrame(line);
      if (frame) {
        frames.push(frame);
      }
    }

    return frames;
  }

  private parseStackFrame(line: string): ErrorStackFrame | null {
    // Parse different stack trace formats

    // Node.js format: "    at functionName (file:line:column)"
    const nodeMatch = line.match(/^\s*at\s+(.+?)\s+\((.+):(\d+):(\d+)\)$/);
    if (nodeMatch) {
      return {
        location: {
          file: nodeMatch[2] || 'unknown',
          line: parseInt(nodeMatch[3] || '0', 10),
          column: parseInt(nodeMatch[4] || '0', 10),
          function: nodeMatch[1] || undefined,
        },
        source: line.trim(),
      };
    }

    // Browser format: "    at file:line:column"
    const browserMatch = line.match(/^\s*at\s+(.+):(\d+):(\d+)$/);
    if (browserMatch) {
      return {
        location: {
          file: browserMatch[1] || 'unknown',
          line: parseInt(browserMatch[2] || '0', 10),
          column: parseInt(browserMatch[3] || '0', 10),
          function: undefined,
        },
        source: line.trim(),
      };
    }

    // Generic format: "file:line:column"
    const genericMatch = line.match(/(.+):(\d+):(\d+)/);
    if (genericMatch) {
      return {
        location: {
          file: genericMatch[1] || 'unknown',
          line: parseInt(genericMatch[2] || '0', 10),
          column: parseInt(genericMatch[3] || '0', 10),
          function: undefined,
        },
        source: line.trim(),
      };
    }

    return null;
  }

  private handleUncaughtError(error: Error): void {
    const stackTrace = error.stack ? this.parseStackTrace(error.stack) : [];
    const baseError = this.createBaseError(error.message, error.name, stackTrace);

    const context: ErrorContext = {
      timestamp: new Date(),
      environment: 'node',
      metadata: {
        uncaught: true,
        errorName: error.name,
      },
    };

    const detectedError: DetectedError = {
      id: this.generateErrorId(),
      ...baseError,
      context,
      source: this.getSource(),
    };

    this.addToBuffer(detectedError);
  }

  private handleUnhandledRejection(reason: any): void {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stackTrace =
      reason instanceof Error && reason.stack ? this.parseStackTrace(reason.stack) : [];

    const baseError = this.createBaseError(
      `Unhandled Promise Rejection: ${message}`,
      'UnhandledPromiseRejection',
      stackTrace
    );

    const context: ErrorContext = {
      timestamp: new Date(),
      environment: 'node',
      metadata: {
        unhandledRejection: true,
        reasonType: typeof reason,
      },
    };

    const detectedError: DetectedError = {
      id: this.generateErrorId(),
      ...baseError,
      context,
      source: this.getSource(),
    };

    this.addToBuffer(detectedError);
  }

  private handleWindowError(event: any): void {
    const stackTrace =
      event.error && event.error.stack ? this.parseStackTrace(event.error.stack) : [];

    const baseError = this.createBaseError(event.message, event.error?.name || 'Error', stackTrace);

    const context: ErrorContext = {
      timestamp: new Date(),
      environment: 'browser',
      metadata: {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      },
    };

    const detectedError: DetectedError = {
      id: this.generateErrorId(),
      ...baseError,
      context,
      source: this.getSource(),
    };

    this.addToBuffer(detectedError);
  }

  private handleUnhandledPromiseRejection(event: any): void {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    const stackTrace =
      reason instanceof Error && reason.stack ? this.parseStackTrace(reason.stack) : [];

    const baseError = this.createBaseError(
      `Unhandled Promise Rejection: ${message}`,
      'UnhandledPromiseRejection',
      stackTrace
    );

    const context: ErrorContext = {
      timestamp: new Date(),
      environment: 'browser',
      metadata: {
        unhandledRejection: true,
        reasonType: typeof reason,
      },
    };

    const detectedError: DetectedError = {
      id: this.generateErrorId(),
      ...baseError,
      context,
      source: this.getSource(),
    };

    this.addToBuffer(detectedError);
  }

  getCapturedLogs(): Array<{ level: string; args: any[]; timestamp: Date }> {
    return [...this.capturedLogs];
  }

  clearCapturedLogs(): void {
    this.capturedLogs = [];
  }
}

// Alias for backward compatibility
export { ConsoleErrorDetector as ConsoleDetector };
