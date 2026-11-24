// Generic ACP client: newline-delimited JSON-RPC 2.0 over a child process's stdio.
//
//   initialize                 -> { protocolVersion, agentCapabilities, authMethods }
//   session/new                -> { sessionId, configOptions }
//   session/set_config_option  -> { configOptions }     (model / effort / mode)
//   session/prompt             -> streaming session/update notifications, then a response
//   session/cancel             -> (notification) cancel the active turn
//   session/close              -> dispose the session
//   session/request_permission -> (agent→client request) answered by the permission profile
//
// This is transport only. It never reads credentials or configuration; the
// spawned agent resolves its own login. Provider adapters (opencode, acp:<id>)
// consume it and map events onto Koryphaios ProviderEvents.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { providerLog } from '../../logger';
import { safeProviderDiagnostic, safeProviderFailureMessage } from '../provider-diagnostics';
import {
  decideAcpPermission,
  isRecord,
  mapSessionUpdate,
  pickAcpPermissionOption,
  type AcpConfigOption,
  type AcpInitializeResult,
  type AcpNewSessionResult,
  type AcpPermissionDecision,
  type AcpPermissionProfile,
  type AcpPermissionRequest,
  type AcpPromptBlock,
  type AcpPromptResult,
  type AcpSessionEvent,
  type AcpStdioMcpServer,
} from './protocol';

export interface AcpClientOptions {
  /** Executable to spawn (the agent itself, or the OS sandbox wrapper). */
  command: string;
  /** Arguments for the executable, e.g. ['acp']. */
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Process seam: defaults to node's spawn; tests may inject a transcript process. */
  spawnChild?: typeof spawn;
  /** Key used in diagnostics and logs (e.g. 'opencode' or 'acp:my-agent'). */
  providerName?: string;
  /** Human label used in error messages (e.g. 'OpenCode'). */
  label?: string;
  /** Permission profile applied to session/request_permission. Default bridge-only. */
  permissionProfile?: AcpPermissionProfile;
  /** Client info sent in `initialize`. */
  clientInfo?: { name: string; version: string };
  /** Per-request timeout for non-turn requests. */
  requestTimeoutMs?: number;
}

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timeout?: NodeJS.Timeout;
};

const REQUEST_TIMEOUT_MS = 30_000;

export class AcpClient {
  private child: ChildProcess | null = null;
  private pending = new Map<string, PendingRequest>();
  private buffer = '';
  private stderr = '';
  private initialized = false;
  private promptHandler: ((event: AcpSessionEvent) => void) | null = null;
  private lastSessionId: string | null = null;
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnChild: typeof spawn;
  private readonly providerName: string;
  private readonly label: string;
  private readonly permissionProfile: AcpPermissionProfile;
  private readonly clientInfo: { name: string; version: string };
  private readonly requestTimeoutMs: number;

  constructor(opts: AcpClientOptions) {
    this.command = opts.command;
    this.args = opts.args;
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.spawnChild = opts.spawnChild ?? spawn;
    this.providerName = opts.providerName ?? 'acp';
    this.label = opts.label ?? 'ACP';
    this.permissionProfile = opts.permissionProfile ?? 'bridge-only';
    this.clientInfo = opts.clientInfo ?? { name: 'koryphaios', version: '1.0.0' };
    this.requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** Spawn the ACP server and perform the protocol handshake. */
  async connect(): Promise<AcpInitializeResult> {
    this.child = this.spawnChild(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Writes to a child that exited (or never started) emit EPIPE on stdin.
    this.child.stdin?.on('error', () => undefined);
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = appendDiagnostic(this.stderr, chunk);
    });
    this.child.on('exit', () => {
      this.rejectAllPending(
        new Error(this.diagnostic('acp process exited before the turn completed')),
      );
    });
    // A missing or non-executable binary emits 'error' (not 'exit'). Without a
    // listener that event would throw on the backend's event loop.
    this.child.on('error', (err: NodeJS.ErrnoException) => {
      const reason = err.code === 'ENOENT' ? 'command not found' : 'process failed to start';
      this.child = null;
      this.rejectAllPending(new Error(`${this.label} ACP ${reason}`));
    });

    const result = (await this.sendRequest('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: this.clientInfo,
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
      throw new Error(`${this.label} ACP: session/new did not return a sessionId`);
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
      throw new Error(`${this.label} ACP: a prompt turn is already in flight on this client`);
    }
    this.promptHandler = onEvent;
    try {
      // No fixed RPC timeout: a turn can legitimately run for minutes. The caller
      // bounds the turn and aborts it; the janitor only rejects when the transport dies.
      const result = (await this.sendRequest(
        'session/prompt',
        { sessionId, prompt: blocks },
        0,
      )) as AcpPromptResult;
      return result ?? {};
    } finally {
      this.promptHandler = null;
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
    this.rejectAllPending(new Error(`${this.label} ACP client disconnected`));
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private assertConnected(): void {
    if (!this.child?.stdin?.writable) {
      throw new Error(`${this.label} ACP process is not connected`);
    }
  }

  private sendRequest(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs: number = this.requestTimeoutMs,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin?.writable) {
        reject(new Error(`${this.label} ACP process is not connected`));
        return;
      }
      const id = randomUUID();
      const req = { jsonrpc: '2.0' as const, id, method, params };
      const timeout =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(
                new Error(`${this.label} ACP request ${method} timed out after ${timeoutMs}ms`),
              );
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
          safeProviderDiagnostic(this.providerName, 'stdout', line),
          `${this.providerName} acp: skipping non-JSON stdout line`,
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
        pending.reject(new Error(error.message ?? `${this.label} ACP request failed: ${id}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Agent→client request (permission prompt). Never block the turn on it.
    if (id && method === 'session/request_permission') {
      const params = (isRecord(msg.params) ? msg.params : {}) as unknown as AcpPermissionRequest;
      const decision: AcpPermissionDecision = decideAcpPermission(params, this.permissionProfile);
      const picked = pickAcpPermissionOption(decision, params.options);
      providerLog.info(
        {
          kind: params.toolCall?.kind,
          title: params.toolCall?.title ?? params.toolCall?.name,
          decision: decision.action,
          profile: this.permissionProfile,
        },
        `${this.providerName} acp: answered session/request_permission`,
      );
      this.sendResponse(
        id,
        picked.cancelled
          ? { outcome: { outcome: 'cancelled' } }
          : { outcome: { outcome: 'selected', optionId: picked.optionId } },
      );
      return;
    }

    // Streaming notification (session/update).
    if (method === 'session/update') {
      const params = msg.params as
        { sessionId?: string; update?: Record<string, unknown> } | undefined;
      const update = params?.update;
      const handler = this.promptHandler;
      if (!update || !handler) return;
      const event = mapSessionUpdate(update);
      if (event) handler(event);
      return;
    }

    if (method && !id) {
      providerLog.debug({ method }, `${this.providerName} acp: ignoring unsupported notification`);
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
      this.providerName,
      safeProviderDiagnostic(this.providerName, 'stderr', this.stderr || fallback),
    );
  }
}

function appendDiagnostic(buffer: string, chunk: Buffer): string {
  const next = buffer + chunk.toString();
  return next.length > 16_000 ? next.slice(-16_000) : next;
}
