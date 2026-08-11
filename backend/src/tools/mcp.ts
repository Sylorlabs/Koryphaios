import { spawn, type Subprocess, type FileSink } from 'bun';
import { join } from 'path';
import type { Tool, ToolContext, ToolCallInput, ToolCallOutput } from './registry';
import { toolLog } from '../logger';
import { PROJECT_ROOT } from '../runtime/paths';
import { getSafeSubprocessEnv } from '../runtime/safe-env';

const MCP_REQUEST_TIMEOUT_MS = 30_000;
const MAX_MCP_STDOUT_LINE_BYTES = 1024 * 1024;
const MCP_SERVER_NAME = 'kory-mcp-server';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface JsonRpcMessage {
  id?: number | string;
  error?: unknown;
  result?: unknown;
  method?: string;
  params?: unknown;
}

interface MCPToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  [key: string]: unknown;
}

function outputMetadata(
  stream: 'stdout' | 'stderr',
  outputBytes: number,
  error?: unknown,
): {
  server: string;
  stream: 'stdout' | 'stderr';
  outputBytes: number;
  errorType?: string;
} {
  return {
    server: MCP_SERVER_NAME,
    stream,
    outputBytes,
    ...(error === undefined
      ? {}
      : { errorType: error instanceof Error ? error.name : typeof error }),
  };
}

/**
 * MCP Client for communicating with @koryphaios/mcp-server via stdio.
 */
class MCPClient {
  private static instance: MCPClient;
  private process: Subprocess | null = null;
  private nextId = 1;
  private pendingRequests = new Map<number | string, PendingRequest>();
  private isInitialized = false;
  private startPromise: Promise<void> | null = null;

  private constructor() {}

  static getInstance(): MCPClient {
    if (!MCPClient.instance) {
      MCPClient.instance = new MCPClient();
    }
    return MCPClient.instance;
  }

  private async ensureStarted(): Promise<void> {
    if (this.process && this.process.exitCode === null && this.isInitialized) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.start().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async start(): Promise<void> {
    const mcpServerPath = join(PROJECT_ROOT, 'mcp-server');
    if (!this.process || this.process.exitCode !== null) {
      toolLog.info({ mcpServerPath }, 'Starting MCP server...');

      const child = spawn(['bun', '--no-env-file', 'run', 'src/index.ts'], {
        cwd: mcpServerPath,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: getSafeSubprocessEnv({
          NODE_ENV: process.env.NODE_ENV ?? 'development',
        }),
      });
      this.process = child;
      this.listen(child);
      void child.exited.then(
        (code) => this.handleProcessExit(child, code),
        (error) => this.handleProcessExit(child, null, error),
      );
    }

    await this.initialize();
  }

  private listen(child: Subprocess): void {
    if (child.stdout) {
      void this.readStdout(child, child.stdout as ReadableStream<Uint8Array>);
    }
    if (child.stderr) {
      void this.drainStderr(child.stderr as ReadableStream<Uint8Array>);
    }
  }

  private async readStdout(child: Subprocess, stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let discardedLineBytes = 0;

    const processBuffer = () => {
      if (discardedLineBytes > 0) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) {
          discardedLineBytes += Buffer.byteLength(buffer);
          buffer = '';
          return;
        }
        discardedLineBytes += Buffer.byteLength(buffer.slice(0, newlineIndex));
        toolLog.error(
          outputMetadata('stdout', discardedLineBytes, new RangeError('MCP stdout line too large')),
          'Discarded oversized MCP stdout line',
        );
        discardedLineBytes = 0;
        buffer = buffer.slice(newlineIndex + 1);
      }

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        this.handleStdoutLine(line);
      }

      const bufferedBytes = Buffer.byteLength(buffer);
      if (bufferedBytes > MAX_MCP_STDOUT_LINE_BYTES) {
        discardedLineBytes = bufferedBytes;
        buffer = '';
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        processBuffer();
      }
      buffer += decoder.decode();
      processBuffer();
      if (discardedLineBytes > 0) {
        toolLog.error(
          outputMetadata('stdout', discardedLineBytes, new RangeError('MCP stdout line too large')),
          'Discarded oversized unterminated MCP stdout line',
        );
      } else if (buffer.trim()) {
        this.handleStdoutLine(buffer);
      }
    } catch (error) {
      if (this.process === child) {
        toolLog.error(outputMetadata('stdout', 0, error), 'MCP stdout read error');
      }
    }
  }

  private handleStdoutLine(line: string): void {
    if (!line.trim()) return;
    const outputBytes = Buffer.byteLength(line);
    if (outputBytes > MAX_MCP_STDOUT_LINE_BYTES) {
      toolLog.error(
        outputMetadata('stdout', outputBytes, new RangeError('MCP stdout line too large')),
        'Discarded oversized MCP stdout line',
      );
      return;
    }
    try {
      const message = JSON.parse(line);
      this.handleMessage(message);
    } catch (error) {
      toolLog.error(outputMetadata('stdout', outputBytes, error), 'Failed to parse MCP message');
    }
  }

  private async drainStderr(stderr: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stderr.getReader();
    let outputBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        outputBytes += value.byteLength;
      }
      if (outputBytes > 0) {
        toolLog.warn(outputMetadata('stderr', outputBytes), 'MCP process emitted stderr');
      }
    } catch (error) {
      toolLog.error(outputMetadata('stderr', outputBytes, error), 'MCP stderr read error');
    }
  }

  private handleMessage(message: JsonRpcMessage) {
    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.error) {
          pending.reject(new Error('MCP server returned an error response'));
        } else {
          pending.resolve(message.result);
        }
      }
    }
  }

  private async sendRequest(method: string, params: unknown): Promise<unknown> {
    await this.ensureStarted();
    return this.sendRequestToActiveProcess(method, params);
  }

  private sendRequestToActiveProcess(method: string, params: unknown): Promise<unknown> {
    if (!this.process || this.process.exitCode !== null) {
      return Promise.reject(new Error('MCP server is not running'));
    }
    const id = this.nextId++;
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pendingRequests.delete(id)) return;
        reject(new Error(`MCP request timed out while handling ${method}`));
      }, MCP_REQUEST_TIMEOUT_MS);
      timeout.unref?.();
      this.pendingRequests.set(id, { resolve, reject, timeout });
      const encoded = new TextEncoder().encode(JSON.stringify(request) + '\n');
      try {
        const stdin = this.process!.stdin as FileSink;
        stdin.write(encoded);
        stdin.flush();
      } catch {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(new Error('Failed to write MCP request'));
      }
    });
  }

  private async sendNotification(method: string, params: unknown): Promise<void> {
    await this.ensureStarted();
    this.sendNotificationToActiveProcess(method, params);
  }

  private sendNotificationToActiveProcess(method: string, params: unknown): void {
    if (!this.process || this.process.exitCode !== null) {
      throw new Error('MCP server is not running');
    }
    const notification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    const encoded = new TextEncoder().encode(JSON.stringify(notification) + '\n');
    const stdin = this.process.stdin as FileSink;
    stdin.write(encoded);
    stdin.flush();
  }

  private async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      // The bundled mcp-server uses the v2 SDK. 2025-11-25 is the compatibility
      // initialize revision accepted by older local builds; the server also
      // advertises the current 2026-07-28 revision through its public flow.
      await this.sendRequestToActiveProcess('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: {
          name: 'koryphaios-backend',
          version: '1.0.0',
        },
      });

      this.sendNotificationToActiveProcess('notifications/initialized', {});
      this.isInitialized = true;
      toolLog.info('MCP server initialized');
    } catch (err) {
      toolLog.error(
        { errorType: err instanceof Error ? err.name : typeof err },
        'Failed to initialize MCP server',
      );
      throw err;
    }
  }

  private handleProcessExit(child: Subprocess, code: number | null, error?: unknown): void {
    if (this.process !== child) return;
    this.process = null;
    this.isInitialized = false;
    const pendingCount = this.pendingRequests.size;
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`MCP server exited with code ${code ?? 'unknown'}`));
    }
    this.pendingRequests.clear();
    toolLog.warn(
      {
        server: MCP_SERVER_NAME,
        code,
        pendingRequests: pendingCount,
        ...(error === undefined
          ? {}
          : { errorType: error instanceof Error ? error.name : typeof error }),
      },
      'MCP server exited',
    );
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
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
      const result = (await client.callTool(this.name, call.input)) as MCPToolCallResult;

      let output = '';
      if (result.content && Array.isArray(result.content)) {
        output = result.content
          .map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
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
    } catch (err: unknown) {
      toolLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'mcp tool call failed',
      );
      return {
        callId: call.id,
        name: this.name,
        output: `MCP Error: ${err instanceof Error ? err.message : String(err)}`,
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
