/**
 * Tool registry for managing MCP tools
 */

import type { MCPTool, MCPToolResult } from '@/types/index.js';
import type { ErrorDetectorManager } from '@/detectors/error-detector-manager.js';
import type { LanguageHandlerManager } from '@/languages/language-handler-manager.js';
import type { PlaywrightManager } from './playwright-manager.js';
import { SupportedLanguage } from '@/types/languages.js';
import { Logger } from '@/utils/logger.js';

export type ToolHandler = (args: Record<string, unknown>) => Promise<MCPToolResult>;

export class ToolRegistry {
  private tools: Map<string, MCPTool> = new Map();
  private handlers: Map<string, ToolHandler> = new Map();
  private errorDetectorManager: ErrorDetectorManager | null = null;
  private languageHandlerManager: LanguageHandlerManager | null = null;
  private playwrightManager: PlaywrightManager | null = null;
  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger =
      logger ||
      new Logger('info', {
        logFile: undefined,
        enableConsole: false, // Default to disabled to avoid MCP protocol interference
      });
  }

  setPlaywrightManager(manager: PlaywrightManager): void {
    this.playwrightManager = manager;
  }

  async registerTool(tool: MCPTool, handler?: ToolHandler): Promise<void> {
    this.logger.debug(`Registering tool: ${tool.name}`, {
      toolName: tool.name,
      description: tool.description,
      hasCustomHandler: !!handler,
      inputSchema: tool.inputSchema,
    });

    if (this.tools.has(tool.name)) {
      const error = new Error(`Tool ${tool.name} is already registered`);
      this.logger.error('Tool registration failed - already exists', {
        toolName: tool.name,
        error: error.message,
      });
      throw error;
    }

    this.tools.set(tool.name, tool);

    if (handler) {
      this.handlers.set(tool.name, handler);
      this.logger.debug(`Registered custom handler for tool: ${tool.name}`);
    } else {
      // Register default handler based on tool name
      this.handlers.set(tool.name, this.createDefaultHandler(tool.name));
      this.logger.debug(`Registered default handler for tool: ${tool.name}`);
    }

    this.logger.info(`Tool registered successfully: ${tool.name}`, {
      totalTools: this.tools.size,
      toolName: tool.name,
    });
  }

  async unregisterTool(name: string): Promise<void> {
    this.tools.delete(name);
    this.handlers.delete(name);
  }

  listTools(): MCPTool[] {
    return Array.from(this.tools.values());
  }

  getTool(name: string): MCPTool | undefined {
    return this.tools.get(name);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    const startTime = Date.now();
    this.logger.debug(`Calling tool: ${name}`, {
      toolName: name,
      args: Object.keys(args),
      argsCount: Object.keys(args).length,
    });

    const handler = this.handlers.get(name);
    if (!handler) {
      const error = new Error(`No handler registered for tool: ${name}`);
      this.logger.error('Tool call failed - no handler', {
        toolName: name,
        availableTools: Array.from(this.handlers.keys()),
        error: error.message,
      });
      throw error;
    }

    try {
      const result = await handler(args);
      const executionTime = Date.now() - startTime;

      this.logger.logPerformance(`tool-${name}-execution`, executionTime);
      this.logger.debug(`Tool executed successfully: ${name}`, {
        toolName: name,
        executionTime,
        hasResult: !!result,
        resultType: result?.content?.[0]?.type,
      });

      return result;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const message = error instanceof Error ? error.message : 'Unknown error';

      this.logger.error(`Tool execution failed: ${name}`, {
        toolName: name,
        executionTime,
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
            : error,
        args: Object.keys(args),
      });

      return {
        content: [
          {
            type: 'text',
            text: `Error executing tool ${name}: ${message}`,
          },
        ],
        isError: true,
      };
    }
  }

  private createDefaultHandler(toolName: string): ToolHandler {
    return async (args: Record<string, unknown>): Promise<MCPToolResult> => {
      switch (toolName) {
        case 'detect-errors':
          return this.handleDetectErrors(args);

        case 'analyze-error':
          return this.handleAnalyzeError(args);

        case 'suggest-fixes':
          return this.handleSuggestFixes(args);

        case 'set-breakpoint':
          return this.handleSetBreakpoint(args);

        case 'inspect-variables':
          return this.handleInspectVariables(args);

        case 'profile-performance':
          return this.handleProfilePerformance(args);

        case 'track-memory':
          return this.handleTrackMemory(args);

        // Playwright Tools
        case 'navigate':
          return this.handleNavigate(args);

        case 'screenshot':
          return this.handleScreenshot(args);

        case 'click':
          return this.handleClick(args);

        case 'fill':
          return this.handleFill(args);

        case 'evaluate':
          return this.handleEvaluate(args);

        case 'get_logs':
          return this.handleGetLogs(args);

        case 'clear_logs':
          return this.handleClearLogs(args);

        default:
          throw new Error(`No default handler available for tool: ${toolName}`);
      }
    };
  }

  private async handleDetectErrors(args: Record<string, unknown>): Promise<MCPToolResult> {
    const source = args['source'] as string;
    const language = args['language'] as string;
    const files = (args['files'] as string[]) || [];
    const projectRoot = args['projectRoot'] as string;
    const includeWarnings = (args['includeWarnings'] as boolean) || false;
    const realTime = (args['realTime'] as boolean) || false;

    try {
      // If a specific language is requested and we have files, use language handler manager
      if (language && files.length > 0 && this.languageHandlerManager) {
        return await this.handleLanguageSpecificDetection(
          language,
          files,
          includeWarnings,
          source,
          projectRoot
        );
      }

      // Otherwise, use the error detector manager for general detection
      if (!this.errorDetectorManager) {
        throw new Error('Error detector manager not initialized');
      }

      const detectionOptions: {
        source?: string;
        target?: string;
        includeBuffered?: boolean;
        projectRoot?: string;
      } = {
        includeBuffered: args['includeBuffered'] !== false,
      };

      if (source !== 'all') {
        detectionOptions.source = source;
      }

      if (files.length > 0) {
        detectionOptions.target = files.join(',');
      }

      if (projectRoot) {
        detectionOptions.projectRoot = projectRoot;
      }

      const errors = await this.errorDetectorManager.detectErrors(detectionOptions);

      // Debug: log error sources
      this.logger.debug('detect-errors result', {
        count: errors.length,
        sources: errors.map(e => e.source?.type),
        projectRoot: projectRoot || 'default',
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                source,
                language,
                files,
                includeWarnings,
                realTime,
                errors: errors.map(error => ({
                  id: error.id,
                  message: error.message,
                  type: error.type,
                  category: error.category,
                  severity: error.severity,
                  file: error.stackTrace[0]?.location.file || 'unknown',
                  line: error.stackTrace[0]?.location.line || 0,
                  column: error.stackTrace[0]?.location.column || 0,
                  timestamp: error.context.timestamp,
                  source: error.source,
                })),
                stats: this.errorDetectorManager.getDetectionStats(),
                timestamp: new Date().toISOString(),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error detecting errors: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleLanguageSpecificDetection(
    language: string,
    files: string[],
    includeWarnings: boolean,
    source: string,
    _projectRoot?: string
  ): Promise<MCPToolResult> {
    if (!this.languageHandlerManager) {
      throw new Error('Language handler manager not initialized');
    }

    const fs = await import('fs/promises');
    const path = await import('path');
    const allErrors: any[] = [];

    // Convert language string to SupportedLanguage enum
    const supportedLanguage = language as SupportedLanguage;

    for (const filePath of files) {
      try {
        // Read file content
        const fullPath = path.resolve(filePath);
        const fileContent = await fs.readFile(fullPath, 'utf-8');

        // Detect errors using language handler
        const languageErrors = await this.languageHandlerManager.detectErrors(
          fileContent,
          supportedLanguage,
          {
            filePath: fullPath,
            enableLinting: true,
            includeWarnings,
          }
        );

        // Convert language errors to the expected format
        for (const langError of languageErrors) {
          allErrors.push({
            id: `error-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            message: langError.message,
            type: `${language}Error`,
            category: 'syntax',
            severity: langError.severity === 'error' ? 'high' : 'low',
            file: langError.location.file,
            line: langError.location.line,
            column: langError.location.column,
            timestamp: new Date().toISOString(),
            source: {
              type: source,
              tool: `${language}-handler`,
              version: '1.0.0',
              configuration: {
                detector: source,
              },
            },
          });
        }
      } catch (error) {
        this.logger.error(`Failed to process file ${filePath}`, error);
        // Add file processing error
        allErrors.push({
          id: `error-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          message: `Failed to process file: ${error instanceof Error ? error.message : 'Unknown error'}`,
          type: 'FileProcessingError',
          category: 'system',
          severity: 'high',
          file: filePath,
          line: 0,
          column: 0,
          timestamp: new Date().toISOString(),
          source: {
            type: source,
            tool: `${language}-handler`,
            version: '1.0.0',
            configuration: {
              detector: source,
            },
          },
        });
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              source,
              language,
              files,
              includeWarnings,
              realTime: false,
              errors: allErrors,
              stats: {
                totalErrors: allErrors.length,
                errorsByDetector: {
                  [source]: allErrors.length,
                },
                errorsByCategory: allErrors.reduce(
                  (acc, error) => {
                    acc[error.category] = (acc[error.category] || 0) + 1;
                    return acc;
                  },
                  {} as Record<string, number>
                ),
                errorsBySeverity: allErrors.reduce(
                  (acc, error) => {
                    acc[error.severity] = (acc[error.severity] || 0) + 1;
                    return acc;
                  },
                  {} as Record<string, number>
                ),
              },
              timestamp: new Date().toISOString(),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleAnalyzeError(args: Record<string, unknown>): Promise<MCPToolResult> {
    const errorId = args['errorId'] as string;
    
    if (!this.errorDetectorManager) {
      throw new Error('Error detector manager not initialized');
    }

    const analysis = await this.errorDetectorManager.analyzeError(errorId);
    
    if (!analysis) {
      return {
        content: [
          {
            type: 'text',
            text: `Error with ID ${errorId} not found.`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(analysis, null, 2),
        },
      ],
    };
  }

  private async handleSuggestFixes(args: Record<string, unknown>): Promise<MCPToolResult> {
    const errorId = args['errorId'] as string;
    
    if (!this.errorDetectorManager) {
      throw new Error('Error detector manager not initialized');
    }

    const suggestions = await this.errorDetectorManager.suggestFixes(errorId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(suggestions, null, 2),
        },
      ],
    };
  }

  private async handleSetBreakpoint(args: Record<string, unknown>): Promise<MCPToolResult> {
    const file = args['file'] as string;
    const line = args['line'] as number;
    const condition = args['condition'] as string;
    const logMessage = args['logMessage'] as string;
    const temporary = (args['temporary'] as boolean) || false;

    // TODO: Implement actual breakpoint setting logic
    const breakpointId = `bp-${Date.now()}`;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              breakpointId,
              file,
              line,
              condition,
              logMessage,
              temporary,
              status: 'set',
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleInspectVariables(args: Record<string, unknown>): Promise<MCPToolResult> {
    const sessionId = args['sessionId'] as string;
    const scope = (args['scope'] as string) || 'local';
    const frameId = (args['frameId'] as number) || 0;

    // TODO: Implement actual variable inspection logic
    const mockVariables = [
      { name: 'data', value: 'undefined', type: 'undefined' },
      { name: 'result', value: 'null', type: 'object' },
      { name: 'index', value: '0', type: 'number' },
    ];

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              sessionId,
              scope,
              frameId,
              variables: mockVariables,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleProfilePerformance(args: Record<string, unknown>): Promise<MCPToolResult> {
    const duration = (args['duration'] as number) || 10000;
    const sampleRate = (args['sampleRate'] as number) || 100;
    const includeMemory = (args['includeMemory'] as boolean) || true;
    const includeCpu = (args['includeCpu'] as boolean) || true;

    // TODO: Implement actual performance profiling logic
    const profileId = `profile-${Date.now()}`;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              profileId,
              duration,
              sampleRate,
              includeMemory,
              includeCpu,
              status: 'started',
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleTrackMemory(args: Record<string, unknown>): Promise<MCPToolResult> {
    const duration = (args['duration'] as number) || 60000;
    const threshold = (args['threshold'] as number) || 100 * 1024 * 1024; // 100MB
    const detectLeaks = (args['detectLeaks'] as boolean) || true;

    // TODO: Implement actual memory tracking logic
    const trackingId = `memory-${Date.now()}`;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              trackingId,
              duration,
              threshold,
              detectLeaks,
              status: 'started',
            },
            null,
            2
          ),
        },
      ],
    };
  }

  // --- Playwright Handlers ---

  private async handleNavigate(args: Record<string, unknown>): Promise<MCPToolResult> {
    if (!this.playwrightManager) throw new Error('Playwright manager not initialized');
    const url = args['url'] as string;
    const sessionId = (args['sessionId'] as string) || 'default';
    await this.playwrightManager.navigate(sessionId, url);
    return {
      content: [{ type: 'text', text: `Navigated to ${url}` }],
    };
  }

  private async handleScreenshot(args: Record<string, unknown>): Promise<MCPToolResult> {
    if (!this.playwrightManager) throw new Error('Playwright manager not initialized');
    const sessionId = (args['sessionId'] as string) || 'default';
    const buffer = await this.playwrightManager.screenshot(sessionId);
    return {
      content: [
        {
          type: 'image',
          data: buffer.toString('base64'),
          mimeType: 'image/png',
        } as any, // Cast to any because it's slightly different from MCP schema in some versions
      ],
    };
  }

  private async handleClick(args: Record<string, unknown>): Promise<MCPToolResult> {
    if (!this.playwrightManager) throw new Error('Playwright manager not initialized');
    const selector = args['selector'] as string;
    const sessionId = (args['sessionId'] as string) || 'default';
    await this.playwrightManager.click(sessionId, selector);
    return {
      content: [{ type: 'text', text: `Clicked ${selector}` }],
    };
  }

  private async handleFill(args: Record<string, unknown>): Promise<MCPToolResult> {
    if (!this.playwrightManager) throw new Error('Playwright manager not initialized');
    const selector = args['selector'] as string;
    const value = args['value'] as string;
    const sessionId = (args['sessionId'] as string) || 'default';
    await this.playwrightManager.fill(sessionId, selector, value);
    return {
      content: [{ type: 'text', text: `Filled ${selector} with ${value}` }],
    };
  }

  private async handleEvaluate(args: Record<string, unknown>): Promise<MCPToolResult> {
    if (!this.playwrightManager) throw new Error('Playwright manager not initialized');
    const script = args['script'] as string;
    const sessionId = (args['sessionId'] as string) || 'default';
    const result = await this.playwrightManager.evaluate(sessionId, script);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }

  private async handleGetLogs(args: Record<string, unknown>): Promise<MCPToolResult> {
    if (!this.playwrightManager) throw new Error('Playwright manager not initialized');
    const sessionId = (args['sessionId'] as string) || 'default';
    const logs = this.playwrightManager.getLogs(sessionId);
    return {
      content: [{ type: 'text', text: logs.join('\n') || 'No logs captured yet.' }],
    };
  }

  private async handleClearLogs(args: Record<string, unknown>): Promise<MCPToolResult> {
    if (!this.playwrightManager) throw new Error('Playwright manager not initialized');
    const sessionId = (args['sessionId'] as string) || 'default';
    this.playwrightManager.clearLogs(sessionId);
    return {
      content: [{ type: 'text', text: 'Logs cleared.' }],
    };
  }

  setErrorDetectorManager(manager: ErrorDetectorManager): void {
    this.errorDetectorManager = manager;
  }

  setLanguageHandlerManager(manager: LanguageHandlerManager): void {
    this.languageHandlerManager = manager;
  }
}
