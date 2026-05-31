/**
 * Core MCP Server implementation
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type { ServerConfig } from '@/types/index.js';
import { EventEmitter } from './event-emitter.js';
import { PluginManager } from './plugin-manager.js';
import { ResourceManager } from './resource-manager.js';
import { ToolRegistry } from './tool-registry.js';
import { PromptRegistry } from './prompt-registry.js';
import { PlaywrightManager } from './playwright-manager.js';
import { ErrorDetectorManager } from '@/detectors/error-detector-manager.js';
import { LanguageHandlerManager } from '@/languages/language-handler-manager.js';
import { Logger } from '@/utils/logger.js';

export class KoryphaiosMCPServer extends EventEmitter {
  private server: Server;
  private pluginManager: PluginManager;
  private resourceManager: ResourceManager;
  private toolRegistry: ToolRegistry;
  private promptRegistry: PromptRegistry;
  private playwrightManager: PlaywrightManager;
  private errorDetectorManager: ErrorDetectorManager;
  private languageHandlerManager: LanguageHandlerManager;
  private config: ServerConfig;
  private _isRunning = false;
  private logger: Logger;

  constructor(config: ServerConfig, logger?: Logger) {
    super();
    this.config = config;
    this.logger = logger || new Logger('info', { logFile: undefined });
    this.server = new Server(
      {
        name: config.server.name,
        version: config.server.version,
      },
      {
        capabilities: this.getServerCapabilities(),
      }
    );

    this.pluginManager = new PluginManager();
    this.resourceManager = new ResourceManager();
    this.toolRegistry = new ToolRegistry(this.logger);
    this.promptRegistry = new PromptRegistry();
    this.playwrightManager = new PlaywrightManager(this.logger);
    this.errorDetectorManager = new ErrorDetectorManager({
      config: config.detection,
      logger: this.logger,
    });
    this.languageHandlerManager = new LanguageHandlerManager({
      autoDetectLanguages: true,
      logger: this.logger,
    });

    this.setupHandlers();
  }

  private getServerCapabilities() {
    return {
      logging: {},
      prompts: {
        listChanged: true,
      },
      resources: {
        subscribe: true,
        listChanged: true,
      },
      tools: {
        listChanged: true,
      },
    };
  }

  private setupHandlers(): void {
    // Tool handlers
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: this.toolRegistry.listTools(),
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async request => {
      const { name, arguments: args } = request.params;

      try {
        const result = await this.toolRegistry.callTool(name, args || {});
        return {
          content: result.content,
          isError: result.isError,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${message}`);
      }
    });

    // Resource handlers
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return {
        resources: this.resourceManager.listResources(),
      };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async request => {
      const { uri } = request.params;

      try {
        const content = await this.resourceManager.readResource(uri);
        return {
          contents: [content],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InvalidRequest, `Resource not found: ${message}`);
      }
    });

    // Prompt handlers
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      return {
        prompts: this.promptRegistry.listPrompts(),
      };
    });

    this.server.setRequestHandler(GetPromptRequestSchema, async request => {
      const { name, arguments: args } = request.params;

      try {
        const prompt = await this.promptRegistry.executePrompt(name, args);
        return {
          messages: prompt.messages,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InvalidRequest, `Prompt not found: ${message}`);
      }
    });

    // Error handling
    this.server.onerror = error => {
      this.emit('server:error', error instanceof Error ? error : new Error(String(error)));
    };
  }

  async start(): Promise<void> {
    if (this._isRunning) {
      throw new Error('Server is already running');
    }

    const startTime = Date.now();
    this.logger.info('Starting Error Debugging MCP Server...', {
      version: this.config.server.version,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      memoryUsage: process.memoryUsage(),
    });

    try {
      // Initialize plugins
      this.logger.debug('Initializing plugin manager...');
      const pluginStartTime = Date.now();
      await this.pluginManager.initialize();
      this.logger.logPerformance('plugin-manager-init', Date.now() - pluginStartTime);

      // Initialize language handler manager
      this.logger.debug('Initializing language handler manager...');
      const languageHandlerStartTime = Date.now();
      await this.languageHandlerManager.initialize();
      this.logger.logPerformance(
        'language-handler-manager-start',
        Date.now() - languageHandlerStartTime
      );

      // Initialize error detection
      this.logger.debug('Initializing error detector manager...');
      const errorDetectorStartTime = Date.now();
      await this.errorDetectorManager.start();
      this.logger.logPerformance(
        'error-detector-manager-start',
        Date.now() - errorDetectorStartTime
      );

      // Connect managers to tool registry
      this.logger.debug('Connecting managers to tool registry...');
      this.toolRegistry.setPlaywrightManager(this.playwrightManager);
      this.toolRegistry.setErrorDetectorManager(this.errorDetectorManager);
      this.toolRegistry.setLanguageHandlerManager(this.languageHandlerManager);

      // Register core tools and resources
      this.logger.debug('Registering core components...');
      const coreComponentsStartTime = Date.now();
      await this.registerCoreComponents();
      this.logger.logPerformance(
        'core-components-registration',
        Date.now() - coreComponentsStartTime
      );

      // Start the server with configured transport
      const transportType = this.config.transport?.type || 'stdio';
      this.logger.debug(`Starting MCP server with ${transportType} transport...`);
      const transportStartTime = Date.now();

      let transport: any;
      let transportInfo: any;

      switch (transportType) {
        case 'stdio':
          transport = new StdioServerTransport();
          transportInfo = {
            transport: 'stdio',
            transportType: 'stdin/stdout',
            description: 'Standard input/output communication',
          };
          break;
        case 'http':
        case 'sse':
          // For future implementation - currently only stdio is supported
          throw new Error(
            `Transport type '${transportType}' is not yet implemented. Only 'stdio' transport is currently supported.`
          );
        default:
          throw new Error(`Unknown transport type: ${transportType}`);
      }

      await this.server.connect(transport);
      this.logger.logPerformance('transport-connection', Date.now() - transportStartTime);

      this._isRunning = true;
      const totalStartupTime = Date.now() - startTime;

      this.logger.info('Server started successfully', {
        totalStartupTime,
        ...transportInfo,
        components: [
          'plugin-manager',
          'language-handler-manager',
          'error-detector-manager',
          'tool-registry',
          'core-components',
          'transport',
        ],
        memoryUsage: process.memoryUsage(),
      });

      this.emit('server:started', transportInfo);
    } catch (error) {
      this.logger.error('Failed to start server', {
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
            : error,
        startupTime: Date.now() - startTime,
      });
      // Ensure we shutdown playwright if start fails half-way
      await this.playwrightManager.shutdown().catch(() => {});
      this.emit('server:error', error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this._isRunning) {
      return;
    }

    try {
      await this.server.close();
      await this.playwrightManager.shutdown();
      await this.errorDetectorManager.stop();
      await this.languageHandlerManager.dispose();
      await this.pluginManager.shutdown();

      this._isRunning = false;
      this.emit('server:stopped');
    } catch (error) {
      this.emit('server:error', error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private async registerCoreComponents(): Promise<void> {
    // Register core tools
    await this.toolRegistry.registerTool({
      name: 'detect-errors',
      description: 'Detect errors from various sources (console, runtime, build, test)',
      inputSchema: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            enum: ['console', 'runtime', 'build', 'test', 'all'],
            description: 'Source to detect errors from',
          },
          language: {
            type: 'string',
            description: 'Programming language to focus on',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Specific files to analyze',
          },
          projectRoot: {
            type: 'string',
            description:
              'Project root directory to analyze (defaults to current working directory)',
          },
          includeWarnings: {
            type: 'boolean',
            description: 'Include warnings in addition to errors',
          },
          realTime: {
            type: 'boolean',
            description: 'Enable real-time error monitoring',
          },
        },
      },
    });

    await this.toolRegistry.registerTool({
      name: 'analyze-error',
      description: 'Perform deep analysis of a specific error',
      inputSchema: {
        type: 'object',
        properties: {
          errorId: {
            type: 'string',
            description: 'ID of the error to analyze',
          },
          includeContext: {
            type: 'boolean',
            description: 'Include code context in analysis',
          },
          includeSuggestions: {
            type: 'boolean',
            description: 'Include fix suggestions',
          },
          includeHistory: {
            type: 'boolean',
            description: 'Include historical error data',
          },
        },
        required: ['errorId'],
      },
    });

    // Register Playwright Tools
    await this.toolRegistry.registerTool({
      name: 'navigate',
      description: 'Navigate to a URL in the browser',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to' },
          sessionId: { type: 'string', description: 'Session ID for persistent context' },
        },
        required: ['url'],
      },
    });

    await this.toolRegistry.registerTool({
      name: 'screenshot',
      description: 'Take a screenshot of the current page',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session ID' },
        },
      },
    });

    await this.toolRegistry.registerTool({
      name: 'click',
      description: 'Click an element on the page',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector or XPath' },
          sessionId: { type: 'string', description: 'Session ID' },
        },
        required: ['selector'],
      },
    });

    await this.toolRegistry.registerTool({
      name: 'fill',
      description: 'Fill an input field',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector' },
          value: { type: 'string', description: 'Value to fill' },
          sessionId: { type: 'string', description: 'Session ID' },
        },
        required: ['selector', 'value'],
      },
    });

    await this.toolRegistry.registerTool({
      name: 'evaluate',
      description: 'Execute JavaScript in the page context',
      inputSchema: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'JavaScript code to execute' },
          sessionId: { type: 'string', description: 'Session ID' },
        },
        required: ['script'],
      },
    });

    await this.toolRegistry.registerTool({
      name: 'get_logs',
      description: 'Get captured console logs and errors from the browser session',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session ID' },
        },
      },
    });

    await this.toolRegistry.registerTool({
      name: 'clear_logs',
      description: 'Clear captured logs for a session',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session ID' },
        },
      },
    });

    // Register more tools...
    // (Additional tool registrations will be added in the next iteration)
  }

  getConfig(): ServerConfig {
    return this.config;
  }

  updateConfig(newConfig: Partial<ServerConfig>): void {
    const oldConfig = { ...this.config };
    this.config = { ...this.config, ...newConfig };
    this.emit('config:changed', { section: 'server', oldValue: oldConfig, newValue: this.config });
  }

  isServerRunning(): boolean {
    return this._isRunning;
  }

  // Alias methods for test compatibility
  isRunning(): boolean {
    return this.isServerRunning();
  }

  async close(): Promise<void> {
    return this.stop();
  }

  listTools() {
    return this.toolRegistry.listTools();
  }

  listResources() {
    return this.resourceManager.listResources();
  }

  listPrompts() {
    return this.promptRegistry.listPrompts();
  }

  getCapabilities() {
    return this.getServerCapabilities();
  }

  // Additional utility methods for better integration
  async callTool(name: string, args: Record<string, any> = {}) {
    return this.toolRegistry.callTool(name, args);
  }

  async readResource(uri: string) {
    return this.resourceManager.readResource(uri);
  }

  async executePrompt(name: string, args?: Record<string, any>) {
    return this.promptRegistry.executePrompt(name, args);
  }
}

export { KoryphaiosMCPServer as ErrorDebuggingMCPServer };
