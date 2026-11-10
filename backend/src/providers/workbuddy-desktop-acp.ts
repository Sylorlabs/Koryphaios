// WorkBuddy Desktop ACP client — Agent Client Protocol over HTTP SSE.
//
// The desktop runtime (`codebuddy --serve`) exposes ACP at /api/v1/acp:
//   POST /api/v1/acp/connect            → { connectionId, sessionToken }
//   GET  /api/v1/acp  (acp-connection-id) → SSE stream of JSON-RPC
//                                            session/update notifications
//   POST /api/v1/acp  (acp-connection-id) → JSON-RPC request; the response
//                                            is itself an SSE stream that
//                                            carries the JSON-RPC result
//                                            plus any sessionUpdate
//                                            notifications for that turn
//   DELETE /api/v1/acp (acp-connection-id) → disconnect
//
// Session updates (session/update notifications) use these `update.sessionUpdate`
// kinds: agent_message_chunk, agent_thought_chunk, user_message_chunk,
// tool_call, tool_call_update, interruption_request, session_end,
// session_info_update, model_update, mode_update, current_mode_update,
// config_option_update, available_commands_update, plan.

import { providerLog } from '../logger';

const CONNECT_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10 * 60_000;
const SSE_DRAIN_TIMEOUT_MS = 5_000;

export interface AcpInitializeResult {
  connectionId?: string;
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
  agentCapabilities?: { loadSession?: boolean; delegateToolsSupport?: boolean };
}

export interface AcpSessionModels {
  availableModels: Array<{ modelId: string; name?: string }>;
  currentModelId?: string;
}

export interface AcpSessionModes {
  availableModes: Array<{ id: string; name?: string }>;
  currentModeId?: string;
}

export interface AcpConfigOption {
  type: string;
  id: string;
  name?: string;
  category?: string;
  currentValue?: string;
  options?: Array<{ value?: string; name?: string }>;
}

export interface AcpSessionNewParams {
  cwd: string;
  /** ACP stdio server entries: env is an array of {name, value}. `type` is the
   *  discriminator the runtime's own mcp config uses; see sessionNew(). */
  mcpServers?: Array<{
    type?: 'stdio';
    name: string;
    command: string;
    args: string[];
    env: Array<{ name: string; value: string }>;
  }>;
}

export interface AcpSessionNewResult {
  sessionId: string;
  models?: AcpSessionModels;
  modes?: AcpSessionModes;
  configOptions?: AcpConfigOption[];
}

export interface AcpPromptResult {
  stopReason?: string;
  errorMessage?: string;
  /** Extension metadata. The runtime reports its failure detail here as
   *  `codebuddy.ai/errorMessage` (a JSON string with code/message/details). */
  _meta?: Record<string, unknown>;
}

/** One session/update notification, normalized. */
export interface AcpSessionUpdate {
  sessionId?: string;
  update: {
    sessionUpdate: string;
    [key: string]: unknown;
  };
}

export type AcpNotificationHandler = (update: AcpSessionUpdate) => void;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

function isJsonRpcResponse(msg: JsonRpcMessage): boolean {
  return msg.id !== undefined && msg.id !== null && ('result' in msg || 'error' in msg);
}

/** Read an SSE/NDJSON response body and invoke `onMessage` for every JSON
 *  message; resolves with the JSON-RPC response matching `wantId` (or null
 *  when the stream ends first). */
async function readJsonRpcStream(
  response: Response,
  wantId: number,
  onMessage: (msg: JsonRpcMessage) => void,
): Promise<JsonRpcMessage | null> {
  const body = response.body;
  if (!body) return null;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let matched: JsonRpcMessage | null = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // The server speaks NDJSON; tolerate SSE `data:` framing too.
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data:')) line = line.slice(5).trim();
        if (!line || line === '[DONE]') continue;
        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(line) as JsonRpcMessage;
        } catch {
          continue;
        }
        onMessage(msg);
        if (isJsonRpcResponse(msg) && msg.id === wantId) matched = msg;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return matched;
}

export class WorkBuddyDesktopAcpClient {
  private connectionId: string | null = null;
  private abortController: AbortController | null = null;
  private nextId = 1;
  private notificationHandlers = new Set<AcpNotificationHandler>();
  private sseAbort: AbortController | null = null;
  /** True while a prompt's POST stream is the authoritative event source. */
  private promptActive = false;

  constructor(private readonly baseUrl: string) {}

  get connected(): boolean {
    return this.connectionId !== null;
  }

  onNotification(handler: AcpNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  /** POST /api/v1/acp/connect, then open the persistent SSE notification
   *  stream. Notifications arriving on either the GET stream or a POST
   *  response stream are dispatched to handlers. */
  async connect(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'x-codebuddy-request': '1',
      },
      body: '{}',
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`ACP connect failed (HTTP ${response.status})`);
    }
    const parsed = (await response.json()) as { connectionId?: string };
    if (!parsed.connectionId) throw new Error('ACP connect returned no connectionId');
    this.connectionId = parsed.connectionId;
    this.abortController = new AbortController();
    void this.pumpNotifications();
  }

  private async pumpNotifications(): Promise<void> {
    const controller = new AbortController();
    this.sseAbort = controller;
    try {
      const response = await fetch(this.baseUrl, {
        method: 'GET',
        headers: {
          'acp-connection-id': this.connectionId ?? '',
          Accept: 'application/json, text/event-stream',
          'x-codebuddy-request': '1',
        },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          let line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line.startsWith('data:')) line = line.slice(5).trim();
          if (!line || line === '[DONE]') continue;
          try {
            this.dispatch(JSON.parse(line) as JsonRpcMessage);
          } catch {
            /* skip non-JSON keepalives */
          }
        }
      }
    } catch {
      /* stream ended or aborted — reconnect is the caller's call */
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (msg.method !== 'session/update' || !msg.params) return;
    // While a prompt is streaming, the POST response stream is the source of
    // turn events; the GET stream only carries out-of-band notifications
    // (team broadcasts, …). Dispatching both would duplicate every delta.
    if (this.promptActive) return;
    const params = msg.params as unknown as AcpSessionUpdate;
    if (!params.update || typeof params.update.sessionUpdate !== 'string') return;
    for (const handler of this.notificationHandlers) {
      try {
        handler(params);
      } catch (err: unknown) {
        providerLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'workbuddy-desktop: ACP notification handler threw',
        );
      }
    }
  }

  /**
   * Run a prompt and stream its session updates as they arrive. The POST
   * response is an SSE stream carrying the turn's notifications followed by
   * the JSON-RPC result, so deltas are yielded live instead of buffered
   * until the turn ends. `promptActive` suppresses the GET pump's duplicate
   * dispatch for the duration.
   */
  async *promptStream(
    sessionId: string,
    prompt: Array<{ type: string; [key: string]: unknown }>,
  ): AsyncGenerator<{ update?: AcpSessionUpdate; result?: AcpPromptResult }> {
    if (!this.connectionId) throw new Error('ACP client not connected');
    const id = this.nextId++;
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'session/prompt',
      params: { sessionId, prompt },
    });
    this.promptActive = true;
    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'acp-connection-id': this.connectionId,
          Accept: 'application/json, text/event-stream',
          'x-codebuddy-request': '1',
        },
        body: payload,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `ACP session/prompt failed (HTTP ${response.status})${text ? `: ${text.slice(0, 300)}` : ''}`,
        );
      }
      const body = response.body;
      if (!body) throw new Error('ACP session/prompt returned no body');
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let result: AcpPromptResult | null = null;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf('\n')) !== -1) {
            let line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line.startsWith('data:')) line = line.slice(5).trim();
            if (!line || line === '[DONE]') continue;
            let msg: JsonRpcMessage;
            try {
              msg = JSON.parse(line) as JsonRpcMessage;
            } catch {
              continue;
            }
            if (msg.method === 'session/update' && msg.params) {
              const params = msg.params as unknown as AcpSessionUpdate;
              if (params.update && typeof params.update.sessionUpdate === 'string') {
                yield { update: params };
              }
              continue;
            }
            if (isJsonRpcResponse(msg) && msg.id === id) {
              if (msg.error) {
                throw new Error(`ACP session/prompt error: ${msg.error.message ?? 'unknown'}`);
              }
              result = (msg.result ?? {}) as AcpPromptResult;
            }
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }
      yield { result: result ?? {} };
    } finally {
      this.promptActive = false;
    }
  }

  /** Send a JSON-RPC request over POST and wait for its response. The POST
   *  response is an SSE stream; it is drained (so mid-turn notifications on
   *  it are not lost) until the matching response arrives or the stream
   *  ends. */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.connectionId) throw new Error('ACP client not connected');
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'acp-connection-id': this.connectionId,
        Accept: 'application/json, text/event-stream',
        'x-codebuddy-request': '1',
      },
      body: payload,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`ACP ${method} failed (HTTP ${response.status})${text ? `: ${text.slice(0, 300)}` : ''}`);
    }
    const matched = await readJsonRpcStream(response, id, (msg) => this.dispatch(msg));
    if (!matched) throw new Error(`ACP ${method} stream ended without a response`);
    if (matched.error) {
      throw new Error(`ACP ${method} error: ${matched.error.message ?? 'unknown'}`);
    }
    return matched.result as T;
  }

  /** Notifications (no id) fire-and-forget over POST. */
  async notify(method: string, params?: unknown): Promise<void> {
    if (!this.connectionId) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
    try {
      await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'acp-connection-id': this.connectionId,
          Accept: 'application/json, text/event-stream',
          'x-codebuddy-request': '1',
        },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      /* cancel is best-effort */
    }
  }

  async initialize(clientName: string, clientVersion: string): Promise<AcpInitializeResult> {
    return this.request<AcpInitializeResult>('initialize', {
      protocolVersion: 1,
      clientInfo: { name: clientName, version: clientVersion },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    });
  }

  /** Open a session, tolerating the runtime's MCP-server schema drift.
   *
   *  Measured against `codebuddy` 2.165.0 (`--serve`, ACP over HTTP SSE): the
   *  `mcpServers` key is **required**, while the entry shape is barely
   *  validated — `type: "stdio"`, `env` as an object rather than an array,
   *  missing `args`, missing `name` and even `mcpServers: null` are all
   *  accepted. A payload with the key absent is the one and only shape that
   *  answers `Invalid params`, which is also what `JSON.stringify` silently
   *  produces when a caller passes `undefined`.
   *
   *  So the key is always sent, and the entry shapes are still walked from
   *  newest to oldest in case a runtime build tightens validation again. Only
   *  `Invalid params` downgrades — any other error (auth, cwd, transport) is a
   *  real failure and propagates unchanged. */
  async sessionNew(params: AcpSessionNewParams): Promise<AcpSessionNewResult> {
    const servers = params.mcpServers ?? [];
    const attempts: unknown[] = [
      { cwd: params.cwd, mcpServers: servers },
      { cwd: params.cwd, mcpServers: servers.map(({ type: _type, ...rest }) => rest) },
      {
        cwd: params.cwd,
        mcpServers: servers.map(({ type: _type, env: _env, ...rest }) => rest),
      },
      // Never omit the key: a tool-less session still needs `mcpServers: []`.
      { cwd: params.cwd, mcpServers: [] },
    ];

    // Keep the first rejection: it names the payload the caller actually
    // wanted to send, which is the useful diagnostic when every shape fails.
    let firstError: unknown;
    for (const [index, attempt] of attempts.entries()) {
      try {
        const result = await this.request<AcpSessionNewResult>('session/new', attempt);
        if (index === attempts.length - 1 && servers.length > 0) {
          // The turn can run, but kory__* tools are gone — say so instead of
          // leaving a silently tool-less agent.
          providerLog.warn(
            { servers: servers.map((server) => server.name) },
            'ACP session/new accepted only a payload without MCP servers; this turn has no kory__ tools',
          );
        }
        return result;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/invalid params/i.test(message)) throw error;
        firstError ??= error;
        if (index < attempts.length - 1) {
          providerLog.debug(
            { attempt: index + 1, of: attempts.length },
            'ACP session/new rejected the MCP payload shape; retrying with an older one',
          );
        }
      }
    }
    throw firstError;
  }

  async sessionPrompt(
    sessionId: string,
    prompt: Array<{ type: string; [key: string]: unknown }>,
  ): Promise<AcpPromptResult> {
    return this.request<AcpPromptResult>('session/prompt', { sessionId, prompt });
  }

  async sessionCancel(sessionId: string): Promise<void> {
    await this.notify('session/cancel', { sessionId });
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.request('session/set_model', { sessionId, modelId });
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.request('session/set_mode', { sessionId, modeId });
  }

  async resolveInterruption(
    sessionId: string,
    toolCallId: string,
    decision: 'allow' | 'deny' | 'allowAll',
  ): Promise<void> {
    await this.request('_codebuddy.ai/resolveInterruption', {
      sessionId,
      toolCallId,
      decision,
    });
  }

  async disconnect(): Promise<void> {
    const id = this.connectionId;
    this.connectionId = null;
    this.sseAbort?.abort();
    this.sseAbort = null;
    this.abortController?.abort();
    this.abortController = null;
    this.notificationHandlers.clear();
    if (!id) return;
    try {
      await fetch(this.baseUrl, {
        method: 'DELETE',
        headers: {
          'acp-connection-id': id,
          Accept: 'application/json, text/event-stream',
          'x-codebuddy-request': '1',
        },
        signal: AbortSignal.timeout(SSE_DRAIN_TIMEOUT_MS),
      });
    } catch {
      /* best effort */
    }
  }
}
