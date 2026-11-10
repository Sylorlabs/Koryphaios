// OpenCode ACP (Agent Client Protocol) client.
//
// ACP is the open standard protocol implemented by `opencode acp` (verified live
// against `opencode --version` 2.0.32, protocolVersion 1). It is JSON-RPC 2.0 over
// stdio, newline-delimited:
//
//   initialize           -> { protocolVersion, agentCapabilities, authMethods }
//   session/new          -> { sessionId, configOptions }   (model/effort/mode selects)
//   session/prompt       -> streaming session/update notifications, then a response
//   session/set_config_option -> { configOptions }         (switch model/effort/mode)
//   session/cancel       -> (notification) cancel the active turn
//   session/close        -> dispose the session
//   session/request_permission -> (server→client request; only when the user's
//                                OpenCode permission rules ask)
//
// Streaming notifications arrive as `session/update` with
// `params.update.sessionUpdate` ∈ { agent_message_chunk, agent_thought_chunk,
// tool_call, tool_call_update, plan, usage_update, available_commands_update, … }.
//
// This module is the transport layer. The opencode provider consumes it and maps
// events onto Koryphaios ProviderEvents. Nothing here reads credentials or config;
// the spawned CLI resolves its own login and catalog from the user's environment.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { providerLog } from '../logger';
import { safeProviderDiagnostic, safeProviderFailureMessage } from './provider-diagnostics';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AcpStdioMcpServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type AcpPromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

export interface AcpConfigOption {
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue?: string;
  options?: Array<{ value: string; name?: string; description?: string }>;
  description?: string;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: {
    loadSession?: boolean;
    mcpCapabilities?: { http?: boolean; sse?: boolean };
    promptCapabilities?: { image?: boolean; embeddedContext?: boolean };
    sessionCapabilities?: Record<string, unknown>;
  };
}

export interface AcpNewSessionResult {
  sessionId: string;
  configOptions?: AcpConfigOption[];
}

export interface AcpPromptResult {
  stopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    thoughtTokens?: number;
  };
}

export type AcpSessionEvent =
  | { type: 'agent_message_chunk'; text: string }
  | { type: 'agent_thought_chunk'; text: string }
  | {
      type: 'tool_call';
      toolCallId: string;
      name: string;
      title?: string;
      kind?: string;
      status?: string;
      rawInput?: Record<string, unknown>;
      locations?: Array<{ path?: string }>;
    }
  | {
      type: 'tool_call_update';
      toolCallId: string;
      name?: string;
      title?: string;
      kind?: string;
      status?: string;
      rawInput?: Record<string, unknown>;
      content?: Array<{ type: string; content?: { type: string; text?: string } }>;
      rawOutput?: unknown;
      locations?: Array<{ path?: string }>;
    }
  | {
      type: 'usage_update';
      used?: number;
      size?: number;
      cost?: { amount?: number; currency?: string };
    }
  | { type: 'available_commands_update' }
  | { type: 'unknown'; sessionUpdate: string };

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall?: {
    toolCallId?: string;
    name?: string;
    title?: string;
    kind?: string;
    status?: string;
    rawInput?: Record<string, unknown>;
  };
  options?: Array<{ optionId: string; name?: string; kind?: string }>;
}

export type AcpPermissionDecision =
  /** Select the first allow option; fall back to approving once by kind. */
  { action: 'allow' }
  /** Select the first reject option; fall back to cancelled. */
  | { action: 'reject' };

/** Kinds that never mutate the machine. Everything else (edit/delete/move/execute)
 *  is rejected at the ACP layer; Koryphaios tool calls flow through the kory MCP
 *  bridge, which is enforced by Kory's permission policy. 'other' is allowed
 *  because OpenCode dispatches its MCP code-mode tools under that kind and the
 *  bridge remains the real enforcement point for them. */
const ACP_READONLY_KINDS = new Set(['read', 'search', 'fetch', 'think', 'other', 'switch_mode']);

export function decideAcpPermission(request: AcpPermissionRequest): AcpPermissionDecision {
  const kind = (request.toolCall?.kind ?? 'other').toLowerCase();
  if (ACP_READONLY_KINDS.has(kind)) return { action: 'allow' };
  return { action: 'reject' };
}

/** Pick the option id the client should answer with for a decision. */
export function pickAcpPermissionOption(
  decision: AcpPermissionDecision,
  options: AcpPermissionRequest['options'] | undefined,
): { optionId?: string; cancelled?: boolean } {
  const list = options ?? [];
  const isAllow = (kind: string) => kind.startsWith('allow');
  const isReject = (kind: string) => kind.startsWith('reject');
  if (decision.action === 'allow') {
    const allow = list.find((o) => o.kind && isAllow(o.kind.toLowerCase()));
    return allow ? { optionId: allow.optionId } : { cancelled: true };
  }
  const reject = list.find((o) => o.kind && isReject(o.kind.toLowerCase()));
  return reject ? { optionId: reject.optionId } : { cancelled: true };
}

export interface OpenCodeAcpClientOptions {
  /** Executable to spawn (the CLI itself, or the OS sandbox wrapper). */
  command: string;
  /** Arguments for the executable — ['acp'] for a direct spawn. */
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timeout?: NodeJS.Timeout;
};

const REQUEST_TIMEOUT_MS = 30_000;

export class OpenCodeAcpClient {
  private child: ChildProcess | null = null;
  private pending = new Map<string, PendingRequest>();
  private buffer = '';
  private stderr = '';
  private initialized = false;
  private promptHandler: ((event: AcpSessionEvent) => void) | null = null;
  private promptSessionId: string | null = null;
  private lastSessionId: string | null = null;
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: OpenCodeAcpClientOptions) {
    this.command = opts.command;
    this.args = opts.args;
    this.cwd = opts.cwd;
    this.env = opts.env;
  }

  /** Spawn the ACP server and perform the protocol handshake. */
  async connect(): Promise<AcpInitializeResult> {
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = appendDiagnostic(this.stderr, chunk);
    });
    this.child.on('exit', () => {
      this.rejectAllPending(new Error(this.diagnostic('acp process exited before the turn completed')));
    });

    const result = (await this.sendRequest('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'koryphaios', version: '1.0.0' },
    })) as AcpInitializeResult;
    this.initialized = true;
    return result;
  }

  /** Create a session. Returns the ACP session id and its config options. */
  async newSession(opts: {
    cwd: string;
    mcpServers?: AcpStdioMcpServer[];
  }): Promise<AcpNewSessionResult> {
    this.assertConnected();
    const result = (await this.sendRequest('session/new', {
      cwd: opts.cwd,
      mcpServers: (opts.mcpServers ?? []).map((server) => ({
        name: server.name,
        command: server.command,
        args: server.args ?? [],
        env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
      })),
    })) as AcpNewSessionResult;
    if (!result?.sessionId) {
      throw new Error('OpenCode ACP: session/new did not return a sessionId');
    }
    this.lastSessionId = result.sessionId;
    return { sessionId: result.sessionId, configOptions: result.configOptions ?? [] };
  }

  /** Set a session config option (model, effort, mode). Returns the updated options. */
  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<AcpConfigOption[]> {
    this.assertConnected();
    const result = (await this.sendRequest('session/set_config_option', {
      sessionId,
      configId,
      value,
    })) as { configOptions?: AcpConfigOption[] };
    return result?.configOptions ?? [];
  }

  /**
   * Send one user prompt and stream its events. Resolves with the turn's stop
   * reason and usage. Notifications are delivered to `onEvent` until the turn
   * settles.
   */
  async prompt(
    sessionId: string,
    blocks: AcpPromptBlock[],
    onEvent: (event: AcpSessionEvent) => void,
  ): Promise<AcpPromptResult> {
    this.assertConnected();
    if (this.promptHandler) {
      throw new Error('OpenCode ACP: a prompt turn is already in flight on this client');
    }
    this.promptHandler = onEvent;
    this.promptSessionId = sessionId;
    try {
      // No fixed RPC timeout: a turn can legitimately run for minutes with no
      // intermediate response. The caller bounds the turn (and aborts it) — the
      // janitor here only rejects when the transport actually dies.
      const result = (await this.sendRequest(
        'session/prompt',
        {
          sessionId,
          prompt: blocks,
        },
        0,
      )) as AcpPromptResult;
      return result ?? {};
    } finally {
      this.promptHandler = null;
      this.promptSessionId = null;
    }
  }

  /** Ask the agent to cancel the active turn (best effort). */
  cancel(sessionId: string): void {
    this.child?.stdin?.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })}\n`,
    );
  }

  /** Dispose the session (best effort) and shut the child down. */
  async disconnect(): Promise<void> {
    if (this.child && this.initialized) {
      // session/close is per ACP; ignore failures — process exit reaps state.
      try {
        if (this.lastSessionId) {
          await Promise.race([
            this.sendRequest('session/close', { sessionId: this.lastSessionId }),
            new Promise((resolve) => setTimeout(resolve, 2_000)),
          ]);
        }
      } catch {
        /* best effort */
      }
    }
    this.child?.stdin?.end();
    this.child?.kill('SIGTERM');
    this.child = null;
    this.initialized = false;
    this.rejectAllPending(new Error('OpenCode ACP client disconnected'));
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private assertConnected(): void {
    if (!this.child?.stdin?.writable) {
      throw new Error('OpenCode ACP process is not connected');
    }
  }

  private sendRequest(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin?.writable) {
        reject(new Error('OpenCode ACP process is not connected'));
        return;
      }
      const id = randomUUID();
      const req = { jsonrpc: '2.0' as const, id, method, params };
      const timeout =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`OpenCode ACP request ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(`${JSON.stringify(req)}\n`);
    });
  }

  private sendResponse(id: string, result: unknown): void {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        providerLog.debug(
          safeProviderDiagnostic('opencode', 'stdout', line),
          'opencode acp: skipping non-JSON stdout line',
        );
        continue;
      }
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? String(msg.id) : null;
    const method = typeof msg.method === 'string' ? msg.method : null;

    // Response to one of our requests.
    if (id && this.pending.has(id)) {
      const pending = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      const error = msg.error as { message?: string } | undefined;
      if (error) {
        pending.reject(new Error(error.message ?? `OpenCode ACP request failed: ${id}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Server→client request (permission prompt). Never block the turn on it.
    if (id && method === 'session/request_permission') {
      const params = (msg.params ?? {}) as AcpPermissionRequest;
      const decision = decideAcpPermission(params);
      const picked = pickAcpPermissionOption(decision, params.options);
      providerLog.info(
        {
          kind: params.toolCall?.kind,
          title: params.toolCall?.title ?? params.toolCall?.name,
          decision: decision.action,
        },
        'opencode acp: answered session/request_permission',
      );
      this.sendResponse(
        id,
        picked.cancelled ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId: picked.optionId } },
      );
      return;
    }

    // Streaming notification (session/update & friends).
    if (method === 'session/update') {
      const params = msg.params as { sessionId?: string; update?: Record<string, unknown> } | undefined;
      const update = params?.update;
      const handler = this.promptHandler;
      if (!update || !handler) return;
      const event = mapSessionUpdate(update);
      if (event) handler(event);
      return;
    }

    if (method && !id) {
      providerLog.debug({ method }, 'opencode acp: ignoring unsupported notification');
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private diagnostic(fallback: string): string {
    return safeProviderFailureMessage(
      'opencode',
      safeProviderDiagnostic('opencode', 'stderr', this.stderr || fallback),
    );
  }
}

function appendDiagnostic(buffer: string, chunk: Buffer): string {
  const next = buffer + chunk.toString();
  return next.length > 16_000 ? next.slice(-16_000) : next;
}

/** Translate one `session/update` into a typed event. Returns null for kinds the
 *  adapter does not consume (available_commands_update is still surfaced so the
 *  caller may log it). Exported for tests. */
export function mapSessionUpdate(update: Record<string, unknown>): AcpSessionEvent | null {
  const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';
  const record = update as Record<string, unknown>;
  switch (kind) {
    case 'agent_message_chunk': {
      const content = record.content as { text?: string } | undefined;
      const text = typeof content?.text === 'string' ? content.text : '';
      return text ? { type: 'agent_message_chunk', text } : null;
    }
    case 'agent_thought_chunk': {
      const content = record.content as { text?: string } | undefined;
      const text = typeof content?.text === 'string' ? content.text : '';
      return text ? { type: 'agent_thought_chunk', text } : null;
    }
    case 'tool_call': {
      const toolCallId = typeof record.toolCallId === 'string' ? record.toolCallId : '';
      if (!toolCallId) return null;
      return {
        type: 'tool_call',
        toolCallId,
        name: typeof record.name === 'string' ? record.name : '',
        title: typeof record.title === 'string' ? record.title : undefined,
        kind: typeof record.kind === 'string' ? record.kind : undefined,
        status: typeof record.status === 'string' ? record.status : undefined,
        rawInput: isRecord(record.rawInput) ? record.rawInput : undefined,
        locations: normalizeLocations(record.locations),
      };
    }
    case 'tool_call_update': {
      const toolCallId = typeof record.toolCallId === 'string' ? record.toolCallId : '';
      if (!toolCallId) return null;
      return {
        type: 'tool_call_update',
        toolCallId,
        name: typeof record.name === 'string' ? record.name : undefined,
        title: typeof record.title === 'string' ? record.title : undefined,
        kind: typeof record.kind === 'string' ? record.kind : undefined,
        status: typeof record.status === 'string' ? record.status : undefined,
        rawInput: isRecord(record.rawInput) ? record.rawInput : undefined,
        content: normalizeContent(record.content),
        rawOutput: record.rawOutput,
        locations: normalizeLocations(record.locations),
      };
    }
    case 'usage_update': {
      const cost = isRecord(record.cost) ? record.cost : undefined;
      return {
        type: 'usage_update',
        used: typeof record.used === 'number' ? record.used : undefined,
        size: typeof record.size === 'number' ? record.size : undefined,
        cost: cost
          ? {
              amount: typeof cost.amount === 'number' ? cost.amount : undefined,
              currency: typeof cost.currency === 'string' ? cost.currency : undefined,
            }
          : undefined,
      };
    }
    case 'available_commands_update':
      return { type: 'available_commands_update' };
    default:
      return { type: 'unknown', sessionUpdate: kind };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeLocations(value: unknown): Array<{ path?: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const locations = value
    .map((entry) => (isRecord(entry) && typeof entry.path === 'string' ? { path: entry.path } : null))
    .filter((entry): entry is { path: string } => !!entry);
  return locations.length > 0 ? locations : undefined;
}

function normalizeContent(
  value: unknown,
): Array<{ type: string; content?: { type: string; text?: string } }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Array<{ type: string; content?: { type: string; text?: string } }> = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const content = isRecord(entry.content) ? entry.content : undefined;
    out.push({
      type: typeof entry.type === 'string' ? entry.type : 'content',
      content: content
        ? {
            type: typeof content.type === 'string' ? content.type : 'text',
            text: typeof content.text === 'string' ? content.text : undefined,
          }
        : undefined,
    });
  }
  return out;
}
