import { spawn, type Subprocess, type FileSink } from 'bun';
import { join } from 'path';
import type { Tool, ToolContext, ToolCallInput, ToolCallOutput } from './registry';
import { toolLog } from '../logger';
import { PROJECT_ROOT } from '../runtime/paths';

/**
 * MCP Client for communicating with @koryphaios/mcp-server via stdio.
 */
class MCPClient {
  private static instance: MCPClient;
  private process: Subprocess | null = null;
  private nextId = 1;
  private pendingRequests = new Map<
    number | string,
    { resolve: (val: any) => void; reject: (err: any) => void }
  >();
  private isInitialized = false;

  private constructor() {}

  static getInstance(): MCPClient {
    if (!MCPClient.instance) {
      MCPClient.instance = new MCPClient();
    }
    return MCPClient.instance;
  }

  private async ensureStarted(): Promise<void> {
    if (this.process && this.process.exitCode === null) {
      return;
    }

    const mcpServerPath = join(PROJECT_ROOT, 'mcp-server');
    toolLog.info({ mcpServerPath }, 'Starting MCP server...');

    this.process = spawn(['bun', 'run', 'src/index.ts'], {
      cwd: mcpServerPath,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit', // Forward stderr to see server logs
      env: {
        ...process.env,
        NODE_ENV: 'development',
      },
    });

    this.listen();
    await this.initialize();
  }

  private listen() {
    if (!this.process?.stdout) return;

    const stdout = this.process.stdout as ReadableStream<Uint8Array>;
    const reader = stdout.getReader();
    let buffer = '';

    const processBuffer = () => {
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim()) {
          try {
            const message = JSON.parse(line);
            this.handleMessage(message);
          } catch (err) {
            toolLog.error({ err, line }, 'Failed to parse MCP message');
          }
        }
      }
    };

    const read = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += new TextDecoder().decode(value);
          processBuffer();
        }
      } catch (err) {
        toolLog.error({ err }, 'MCP stdout read error');
      }
    };

    read();
  }

  private handleMessage(message: any) {
    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(message.error);
        } else {
          pending.resolve(message.result);
        }
      }
    }
  }

  private async sendRequest(method: string, params: any): Promise<any> {
    await this.ensureStarted();
    const id = this.nextId++;
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      const encoded = new TextEncoder().encode(JSON.stringify(request) + '\n');
      const stdin = this.process!.stdin as FileSink;
      stdin.write(encoded);
    });
  }

  private async sendNotification(method: string, params: any): Promise<void> {
    await this.ensureStarted();
    const notification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    const encoded = new TextEncoder().encode(JSON.stringify(notification) + '\n');
    const stdin = this.process!.stdin as FileSink;
    stdin.write(encoded);
  }

  private async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      await this.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'koryphaios-backend',
          version: '1.0.0',
        },
      });

      await this.sendNotification('notifications/initialized', {});
      this.isInitialized = true;
      toolLog.info('MCP server initialized');
    } catch (err) {
      toolLog.error({ err }, 'Failed to initialize MCP server');
      throw err;
    }
  }

  async callTool(name: string, args: any): Promise<any> {
    return this.sendRequest('tools/call', {
      name,
      arguments: args,
    });
  }
}

/**
 * Base class for MCP-proxied tools.
 */
abstract class BaseMCPTool implements Tool {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly inputSchema: Record<string, unknown>;
  readonly role: 'worker' = 'worker';

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const start = performance.now();
    try {
      const client = MCPClient.getInstance();
      const result = await client.callTool(this.name, call.input);

      let output = '';
      if (result.content && Array.isArray(result.content)) {
        output = result.content
          .map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c)))
          .join('\n');
      } else {
        output = JSON.stringify(result);
      }

      return {
        callId: call.id,
        name: this.name,
        output,
        isError: !!result.isError,
        durationMs: performance.now() - start,
      };
    } catch (err: any) {
      return {
        callId: call.id,
        name: this.name,
        output: `MCP Error: ${err.message ?? String(err)}`,
        isError: true,
        durationMs: performance.now() - start,
      };
    }
  }
}

export class MCPDetectErrorsTool extends BaseMCPTool {
  readonly name = 'detect-errors';
  readonly description = 'Detect errors from various sources (console, runtime, build, test)';
  readonly inputSchema = {
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
        description: 'Project root directory to analyze (defaults to current working directory)',
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
  };
}

export class MCPAnalyzeErrorTool extends BaseMCPTool {
  readonly name = 'analyze-error';
  readonly description = 'Perform deep analysis of a specific error';
  readonly inputSchema = {
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
  };
}

export class MCPSuggestFixesTool extends BaseMCPTool {
  readonly name = 'suggest-fixes';
  readonly description = 'Suggest fixes for a specific error';
  readonly inputSchema = {
    type: 'object',
    properties: {
      errorId: {
        type: 'string',
        description: 'ID of the error to suggest fixes for',
      },
      maxSuggestions: {
        type: 'number',
        description: 'Maximum number of suggestions to return',
      },
      confidenceThreshold: {
        type: 'number',
        description: 'Minimum confidence threshold for suggestions',
      },
    },
    required: ['errorId'],
  };
}
