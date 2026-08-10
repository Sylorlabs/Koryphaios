// Devin ACP (Agent Communication Protocol) client.
//
// ACP is Devin's full JSON-RPC over stdio protocol. It gives the host
// (Koryphaios) complete control over the agent: streaming text/reasoning,
// tool call interception (approve/block/rewrite), context injection, and
// session management. This replaces the --export file tailing + --agent-config
// approach with a bidirectional channel.
//
// Protocol overview (from devin acp --help + docs):
//   - Spawn: `devin acp --stdio`
//   - JSON-RPC 2.0 over stdin/stdout (newline-delimited)
//   - Methods:
//     initialize → { capabilities }
//     session/start → { sessionId }
//     session/message → streaming events (text, reasoning, tool_call, usage)
//     tool/approve → approve a pending tool call
//     tool/block → block a pending tool call
//     tool/rewrite → rewrite a tool call's input
//     context/inject → inject context mid-session
//     session/end → terminate
//
// This module is the transport layer. The DevinCliBridge uses it when
// capabilities.supportsAcp is true (preferredTransport = 'acp').

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { providerLog } from '../logger';
import type { ProviderEvent } from './types';
import { appendPrivateDiagnostic, safeProviderDiagnostic, safeProviderFailureMessage } from './provider-diagnostics';

// ─── JSON-RPC types ────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
};

// ─── ACP event types (mapped to ProviderEvent) ─────────────────────────────

export type AcpEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolCallId: string; output: string; isError: boolean }
  | { type: 'usage'; tokensIn?: number; tokensOut?: number }
  | { type: 'complete'; sessionId: string }
  | { type: 'error'; message: string };

// ─── ACP client ────────────────────────────────────────────────────────────

export class DevinAcpClient {
  private child: ChildProcess | null = null;
  private pending = new Map<string, PendingRequest>();
  private buffer = '';
  private sessionId: string | null = null;
  private initialized = false;
  private binaryPath: string;
  private devinHome: string;
  private agentConfigPath: string | null;
  private stderr = '';

  constructor(opts: {
    binaryPath: string;
    devinHome: string;
    agentConfigPath?: string | null;
  }) {
    this.binaryPath = opts.binaryPath;
    this.devinHome = opts.devinHome;
    this.agentConfigPath = opts.agentConfigPath ?? null;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    const args = ['acp', '--stdio'];
    if (this.agentConfigPath) {
      args.push('--agent-config', this.agentConfigPath);
    }
    this.child = spawn(this.binaryPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DEVIN_CONFIG_DIR: this.devinHome,
        XDG_CONFIG_HOME: this.devinHome,
      },
    });

    this.child.stdout?.setEncoding('utf-8');
    this.child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = appendPrivateDiagnostic(this.stderr, chunk);
    });
    this.child.on('exit', (code) => {
      const diagnostic = safeProviderDiagnostic('devin', 'stderr', this.stderr, {
        exitCode: code ?? -1,
      });
      providerLog.info(diagnostic, 'Devin ACP process exited');
      this.rejectAllPending(new Error(safeProviderFailureMessage('devin', diagnostic)));
    });

    await this.sendRequest('initialize', {
      client: 'koryphaios',
      version: '1.0.0',
      capabilities: ['tool_interception', 'context_injection', 'streaming'],
    });
    this.initialized = true;
  }

  async disconnect(): Promise<void> {
    if (this.sessionId) {
      try {
        await this.sendRequest('session/end', { sessionId: this.sessionId });
      } catch (err: unknown) {
        /* best effort */
        providerLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Devin ACP: session/end best-effort failed');
      }
    }
    this.child?.stdin?.end();
    this.child?.kill('SIGTERM');
    this.child = null;
    this.initialized = false;
    this.rejectAllPending(new Error('Disconnected'));
  }

  // ── Session management ──────────────────────────────────────────────────

  async startSession(opts: {
    systemPrompt?: string;
    model?: string;
    workingDirectory?: string;
  }): Promise<string> {
    if (!this.initialized) throw new Error('ACP client not connected');
    const result = await this.sendRequest('session/start', {
      systemPrompt: opts.systemPrompt,
      model: opts.model,
      workingDirectory: opts.workingDirectory,
    }) as { sessionId: string };
    this.sessionId = result.sessionId;
    return result.sessionId;
  }

  // ── Messaging (streaming) ───────────────────────────────────────────────

  /**
   * Send a user message and yield streaming events until the session completes.
   * Tool calls are intercepted: the caller decides whether to approve/block
   * via the onToolCall callback. If no callback is provided, all tool calls
   * are approved (passthrough mode).
   */
  async *sendMessage(
    message: string,
    opts?: {
      onToolCall?: (call: {
        toolCallId: string;
        toolName: string;
        input: Record<string, unknown>;
      }) => Promise<'approve' | 'block' | { rewrite: Record<string, unknown> }>;
    },
  ): AsyncGenerator<ProviderEvent> {
    if (!this.sessionId) throw new Error('No active ACP session');
    const msgId = randomUUID();
    const eventQueue: ProviderEvent[] = [];
    let resolveWait: (() => void) | null = null;
    let done = false;

    const eventHandler = (event: AcpEvent) => {
      switch (event.type) {
        case 'text_delta':
          eventQueue.push({ type: 'content_delta', content: event.text });
          break;
        case 'reasoning_delta':
          eventQueue.push({ type: 'thinking_delta', thinking: event.text });
          break;
        case 'tool_call':
          // Intercept: ask the caller whether to approve/block/rewrite.
          if (opts?.onToolCall) {
            opts.onToolCall({
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: event.input,
            }).then(async (decision) => {
              if (decision === 'block') {
                await this.sendNotification('tool/block', {
                  toolCallId: event.toolCallId,
                  reason: 'Blocked by Koryphaios — use kory__ MCP tool instead.',
                });
              } else if (typeof decision === 'object' && 'rewrite' in decision) {
                await this.sendNotification('tool/rewrite', {
                  toolCallId: event.toolCallId,
                  input: decision.rewrite,
                });
              } else {
                await this.sendNotification('tool/approve', {
                  toolCallId: event.toolCallId,
                });
              }
            }).catch(() => {
              // Fail open: approve on error.
              this.sendNotification('tool/approve', { toolCallId: event.toolCallId });
            });
          } else {
            // Passthrough: auto-approve.
            this.sendNotification('tool/approve', { toolCallId: event.toolCallId });
          }
          eventQueue.push({
            type: 'tool_use_start',
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          });
          break;
        case 'tool_result':
          eventQueue.push({
            type: 'tool_executed',
            toolName: '',
            toolInput: '',
            toolOutput: event.output,
            isError: event.isError,
          });
          break;
        case 'usage':
          eventQueue.push({
            type: 'usage_update',
            tokensIn: event.tokensIn,
            tokensOut: event.tokensOut,
          });
          break;
        case 'complete':
          done = true;
          break;
        case 'error':
          {
            const diagnostic = safeProviderDiagnostic('devin', 'stream', event.message);
            providerLog.warn(diagnostic, 'Devin ACP emitted an error event');
            eventQueue.push({ type: 'error', error: safeProviderFailureMessage('devin', diagnostic) });
          }
          done = true;
          break;
      }
      if (resolveWait) {
        resolveWait();
        resolveWait = null;
      }
    };

    // Register a one-time listener for this message's events.
    const unsubscribe = this.subscribe(msgId, eventHandler);

    // Send the message.
    await this.sendRequest('session/message', {
      sessionId: this.sessionId,
      messageId: msgId,
      content: message,
    });

    // Yield events as they arrive.
    while (!done) {
      if (eventQueue.length > 0) {
        yield eventQueue.shift()!;
      } else {
        await new Promise<void>((resolve) => {
          resolveWait = resolve;
          // Safety timeout: if no event for 5s, check again.
          setTimeout(() => {
            if (resolveWait) {
              resolveWait();
              resolveWait = null;
            }
          }, 5000);
        });
      }
    }
    // Drain remaining events.
    while (eventQueue.length > 0) {
      yield eventQueue.shift()!;
    }
    unsubscribe();
  }

  // ── Context injection ───────────────────────────────────────────────────

  async injectContext(content: string): Promise<void> {
    if (!this.sessionId) return;
    await this.sendNotification('context/inject', {
      sessionId: this.sessionId,
      content,
    });
  }

  // ── Internal: JSON-RPC transport ────────────────────────────────────────

  private subscribers = new Map<string, (event: AcpEvent) => void>();

  private subscribe(msgId: string, handler: (event: AcpEvent) => void): () => void {
    this.subscribers.set(msgId, handler);
    return () => this.subscribers.delete(msgId);
  }

  private sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin?.writable) {
        reject(new Error('ACP process not connected'));
        return;
      }
      const id = randomUUID();
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request ${method} timed out after 30s`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(JSON.stringify(req) + '\n');
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    return new Promise((resolve) => {
      if (!this.child?.stdin?.writable) {
        resolve();
        return;
      }
      const notif: JsonRpcNotification = { jsonrpc: '2.0', method, params };
      this.child.stdin.write(JSON.stringify(notif) + '\n');
      resolve();
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const raw = line.trim();
      if (!raw) continue;
      try {
        const msg = JSON.parse(raw) as JsonRpcResponse | JsonRpcNotification;
        if ('id' in msg && this.pending.has(msg.id)) {
          // Response to a request.
          const pending = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          clearTimeout(pending.timeout);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        } else if ('method' in msg && !('id' in msg)) {
          // Notification (streaming event).
          this.handleNotification(msg as JsonRpcNotification);
        }
      } catch (err: unknown) {
        // Not valid JSON — ignore (could be a log line).
        providerLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Devin ACP: non-JSON line skipped');
      }
    }
  }

  private handleNotification(notif: JsonRpcNotification): void {
    const params = notif.params ?? {};
    const msgId = (params.messageId as string) ?? '';
    const handler = msgId ? this.subscribers.get(msgId) : null;

    const event = this.mapNotificationToEvent(notif.method, params);
    if (event && handler) {
      handler(event);
    }
  }

  private mapNotificationToEvent(method: string, params: Record<string, unknown>): AcpEvent | null {
    switch (method) {
      case 'event/text_delta':
        return { type: 'text_delta', text: String(params.text ?? '') };
      case 'event/reasoning_delta':
        return { type: 'reasoning_delta', text: String(params.text ?? '') };
      case 'event/tool_call':
        return {
          type: 'tool_call',
          toolCallId: String(params.toolCallId ?? ''),
          toolName: String(params.toolName ?? ''),
          input: (params.input as Record<string, unknown>) ?? {},
        };
      case 'event/tool_result':
        return {
          type: 'tool_result',
          toolCallId: String(params.toolCallId ?? ''),
          output: String(params.output ?? ''),
          isError: Boolean(params.isError),
        };
      case 'event/usage':
        return {
          type: 'usage',
          tokensIn: params.tokensIn as number | undefined,
          tokensOut: params.tokensOut as number | undefined,
        };
      case 'event/complete':
        return { type: 'complete', sessionId: String(params.sessionId ?? '') };
      case 'event/error':
        return { type: 'error', message: String(params.message ?? 'Unknown error') };
      default:
        return null;
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.pending.clear();
  }
}
