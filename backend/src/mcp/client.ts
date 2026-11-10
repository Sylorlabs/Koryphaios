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
import { validatedToolImages } from '../tools/tool-images';
import { createHash } from 'node:crypto';
import type { Tool, ToolCallInput, ToolContext, ToolCallOutput } from '../tools/registry';
import { ToolRegistry } from '../tools/registry';
import { VERSION } from '../constants';
import { registerMCPToolsInRegistry } from './tool-bridge';
import { mcpProjectScope } from './project-scope';

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
/** Timeout for a single Streamable HTTP JSON-RPC round trip. */
export const MCP_HTTP_TIMEOUT_MS = 30_000;
/** Ceiling on a single Streamable HTTP response body. */
export const MCP_HTTP_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Parse a JSON body without ever letting the server-controlled text escape
 *  into an error message (JSON.parse errors embed the rejected input). */
function safeJsonParse(raw: string): MCPResponse | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as MCPResponse;
    return null;
  } catch {
    return null;
  }
}

/**
 * A JSON object is only a JSON-RPC response if it carries the envelope or a
 * well-formed result/error member. Gateways and proxies answer MCP requests
 * with bodies like `{"error":"route_not_found"}`, which must not be mistaken
 * for a successful response — otherwise callers report a meaningless
 * "failed (undefined)" instead of the HTTP status that actually explains it.
 */
function isJsonRpcResponse(value: MCPResponse | null): value is MCPResponse {
  if (!value) return false;
  if (value.jsonrpc === '2.0') return true;
  const hasResult = 'result' in value && value.result !== undefined;
  const hasError = 'error' in value && value.error !== undefined;
  return hasResult || hasError;
}

/** Human-readable reason for a JSON-RPC `error` member that is not the
 *  expected `{ code, message }` object. Returns undefined when the error is
 *  well-formed, so the message never embeds server-controlled content. */
function jsonRpcErrorMessage(response: MCPResponse): string | undefined {
  const error = response.error;
  if (error && typeof error === 'object' && typeof error.message === 'string') {
    return error.message;
  }
  return 'malformed error response';
}

/**
 * Extract the JSON-RPC response from a Streamable HTTP SSE body.
 *
 * Servers frame each response as one or more SSE events whose `data:` field
 * holds the JSON-RPC message. Multi-line data is concatenated per the SSE
 * spec. Returns the first parseable JSON-RPC message, or null.
 */
export function parseSseJsonRpcPayload(body: string, serverName: string): MCPResponse | null {
  let eventData: string[] = [];
  const flush = (): MCPResponse | null => {
    if (eventData.length === 0) return null;
    const joined = eventData.join('\n');
    eventData = [];
    return safeJsonParse(joined);
  };

  for (const line of body.split(/\r\n|\r|\n/)) {
    if (line === '') {
      const found = flush();
      if (found) return found;
      continue;
    }
    if (line.startsWith(':')) continue; // SSE comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') eventData.push(value);
  }
  const trailing = flush();
  if (trailing) return trailing;

  mcpLog.warn(
    { server: serverName, responseBytes: Buffer.byteLength(body) },
    'MCP SSE response contained no JSON-RPC message',
  );
  return null;
}

/** Read a response body with a hard byte ceiling so a hostile or broken
 *  server cannot exhaust memory. */
export async function readBoundedText(resp: Response, limitBytes: number): Promise<string> {
  const body = resp.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limitBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`MCP response exceeded ${limitBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

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

/**
 * Supplies an `Authorization` header for a remote MCP server, refreshing an
 * expired OAuth grant on demand. Returning null means the user has not
 * authorized this server yet.
 */
export type McpAuthHeaderResolver = () => Promise<Record<string, string> | null>;

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
  /** Streamable HTTP session id handed out by a 2025-era server's initialize
   *  response. The 2026-07-28 stateless flow does not use one. */
  private httpSessionId: string | null = null;
  /** Set when the server answered 401 and no usable OAuth grant exists. The
   *  settings UI turns this into an "Authorize" affordance. */
  needsAuthorization = false;
  /** The `WWW-Authenticate` challenge from the last 401, used to drive
   *  discovery. Server-controlled, so never logged verbatim. */
  private authorizationChallenge: string | null = null;
  /** Last connection error, surfaced in listServers() for the UI. */
  lastError: string | undefined;

  constructor(
    private config: MCPServerConfig,
    /**
     * Supplies a fresh `Authorization` header per request, refreshing an expired
     * OAuth grant when needed. Returning null means "no usable grant" — the
     * client then reports that the server needs authorization instead of
     * silently retrying unauthenticated.
     */
    private resolveAuthHeaders?: McpAuthHeaderResolver,
  ) {
    this.serverName = config.name;
  }

  /** The raw challenge header, for the OAuth service to start discovery. */
  get authorizationChallengeHeader(): string | null {
    return this.authorizationChallenge;
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

  /**
   * Perform one Streamable HTTP JSON-RPC round trip.
   *
   * Streamable HTTP is a SINGLE endpoint: every JSON-RPC method is POSTed to
   * the configured URL verbatim, with the method name carried in the
   * `Mcp-Method` header. Appending `/initialize`, `/tools/list` or
   * `/tools/call` to the URL — as this client used to — 404s against every
   * real hosted server.
   *
   * Servers answer with either `application/json` or an SSE stream
   * (`text/event-stream`) whose `data:` lines carry the JSON-RPC response, so
   * both encodings are decoded. `Mcp-Session-Id` is captured from the
   * initialize response and echoed on later requests for 2025-era servers.
   *
   * Non-2xx responses are returned (not thrown) so callers can report the
   * status; only transport/parse failures throw.
   *
   * A 401 is handled here rather than by callers: the challenge is recorded so
   * the settings UI can offer authorization, and the request is retried exactly
   * once with a freshly resolved bearer token (refreshing an expired grant).
   * Retrying is bounded to a single attempt so a permanently rejected token
   * cannot spin.
   */
  private async httpRpc(
    method: string,
    params: unknown,
    options: { notify?: boolean; headers?: Record<string, string> } = {},
    authAttempt: 'initial' | 'retry' = 'initial',
  ): Promise<{ status: number; response: MCPResponse | null }> {
    const url = this.config.url;
    if (!url) throw new Error(`MCP server ${this.serverName}: url is required for SSE transport`);

    // Resolve the bearer token up front so every request in the handshake
    // carries it, not just tools/call.
    let authHeaders: Record<string, string> = {};
    if (this.resolveAuthHeaders) {
      authHeaders = (await this.resolveAuthHeaders()) ?? {};
    }

    const body: Record<string, unknown> = { jsonrpc: '2.0', method };
    // Notifications carry no id — they are fire-and-forget.
    if (!options.notify) body.id = ++this.requestId;
    if (params !== undefined) body.params = params;
    // 2026-07-28 is stateless: version + identity ride along per request. The
    // 2025-era handshake gets them once, in initialize.
    if (this.protocolVersion === CURRENT_PROTOCOL_VERSION) {
      body._meta = {
        'io.modelcontextprotocol/protocolVersion': this.protocolVersion,
        'io.modelcontextprotocol/clientInfo': { name: 'koryphaios', version: VERSION },
        'io.modelcontextprotocol/clientCapabilities': {},
      };
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Both encodings must be advertised or strict servers reject the call.
        Accept: 'application/json, text/event-stream',
        'Mcp-Method': method,
        'Mcp-Name': '',
        ...(this.httpSessionId ? { 'Mcp-Session-Id': this.httpSessionId } : {}),
        ...authHeaders,
        ...(this.config.headers ?? {}),
        ...(options.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MCP_HTTP_TIMEOUT_MS),
    });

    if (resp.status === 401) {
      // Keep the challenge so the UI can start discovery from the server's own
      // advertised metadata URL rather than guessing.
      this.authorizationChallenge = resp.headers.get('www-authenticate');
      this.needsAuthorization = true;
      if (authAttempt === 'initial') {
        // A grant may have been issued (or refreshed) since we last looked.
        const refreshed = this.resolveAuthHeaders ? ((await this.resolveAuthHeaders()) ?? {}) : {};
        if (Object.keys(refreshed).length > 0) {
          const hadAuth = Object.keys(authHeaders).length > 0;
          // Only retry when the token actually changed; otherwise we would loop
          // on a token the server keeps rejecting.
          if (JSON.stringify(refreshed) !== JSON.stringify(authHeaders) || !hadAuth) {
            mcpLog.info(
              { server: this.serverName, method },
              'MCP request retried with a refreshed OAuth token after 401',
            );
            return this.httpRpc(method, params, options, 'retry');
          }
        }
      }
      mcpLog.warn(
        { server: this.serverName, method },
        'MCP server rejected the request as unauthorized',
      );
    }

    const sessionId = resp.headers.get('mcp-session-id');
    if (sessionId) this.httpSessionId = sessionId;

    // 202 / 204 carry no body (accepted-notification responses).
    if (resp.status === 202 || resp.status === 204) {
      return { status: resp.status, response: null };
    }
    if (!resp.ok) {
      return { status: resp.status, response: null };
    }
    if (this.needsAuthorization && Object.keys(authHeaders).length > 0) {
      this.needsAuthorization = false;
      this.authorizationChallenge = null;
    }

    const raw = await readBoundedText(resp, MCP_HTTP_MAX_RESPONSE_BYTES);
    if (!raw.trim()) return { status: resp.status, response: null };

    const contentType = resp.headers.get('content-type') ?? '';
    const payload = contentType.includes('text/event-stream')
      ? parseSseJsonRpcPayload(raw, this.serverName)
      : safeJsonParse(raw);

    if (!payload) {
      throw new Error(
        `MCP server ${this.serverName}: ${method} returned an unparseable ${contentType || 'unknown'} response`,
      );
    }
    if (!isJsonRpcResponse(payload)) {
      // A well-formed JSON body that is not a JSON-RPC envelope (a proxy/gateway
      // error page, a login redirect, …). Report it as a transport failure so
      // the caller surfaces the HTTP status rather than "undefined".
      mcpLog.warn(
        { server: this.serverName, method, status: resp.status },
        'MCP endpoint returned a non-JSON-RPC body',
      );
      return { status: resp.status, response: null };
    }
    return { status: resp.status, response: payload };
  }

  private async connectSSE(): Promise<void> {
    // Streamable HTTP transport — connect to HTTP endpoint.
    const { url } = this.config;
    if (!url) throw new Error(`MCP server ${this.serverName}: url is required for SSE transport`);

    // ── Protocol negotiation via server/discover ──────────────────────────
    let discovered = false;
    try {
      const { status, response } = await this.httpRpc('server/discover', {});
      if (status === 200 && response) {
        const discover = response.result as MCPDiscoverResult | undefined;
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
      // Legacy 2025-11-25 initialize over HTTP. send `Mcp-Protocol-Version` so
      // servers that validate it accept the handshake.
      this.protocolVersion = LEGACY_PROTOCOL_VERSION;
      const { status, response } = await this.httpRpc('initialize', {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: { roots: { listChanged: false } },
        clientInfo: { name: 'koryphaios', version: VERSION },
      });
      if (status !== 200 || !response) {
        throw new Error(
          this.needsAuthorization
            ? `MCP server ${this.serverName} requires authorization before it can be used`
            : `MCP server ${this.serverName}: initialization failed (HTTP ${status})`,
        );
      }
      if (response.error) {
        throw new Error(
          `MCP server ${this.serverName}: initialization failed (${jsonRpcErrorMessage(response)})`,
        );
      }
      this.serverCapabilities =
        (response.result as { capabilities?: Record<string, unknown> } | undefined)?.capabilities ??
        {};
      // 2025-era servers require the initialized notification before tools/list.
      await this.httpRpc('notifications/initialized', undefined, { notify: true });
    }

    // List tools
    const { status, response } = await this.httpRpc('tools/list', {});
    if (status !== 200 || !response) {
      throw new Error(
        this.needsAuthorization
          ? `MCP server ${this.serverName} requires authorization before it can be used`
          : `MCP server ${this.serverName}: tools/list failed (HTTP ${status})`,
      );
    }
    if (response.error) {
      throw new Error(
        `MCP server ${this.serverName}: tools/list failed (${jsonRpcErrorMessage(response)})`,
      );
    }
    const result = response.result as
      { tools?: MCPToolDef[]; ttlMs?: number; cacheScope?: string } | undefined;
    this.tools = result?.tools ?? [];

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
        // Streamable HTTP transport — single endpoint, method in the header.
        const { status, response } = await this.httpRpc('tools/call', {
          name,
          arguments: args,
        });

        if (status !== 200 || !response) {
          return {
            content: [{ type: 'text', text: `MCP HTTP Error: ${status}` }],
            isError: true,
          };
        }
        if (response.error) {
          return {
            content: [{ type: 'text', text: `MCP Error: ${jsonRpcErrorMessage(response)}` }],
            isError: true,
          };
        }
        return (response.result ?? { content: [] }) as MCPToolResult;
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
        const processHandle = this.process;
        if (!processHandle) {
          this.pending.delete(id);
          clearTimeout(timeout);
          reject(new Error('MCP stdio process is no longer available'));
          return;
        }
        try {
          this.writeStdioMessage(processHandle, JSON.stringify(request) + '\n');
        } catch (error: unknown) {
          // A child can close its stdin between the liveness check and the
          // write. Fail the transport and every waiter immediately instead of
          // leaking a pending request until the 30-second request timeout.
          const failure = new Error('MCP stdio request write failed');
          this.failStdioTransport(processHandle, failure);
          if (this.pending.delete(id)) {
            clearTimeout(timeout);
            reject(failure);
          }
        }
      }
    });
  }

  private notify(method: string, params: unknown): void {
    const notification = { jsonrpc: '2.0', method, params };
    const processHandle = this.process;
    if (this.config.transport === 'stdio' && processHandle) {
      try {
        this.writeStdioMessage(processHandle, JSON.stringify(notification) + '\n');
      } catch {
        this.failStdioTransport(processHandle, new Error('MCP stdio notification write failed'));
      }
    }
  }

  private writeStdioMessage(processHandle: ReturnType<typeof Bun.spawn>, payload: string): void {
    const stdin = processHandle.stdin as unknown as {
      write: (chunk: string | Uint8Array) => void;
      flush: () => void;
    } | null;
    if (!stdin || this.process !== processHandle) {
      throw new Error('MCP stdio process is no longer available');
    }
    stdin.write(payload);
    stdin.flush();
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
    readonly projectRoot: string = process.cwd(),
  ) {}

  get mcpServerName() { return this.client.name; }
  get mcpToolName() { return this.def.name; }

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
    if (mcpProjectScope(ctx.settingsRoot ?? ctx.workingDirectory) !== mcpProjectScope(this.projectRoot)) {
      return { callId: input.id, name: this.name, output: 'MCP tool is not registered for this project.', isError: true, durationMs: 0 };
    }
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
        images: result.isError
          ? []
          : validatedToolImages(result.content.filter((c) => c.type === 'image')),
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
  private discoveryPending = new Map<string, Promise<void>>();
  private discoveryFailures = new Map<string, { signature: string; at: number }>();

  constructor(private workingDirectory: string) {}

  async ensureConfiguredServers(configs: MCPServerConfig[], registry: ToolRegistry, projectRoot: string): Promise<void> {
    for (const config of configs) {
      const key = this.scopeKey(config.name, projectRoot);
      if (this.clients.has(key)) continue;
      const signature = createHash('sha256').update(JSON.stringify(config)).digest('hex');
      const failure = this.discoveryFailures.get(key);
      if (failure?.signature === signature && Date.now() - failure.at < 30_000) continue;
      let pending = this.discoveryPending.get(key);
      if (!pending) {
        pending = this.addServer(config, registry, projectRoot).then(() => {
          this.discoveryFailures.delete(key);
        }).catch(() => {
          this.discoveryFailures.set(key, { signature, at: Date.now() });
          mcpLog.warn({ server: config.name }, 'Configured MCP server unavailable; discovery will retry');
        }).finally(() => this.discoveryPending.delete(key));
        this.discoveryPending.set(key, pending);
      }
      await pending;
    }
  }

  private scopeKey(name: string, projectRoot = this.workingDirectory): string {
    return `${mcpProjectScope(projectRoot)}\u0000${name}`;
  }

  /**
   * Build the per-request auth resolver for a server.
   *
   * Only remote (streamable HTTP) servers use OAuth. The resolver asks the OAuth
   * service for a current bearer token, which refreshes an expired grant when a
   * refresh token is available and returns null when the user has not authorized
   * the server yet — which is what puts the client into its
   * "requires authorization" state instead of failing opaquely.
   */
  private authResolverFor(
    config: MCPServerConfig,
    projectRoot: string,
  ): McpAuthHeaderResolver | undefined {
    if (config.transport === 'stdio') return undefined;
    return async () => {
      const { ensureAccessToken } = await import('./oauth-service');
      return ensureAccessToken(projectRoot, config.name);
    };
  }

  async connectServer(
    config: MCPServerConfig,
    projectRoot = this.workingDirectory,
  ): Promise<MCPClient> {
    const key = this.scopeKey(config.name, projectRoot);
    const client = new MCPClient(config, this.authResolverFor(config, projectRoot));
    try { await client.connect(); } catch (error) { await client.shutdown(); throw error; }
    this.clients.set(key, client);
    return client;
  }

  /** Connect a new server and register its tools immediately (hot-add). */
  async addServer(
    config: MCPServerConfig,
    registry: ToolRegistry,
    projectRoot = this.workingDirectory,
  ): Promise<MCPClient> {
    const key = this.scopeKey(config.name, projectRoot);
    // If a server with this name exists, shut it down first (replace semantics).
    const existing = this.clients.get(key);
    if (existing) {
      await existing.shutdown();
      registry.unregisterMcpServer(config.name, projectRoot);
      this.clients.delete(key);
    }
    const client = new MCPClient(config, this.authResolverFor(config, projectRoot));
    try { await client.connect(); } catch (error) { await client.shutdown(); throw error; }
    this.clients.set(key, client);
    await registerMCPToolsInRegistry(registry, client, projectRoot);
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
    registry.unregisterMcpServer(name, projectRoot);
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
    const existing = this.clients.get(key);
    if (existing) {
      await existing.shutdown();
      registry.unregisterMcpServer(name, projectRoot);
      this.clients.delete(key);
    }
    return this.addServer(config, registry, projectRoot);
  }

  /** Snapshot of all servers for UI status display. */
  listServers(projectRoot?: string): McpServerStatus[] {
    const scope = projectRoot === undefined ? null : `${mcpProjectScope(projectRoot)}\u0000`;
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
    for (const [key, client] of this.clients) {
      await registerMCPToolsInRegistry(registry, client, key.slice(0, key.indexOf('\u0000')));
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
 *
 * `projectRoot` scopes the manager's clients AND their OAuth grants. It must be
 * the same root the settings API uses (`getRequestProjectRoot`), otherwise a
 * server is registered under one project scope while its stored OAuth token is
 * looked up in another and every request comes back 401.
 */
export async function initMCP(
  config: MCPInitConfig,
  tools: ToolRegistry,
  projectRoot: string = process.cwd(),
): Promise<MCPManager> {
  const manager = new MCPManager(projectRoot);
  const servers = config.mcpServers || {};

  for (const [name, serverConfig] of Object.entries(servers)) {
    try {
      const cfg = serverConfig;
      await manager.connectServer(
        {
          name,
          ...cfg,
          // Normalize "type" field to "transport" (config files use "type")
          transport: (cfg.transport ?? cfg.type ?? 'stdio') as 'stdio' | 'sse',
        },
        projectRoot,
      );
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
