// MCP (Model Context Protocol) client integration.
// Supports connecting to MCP servers via stdio and SSE transports.
// This allows Koryphaios to connect to external tool servers.
//
// Protocol negotiation: the client probes with server/discover (2026-07-28).
// If the server responds, it uses the stateless 2026-07-28 flow (per-request
// _meta, no initialize handshake). If server/discover returns method-not-found
// (-32601), it falls back to the 2025-11-25 legacy initialize handshake. This
// keeps existing user MCP servers working while supporting the current spec.

import { mcpLog, serverLog } from '../logger';
import { resolve } from 'node:path';
import type { Tool, ToolCallInput, ToolContext, ToolCallOutput } from '../tools/registry';
import { ToolRegistry } from '../tools/registry';
import { VERSION } from '../constants';
import { registerMCPToolsInRegistry } from './tool-bridge';

/** MCP protocol versions supported by this client, newest first. The client
 *  negotiates the highest mutually supported version via server/discover. */
const SUPPORTED_PROTOCOL_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2024-11-05',
] as const;
type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];
const LEGACY_PROTOCOL_VERSION: ProtocolVersion = '2025-11-25';
/** The newest spec revision (stateless, per-request _meta, server/discover). */
const CURRENT_PROTOCOL_VERSION: ProtocolVersion = '2026-07-28';

// ─── MCP Protocol Types ─────────────────────────────────────────────────────

interface MCPServerConfig {
  name: string;
  transport: 'stdio' | 'sse';
  command?: string; // For stdio
  args?: string[]; // For stdio
  env?: Record<string, string>;
  url?: string; // For SSE
  headers?: Record<string, string>;
}

interface MCPRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface MCPDiscoverResult {
  // 2026-07-28 spec: field is `supportedVersions`, not `protocolVersions`.
  // Only modern (2026-07-28+) versions are listed; 2025-era versions are
  // negotiated via the legacy initialize handshake.
  supportedVersions?: string[];
  capabilities?: Record<string, unknown>;
  // serverInfo is NOT a top-level field on DiscoverResult — it's in
  // result._meta['io.modelcontextprotocol/serverInfo'] (spec PR #3002).
  // Kept here for backward compat with older drafts.
  serverInfo?: { name: string; version: string };
}

interface MCPToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface MCPToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

const MCP_REQUEST_TIMEOUT_MS = 30_000;
const MCP_IDLE_SHUTDOWN_MS = 2 * 60_000;
export const MCP_STDIO_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** MCP servers fully control stderr and may print prompts, credentials, or
 * unbounded tool diagnostics. Logs record only the byte count. */
export function mcpStderrLogMetadata(
  server: string,
  chunk: Uint8Array,
): { server: string; stream: 'stderr'; outputBytes: number } {
  return { server, stream: 'stderr', outputBytes: chunk.byteLength };
}

/** Malformed stdout is equally server-controlled. A JSON parser error embeds
 * the rejected input in its message, so neither the line nor Error may cross
 * the logger boundary. */
export function mcpMalformedStdoutLogMetadata(
  server: string,
  line: string,
  error: unknown,
): {
  server: string;
  stream: 'stdout';
  outputBytes: number;
  errorType: string;
} {
  return {
    server,
    stream: 'stdout',
    outputBytes: Buffer.byteLength(line),
    errorType: error instanceof Error ? error.name : typeof error,
  };
}

/** A framing violation is structural transport metadata only. The rejected
 * frame may contain arbitrary prompts, tool output, or credentials. */
export function mcpOversizedStdoutLogMetadata(
  server: string,
  outputBytes: number,
  limitBytes = MCP_STDIO_MAX_FRAME_BYTES,
): {
  server: string;
  stream: 'stdout';
  outputBytes: number;
  limitBytes: number;
  reason: 'frame_too_large';
} {
  return {
    server,
    stream: 'stdout',
    outputBytes,
    limitBytes,
    reason: 'frame_too_large',
  };
}

// ─── MCP Client ─────────────────────────────────────────────────────────────

export class MCPClient {
  private process?: ReturnType<typeof Bun.spawn>;
  private requestId = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: MCPResponse) => void;
      reject: (reason: Error) => void;
    }
  >();
  private buffer = '';
  private bufferBytes = 0;
  private readonly maxStdoutFrameBytes = MCP_STDIO_MAX_FRAME_BYTES;
  private readonly discardedStdoutProcesses = new WeakSet<object>();
  private tools: MCPToolDef[] = [];
  private connected = false;
  private serverName: string;
  private serverCapabilities: Record<string, unknown> = {};
  private idleShutdown: ReturnType<typeof setTimeout> | null = null;
  /** Negotiated protocol version for this server connection. */
  private protocolVersion: ProtocolVersion = LEGACY_PROTOCOL_VERSION;
  /** Last connection error, surfaced in listServers() for the UI. */
  lastError: string | undefined;

  constructor(private config: MCPServerConfig) {
    this.serverName = config.name;
  }

  get name() {
    return this.serverName;
  }
  get isConnected() {
    return this.connected;
  }
  get availableTools() {
    return this.tools;
  }
  get negotiatedProtocolVersion() {
    return this.protocolVersion;
  }
  get transport() {
    return this.config.transport;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    try {
      if (this.config.transport === 'stdio') {
        await this.connectStdio();
      } else {
        await this.connectSSE();
      }
      this.lastError = undefined;
    } catch (err: unknown) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  private async connectStdio(): Promise<void> {
    const { command, args = [], env = {} } = this.config;
    if (!command)
      throw new Error(`MCP server ${this.serverName}: command is required for stdio transport`);

    // Build a safe environment to prevent leaking API keys to MCP servers
    const safeEnv: Record<string, string> = {};
    const allowedVars = new Set([
      'PATH',
      'HOME',
      'USER',
      'LANG',
      'TERM',
      'NODE_ENV',
      'SHELL',
      'TMPDIR',
    ]);
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;

      // Explicitly block known sensitive prefixes
      if (
        key.startsWith('KORYPHAIOS_') ||
        key.startsWith('ANTHROPIC_') ||
        key.startsWith('OPENAI_') ||
        key.startsWith('GOOGLE_') ||
        key.includes('API_KEY') ||
        key.includes('TOKEN') ||
        key.includes('SECRET')
      ) {
        continue;
      }

      // Allow basic system variables
      if (allowedVars.has(key)) {
        safeEnv[key] = value;
      }
    }

    const processHandle = Bun.spawn([command, ...args], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...safeEnv, ...env },
    });
    this.process = processHandle;

    // Read stdout asynchronously
    const stdoutReader = (processHandle.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    (async () => {
      try {
        while (true) {
          const { done, value } = await stdoutReader.read();
          if (done) {
            const trailing = decoder.decode();
            if (trailing) this.acceptStdoutText(processHandle, trailing);
            break;
          }
          this.acceptStdoutText(processHandle, decoder.decode(value, { stream: true }));
        }
      } catch (err: unknown) {
        serverLog.debug(
          {
            errorType: err instanceof Error ? err.name : typeof err,
            server: this.serverName,
            stream: 'stdout',
          },
          'MCP stdout stream closed',
        );
        this.failStdioTransport(
          processHandle,
          new Error('MCP stdout transport closed before the request completed'),
        );
      }
    })();

    // Read stderr asynchronously
    const stderrReader = (processHandle.stderr as ReadableStream<Uint8Array>).getReader();
    (async () => {
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          mcpLog.error(mcpStderrLogMetadata(this.serverName, value), 'MCP process emitted stderr');
        }
      } catch (err: unknown) {
        serverLog.debug(
          {
            errorType: err instanceof Error ? err.name : typeof err,
            server: this.serverName,
            stream: 'stderr',
          },
          'MCP stderr stream closed',
        );
      }
    })();

    processHandle.exited
      .then((code) => {
        mcpLog.info({ server: this.serverName, code }, 'MCP process exited');
        this.failStdioTransport(
          processHandle,
          new Error('MCP process exited before the request completed'),
          false,
        );
      })
      .catch((err: unknown) => {
        mcpLog.warn(
          { server: this.serverName, errorType: err instanceof Error ? err.name : typeof err },
          'Failed to track MCP process exit',
        );
        this.failStdioTransport(
          processHandle,
          new Error('MCP process exit could not be observed safely'),
        );
      });

    // ── Protocol negotiation ──────────────────────────────────────────────
    // Probe with server/discover (2026-07-28). If the server responds, use the
    // stateless flow. If it returns method-not-found (-32601), fall back to the
    // 2025-11-25 initialize handshake used by existing local servers.
    let discovered = false;
    try {
      const discoverResult = await this.request('server/discover', {});
      if (this.process !== processHandle) {
        throw new Error('MCP process exited during server/discover');
      }
      const discover = discoverResult.result as MCPDiscoverResult | undefined;
      if (discover?.supportedVersions?.length) {
        // Pick the highest mutually supported modern version.
        const serverSupported = new Set(discover.supportedVersions);
        const negotiated = SUPPORTED_PROTOCOL_VERSIONS.find((v) => serverSupported.has(v));
        if (negotiated) {
          this.protocolVersion = negotiated;
          this.serverCapabilities = discover.capabilities ?? {};
          discovered = true;
          mcpLog.info(
            { server: this.serverName, protocolVersion: this.protocolVersion },
            'MCP server discovered (2026-07-28 stateless flow)',
          );
        }
      }
    } catch (err: unknown) {
      // Transport-level failure (timeout, stdin write). JSON-RPC -32601 errors
      // resolve (not reject) with response.error set — handled by the undefined
      // discover.result check above, which falls through to legacy initialize.
      mcpLog.debug(
        { server: this.serverName, err: err instanceof Error ? err.message : String(err) },
        'server/discover probe failed; falling back to legacy initialize',
      );
    }

    if (!discovered) {
      // Legacy 2025-11-25 initialize handshake.
      this.protocolVersion = LEGACY_PROTOCOL_VERSION;
      const initResult = await this.request('initialize', {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: {
          roots: { listChanged: false },
        },
        clientInfo: {
          name: 'koryphaios',
          version: VERSION,
        },
      });

      if (this.process !== processHandle) {
        throw new Error('MCP process exited during initialization');
      }

      this.serverCapabilities =
        (initResult.result as { capabilities?: Record<string, unknown> } | undefined)
          ?.capabilities ?? {};

      // Send initialized notification
      this.notify('notifications/initialized', {});
    }

    // List available tools if server supports them. In 2026-07-28 the
    // capabilities may be empty (stateless servers need not advertise), so
    // attempt tools/list regardless when no capability gate is present.
    const hasToolsCapability = Boolean(this.serverCapabilities.tools);
    if (discovered || hasToolsCapability) {
      try {
        const toolsResult = await this.request('tools/list', {});
        if (this.process !== processHandle) {
          throw new Error('MCP process exited during tools/list');
        }
        const result = toolsResult.result as
          { tools?: MCPToolDef[]; ttlMs?: number; cacheScope?: string } | undefined;
        this.tools = result?.tools ?? [];
      } catch (err: unknown) {
        mcpLog.warn(
          { server: this.serverName, err: err instanceof Error ? err.message : String(err) },
          'Failed to list tools despite capability',
        );
      }
    }

    if (this.process !== processHandle) {
      throw new Error('MCP process exited during initialization');
    }

    this.connected = true;
    this.scheduleIdleShutdown();
    mcpLog.info(
      { server: this.serverName, tools: this.tools.length, protocolVersion: this.protocolVersion },
      'MCP connected via stdio',
    );
  }

  private async connectSSE(): Promise<void> {
    // Streamable HTTP transport — connect to HTTP endpoint.
    const { url, headers = {} } = this.config;
    if (!url) throw new Error(`MCP server ${this.serverName}: url is required for SSE transport`);

    // ── Protocol negotiation via server/discover ──────────────────────────
    let discovered = false;
    try {
      const discoverResp = await fetch(`${url}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Method': 'server/discover',
          'Mcp-Name': '',
          ...headers,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++this.requestId,
          method: 'server/discover',
          params: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': CURRENT_PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientInfo': { name: 'koryphaios', version: VERSION },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        }),
      });
      if (discoverResp.ok) {
        const data = (await discoverResp.json()) as MCPResponse;
        const discover = data.result as MCPDiscoverResult | undefined;
        if (discover?.supportedVersions?.length) {
          const serverSupported = new Set(discover.supportedVersions);
          const negotiated = SUPPORTED_PROTOCOL_VERSIONS.find((v) => serverSupported.has(v));
          if (negotiated) {
            this.protocolVersion = negotiated;
            this.serverCapabilities = discover.capabilities ?? {};
            discovered = true;
            mcpLog.info(
              { server: this.serverName, protocolVersion: this.protocolVersion },
              'MCP server discovered via HTTP (2026-07-28 stateless flow)',
            );
          }
        }
      }
    } catch (err: unknown) {
      mcpLog.debug(
        { server: this.serverName, err: err instanceof Error ? err.message : String(err) },
        'server/discover HTTP probe failed; falling back to legacy initialize',
      );
    }

    if (!discovered) {
      // Legacy 2025-11-25 initialize over HTTP.
      this.protocolVersion = LEGACY_PROTOCOL_VERSION;
      const initResp = await fetch(`${url}/initialize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++this.requestId,
          method: 'initialize',
          params: {
            protocolVersion: LEGACY_PROTOCOL_VERSION,
            capabilities: { roots: { listChanged: false } },
            clientInfo: { name: 'koryphaios', version: VERSION },
          },
        }),
      });
      if (!initResp.ok) {
        throw new Error(
          `MCP server ${this.serverName}: initialization failed (${initResp.status})`,
        );
      }
      const initData = (await initResp.json()) as MCPResponse;
      this.serverCapabilities =
        (initData.result as { capabilities?: Record<string, unknown> } | undefined)?.capabilities ??
        {};
    }

    // List tools
    const toolsResp = await fetch(`${url}/tools/list`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Mcp-Method': 'tools/list',
        'Mcp-Name': '',
        ...headers,
      },
      body: JSON.stringify(
        this.protocolVersion === CURRENT_PROTOCOL_VERSION
          ? {
              jsonrpc: '2.0',
              id: ++this.requestId,
              method: 'tools/list',
              params: {},
              _meta: {
                'io.modelcontextprotocol/protocolVersion': this.protocolVersion,
                'io.modelcontextprotocol/clientInfo': { name: 'koryphaios', version: VERSION },
                'io.modelcontextprotocol/clientCapabilities': {},
              },
            }
          : {
              jsonrpc: '2.0',
              id: ++this.requestId,
              method: 'tools/list',
              params: {},
            },
      ),
    });

    if (toolsResp.ok) {
      const data = (await toolsResp.json()) as MCPResponse;
      const result = data.result as
        { tools?: MCPToolDef[]; ttlMs?: number; cacheScope?: string } | undefined;
      this.tools = result?.tools ?? [];
    }

    this.connected = true;
    this.scheduleIdleShutdown();
    mcpLog.info(
      { server: this.serverName, tools: this.tools.length, protocolVersion: this.protocolVersion },
      'MCP connected via HTTP',
    );
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    if (!this.connected) await this.connect();
    this.clearIdleShutdown();
    try {
      if (this.config.transport === 'stdio') {
        const response = await this.request('tools/call', { name, arguments: args });
        if (response.error) {
          return {
            content: [{ type: 'text', text: `MCP Error: ${response.error.message}` }],
            isError: true,
          };
        }
        return response.result as MCPToolResult;
      } else {
        // Streamable HTTP transport
        const isCurrent = this.protocolVersion === CURRENT_PROTOCOL_VERSION;
        const resp = await fetch(`${this.config.url}/tools/call`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Mcp-Method': 'tools/call',
            'Mcp-Name': name,
            ...(this.config.headers ?? {}),
          },
          body: JSON.stringify(
            isCurrent
              ? {
                  jsonrpc: '2.0',
                  id: ++this.requestId,
                  method: 'tools/call',
                  params: { name, arguments: args },
                  _meta: {
                    'io.modelcontextprotocol/protocolVersion': this.protocolVersion,
                    'io.modelcontextprotocol/clientInfo': { name: 'koryphaios', version: VERSION },
                    'io.modelcontextprotocol/clientCapabilities': {},
                  },
                }
              : {
                  jsonrpc: '2.0',
                  id: ++this.requestId,
                  method: 'tools/call',
                  params: { name, arguments: args },
                },
          ),
        });

        if (!resp.ok) {
          return {
            content: [{ type: 'text', text: `MCP HTTP Error: ${resp.status}` }],
            isError: true,
          };
        }

        const data = (await resp.json()) as MCPResponse;
        if (data.error) {
          return {
            content: [{ type: 'text', text: `MCP Error: ${data.error.message}` }],
            isError: true,
          };
        }
        return data.result as MCPToolResult;
      }
    } finally {
      this.scheduleIdleShutdown();
    }
  }

  private async request(method: string, params: unknown): Promise<MCPResponse> {
    if (this.config.transport === 'stdio' && !this.process) {
      throw new Error('MCP process not started');
    }

    const id = ++this.requestId;
    // For the 2026-07-28 stateless protocol, every request carries protocol
    // version + client identity + capabilities in _meta. Legacy requests omit it.
    // The server/discover probe always advertises the current version so the
    // server knows what we're probing for, even before negotiation completes.
    const includeMeta =
      this.protocolVersion === CURRENT_PROTOCOL_VERSION || method === 'server/discover';
    const metaVersion =
      method === 'server/discover' ? CURRENT_PROTOCOL_VERSION : this.protocolVersion;
    const baseRequest: MCPRequest = { jsonrpc: '2.0', id, method, params };
    const request = includeMeta
      ? {
          ...baseRequest,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': metaVersion,
            'io.modelcontextprotocol/clientInfo': { name: 'koryphaios', version: VERSION },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        }
      : baseRequest;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`MCP server ${this.serverName} timed out while handling ${method}`));
      }, MCP_REQUEST_TIMEOUT_MS);
      timeout.unref?.();
      this.pending.set(id, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.clearIdleShutdown();

      if (this.config.transport === 'stdio') {
        const stdin = this.process!.stdin as unknown as {
          write: (chunk: string | Uint8Array) => void;
          flush: () => void;
        };
        stdin.write(JSON.stringify(request) + '\n');
        stdin.flush();
      }
    });
  }

  private notify(method: string, params: unknown): void {
    const notification = { jsonrpc: '2.0', method, params };
    if (this.config.transport === 'stdio' && this.process) {
      const stdin = this.process!.stdin as unknown as {
        write: (chunk: string | Uint8Array) => void;
        flush: () => void;
      };
      stdin.write(JSON.stringify(notification) + '\n');
      stdin.flush();
    }
  }

  private acceptStdoutText(processHandle: ReturnType<typeof Bun.spawn>, text: string): void {
    if (!text || this.discardedStdoutProcesses.has(processHandle)) return;

    let cursor = 0;
    while (cursor < text.length) {
      const newlineIdx = text.indexOf('\n', cursor);
      const end = newlineIdx >= 0 ? newlineIdx : text.length;
      const segment = text.slice(cursor, end);
      const frameBytes = this.bufferBytes + Buffer.byteLength(segment, 'utf8');
      if (frameBytes > this.maxStdoutFrameBytes) {
        mcpLog.warn(
          mcpOversizedStdoutLogMetadata(this.serverName, frameBytes, this.maxStdoutFrameBytes),
          'MCP stdout frame exceeded the transport limit',
        );
        this.discardedStdoutProcesses.add(processHandle);
        this.buffer = '';
        this.bufferBytes = 0;
        this.failStdioTransport(
          processHandle,
          new Error('MCP stdout frame exceeded the supported size'),
        );
        return;
      }

      if (newlineIdx < 0) {
        this.buffer += segment;
        this.bufferBytes = frameBytes;
        return;
      }

      const line = `${this.buffer}${segment}`.trim();
      this.buffer = '';
      this.bufferBytes = 0;
      cursor = newlineIdx + 1;

      if (!line) continue;

      try {
        const response = JSON.parse(line) as MCPResponse;
        if (response.id && this.pending.has(response.id)) {
          const { resolve } = this.pending.get(response.id)!;
          this.pending.delete(response.id);
          resolve(response);
        }
      } catch (err) {
        mcpLog.error(
          mcpMalformedStdoutLogMetadata(this.serverName, line, err),
          'Failed to parse MCP response',
        );
      }
    }
  }

  private rejectPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) request.reject(error);
  }

  private failStdioTransport(
    processHandle: ReturnType<typeof Bun.spawn>,
    error: Error,
    terminate = true,
  ): void {
    const ownedProcess = this.process;
    if (!ownedProcess || ownedProcess !== processHandle) return;
    if (terminate) this.discardedStdoutProcesses.add(processHandle);
    this.process = undefined;
    this.connected = false;
    this.buffer = '';
    this.bufferBytes = 0;
    this.clearIdleShutdown();
    this.rejectPending(error);

    if (!terminate) return;
    try {
      ownedProcess.kill();
    } catch (killError: unknown) {
      mcpLog.debug(
        {
          server: this.serverName,
          errorType: killError instanceof Error ? killError.name : typeof killError,
        },
        'MCP process termination was already complete',
      );
    }
  }

  async shutdown(): Promise<void> {
    this.clearIdleShutdown();
    const processHandle = this.process;
    if (processHandle) {
      this.failStdioTransport(
        processHandle,
        new Error('MCP client shut down before the request completed'),
      );
    } else {
      this.connected = false;
      this.buffer = '';
      this.bufferBytes = 0;
      this.rejectPending(new Error('MCP client shut down before the request completed'));
    }
  }

  private clearIdleShutdown(): void {
    if (this.idleShutdown) clearTimeout(this.idleShutdown);
    this.idleShutdown = null;
  }

  private scheduleIdleShutdown(): void {
    if (!this.connected || this.pending.size > 0) return;
    this.clearIdleShutdown();
    this.idleShutdown = setTimeout(() => {
      mcpLog.info({ server: this.serverName }, 'Shutting down idle MCP server');
      void this.shutdown();
    }, MCP_IDLE_SHUTDOWN_MS);
    this.idleShutdown.unref?.();
  }
}

// ─── MCP Tool Wrapper ───────────────────────────────────────────────────────

export class MCPToolWrapper implements Tool {
  readonly role = 'worker' as const;

  constructor(
    private client: MCPClient,
    private def: MCPToolDef,
  ) {}

  get name() {
    return `mcp_${this.client.name}_${this.def.name}`;
  }
  get description() {
    return this.def.description;
  }
  get inputSchema() {
    return this.def.inputSchema;
  }

  async run(ctx: ToolContext, input: ToolCallInput): Promise<ToolCallOutput> {
    const start = performance.now();
    try {
      const result = await this.client.callTool(this.def.name, input.input);
      const text = result.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');

      return {
        callId: input.id,
        name: this.name,
        output: text || '[No text output from MCP tool]',
        isError: !!result.isError,
        durationMs: performance.now() - start,
      };
    } catch (err: unknown) {
      return {
        callId: input.id,
        name: this.name,
        output: `MCP Tool Error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
        durationMs: performance.now() - start,
      };
    }
  }
}

// ─── MCP Manager ─────────────────────────────────────────────────────────────

export interface McpServerStatus {
  name: string;
  transport: 'stdio' | 'sse';
  connected: boolean;
  toolCount: number;
  protocolVersion: string;
  lastError?: string;
}

export class MCPManager {
  private clients = new Map<string, MCPClient>();

  constructor(private workingDirectory: string) {}

  private scopeKey(name: string, projectRoot = this.workingDirectory): string {
    return `${resolve(projectRoot)}\u0000${name}`;
  }

  private assertNameNotActiveInAnotherProject(name: string, projectRoot: string): void {
    const scope = resolve(projectRoot);
    for (const key of this.clients.keys()) {
      const separator = key.indexOf('\u0000');
      if (separator === -1 || key.slice(separator + 1) !== name) continue;
      if (key.slice(0, separator) !== scope) {
        throw new Error(`MCP server "${name}" is already active for another project`);
      }
    }
  }

  async connectServer(
    config: MCPServerConfig,
    projectRoot = this.workingDirectory,
  ): Promise<MCPClient> {
    this.assertNameNotActiveInAnotherProject(config.name, projectRoot);
    const key = this.scopeKey(config.name, projectRoot);
    const client = new MCPClient(config);
    await client.connect();
    this.clients.set(key, client);
    return client;
  }

  /** Connect a new server and register its tools immediately (hot-add). */
  async addServer(
    config: MCPServerConfig,
    registry: ToolRegistry,
    projectRoot = this.workingDirectory,
  ): Promise<MCPClient> {
    this.assertNameNotActiveInAnotherProject(config.name, projectRoot);
    const key = this.scopeKey(config.name, projectRoot);
    // If a server with this name exists, shut it down first (replace semantics).
    const existing = this.clients.get(key);
    if (existing) {
      await existing.shutdown();
      registry.unregisterByPrefix(`mcp_${config.name}_`);
      this.clients.delete(key);
    }
    const client = new MCPClient(config);
    await client.connect();
    this.clients.set(key, client);
    await registerMCPToolsInRegistry(registry, client);
    return client;
  }

  /** Shut down a server and remove its tools from the registry (hot-remove). */
  async removeServer(
    name: string,
    registry: ToolRegistry,
    projectRoot = this.workingDirectory,
  ): Promise<boolean> {
    const key = this.scopeKey(name, projectRoot);
    const client = this.clients.get(key);
    if (!client) return false;
    await client.shutdown();
    registry.unregisterByPrefix(`mcp_${name}_`);
    this.clients.delete(key);
    return true;
  }

  /** Shut down and reconnect a server with updated config (hot-reload). */
  async reloadServer(
    name: string,
    config: MCPServerConfig,
    registry: ToolRegistry,
    projectRoot = this.workingDirectory,
  ): Promise<MCPClient> {
    const key = this.scopeKey(name, projectRoot);
    this.assertNameNotActiveInAnotherProject(name, projectRoot);
    const existing = this.clients.get(key);
    if (existing) {
      await existing.shutdown();
      registry.unregisterByPrefix(`mcp_${name}_`);
      this.clients.delete(key);
    }
    return this.addServer(config, registry, projectRoot);
  }

  /** Snapshot of all servers for UI status display. */
  listServers(projectRoot?: string): McpServerStatus[] {
    const scope = projectRoot === undefined ? null : `${resolve(projectRoot)}\u0000`;
    return [...this.clients.entries()]
      .filter(([key]) => scope === null || key.startsWith(scope))
      .map(([, client]) => ({
        name: client.name,
        transport: client.transport,
        connected: client.isConnected,
        toolCount: client.availableTools.length,
        protocolVersion: client.negotiatedProtocolVersion,
        lastError: client.lastError,
      }));
  }

  /** Get a connected client by name (for test-connect). */
  getClient(name: string, projectRoot = this.workingDirectory): MCPClient | undefined {
    return this.clients.get(this.scopeKey(name, projectRoot));
  }

  async registerAllTools(registry: ToolRegistry): Promise<void> {
    for (const client of this.clients.values()) {
      await registerMCPToolsInRegistry(registry, client);
    }
  }

  async shutdown(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.shutdown();
    }
    this.clients.clear();
  }
}

interface MCPInitConfig {
  mcpServers?: Record<string, Partial<MCPServerConfig> & { type?: string }>;
}

/**
 * Initialize MCP servers from configuration.
 */
export async function initMCP(config: MCPInitConfig, tools: ToolRegistry): Promise<MCPManager> {
  const manager = new MCPManager(process.cwd());
  const servers = config.mcpServers || {};

  for (const [name, serverConfig] of Object.entries(servers)) {
    try {
      const cfg = serverConfig;
      await manager.connectServer({
        name,
        ...cfg,
        // Normalize "type" field to "transport" (config files use "type")
        transport: (cfg.transport ?? cfg.type ?? 'stdio') as 'stdio' | 'sse',
      });
    } catch (err: unknown) {
      mcpLog.error(
        { server: name, err: err instanceof Error ? err.message : String(err) },
        'Failed to connect to MCP server',
      );
    }
  }

  await manager.registerAllTools(tools);
  return manager;
}
