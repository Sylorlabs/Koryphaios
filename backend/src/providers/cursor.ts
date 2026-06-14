// Cursor CLI provider — runs the official `cursor-agent` as a FULL AGENT.
//
// Like ClaudeCodeProvider, cursor-agent executes its OWN tools (edit/read/shell) in the
// project directory; we run it headless (`-p --output-format stream-json --force`) and parse
// its NDJSON to surface text, file edits (the live diff preview), and tool activity. The CLI
// owns auth (Cursor login or CURSOR_API_KEY) — we never hold the credential.
//
// Stream schema (verified): system/init · assistant {message.content[].text} ·
// tool_call/started|completed {tool_call:{editToolCall:{args:{path,streamContent}}, readToolCall:{…}, …}} ·
// result/success {result, is_error}.

import type { ProviderConfig, ModelDef } from '@koryphaios/shared';
import { spawn } from 'node:child_process';
import {
  type Provider,
  type ProviderContentBlock,
  type ProviderEvent,
  type ProviderMessage,
  type StreamRequest,
  getModelsForProvider,
} from './types';
import { detectCursorCLILogin } from './auth-utils';
import { whichBinary } from './cli-detection';
import { providerLog } from '../logger';

const CURSOR_STREAM_TIMEOUT_MS = 300_000;

interface CursorEnvelope {
  type: string;
  subtype?: string;
  message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
  tool_call?: Record<string, { args?: Record<string, unknown>; result?: Record<string, unknown> }>;
  result?: string;
  is_error?: boolean;
  call_id?: string;
}

export class CursorProvider implements Provider {
  readonly name = 'cursor' as const;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    if (this.config.disabled) return false;
    return !!this.config.authToken || detectCursorCLILogin();
  }

  listModels(): ModelDef[] {
    return getModelsForProvider('cursor');
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const bin = whichBinary('cursor-agent');
    if (!bin) {
      yield {
        type: 'error',
        error: 'Cursor CLI (cursor-agent) not found on PATH. Install it and run "cursor-agent login", then reconnect.',
      };
      return;
    }

    const prompt = buildPrompt(request.systemPrompt, request.messages);
    if (!prompt.trim()) {
      yield { type: 'error', error: 'Cursor: empty prompt' };
      return;
    }

    const args = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      // Non-interactive: run tools without an approval prompt (headless agentic).
      '--force',
    ];

    // Note: cursor-agent has no --reasoning-effort flag — reasoning is selected via the
    // model variant (e.g. sonnet-4-thinking), so there's nothing to pass here.

    const cwd = request.workingDirectory?.trim() || process.cwd();
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });

    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      providerLog.warn({ provider: 'cursor' }, 'Cursor harness timed out — killing CLI');
      onAbort();
    }, CURSOR_STREAM_TIMEOUT_MS);
    timeout.unref?.();

    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));

    const decoder = new TextDecoder();
    let buffer = '';
    let sawContent = false;
    let emittedComplete = false;
    const pendingTools = new Map<string, { name: string; args: Record<string, unknown> }>();

    try {
      for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const raw = line.trim();
          if (!raw) continue;
          let env: CursorEnvelope;
          try {
            env = JSON.parse(raw) as CursorEnvelope;
          } catch {
            continue;
          }
          for (const event of mapCursorEnvelope(env, pendingTools)) {
            if (
              event.type === 'content_delta' ||
              event.type === 'file_edit' ||
              event.type === 'tool_executed'
            ) {
              sawContent = true;
            }
            if (event.type === 'complete') emittedComplete = true;
            yield event;
          }
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof Error && err.name === 'AbortError')) {
        yield { type: 'error', error: `Cursor harness error: ${message}` };
      }
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', onAbort);
      return;
    }

    const exitCode: number = await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(child.exitCode);
      child.once('exit', (code) => resolve(code ?? 0));
    });
    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', onAbort);
    if (request.signal?.aborted) return;

    if (exitCode !== 0 && !sawContent) {
      const hint = stderr.trim() || `cursor-agent exited with status ${exitCode}`;
      const loginHint = /not.*logged in|unauthorized|login|authenticate|api key/i.test(hint)
        ? ' — run "cursor-agent login" (or set CURSOR_API_KEY) to authenticate.'
        : '';
      yield { type: 'error', error: `Cursor: ${hint.slice(0, 300)}${loginHint}` };
      return;
    }
    if (!emittedComplete) yield { type: 'complete', finishReason: 'end_turn' };
  }
}

function* mapCursorEnvelope(
  env: CursorEnvelope,
  pendingTools: Map<string, { name: string; args: Record<string, unknown> }>,
): Generator<ProviderEvent> {
  switch (env.type) {
    case 'assistant': {
      const content = env.message?.content;
      if (!Array.isArray(content)) return;
      for (const b of content) {
        if (b.type === 'text' && b.text) yield { type: 'content_delta', content: b.text };
      }
      return;
    }
    case 'tool_call': {
      const tc = env.tool_call;
      if (!tc) return;
      for (const [toolKey, body] of Object.entries(tc)) {
        // Only actual tool objects (editToolCall, readToolCall, shellToolCall, …) — skip
        // sibling metadata keys (toolCallId, hookAdditionalContexts, …).
        if (!toolKey.endsWith('ToolCall') || !body || typeof body !== 'object') continue;
        const args = (body?.args ?? {}) as Record<string, unknown>;
        // File edits → live diff preview. Cursor's edit tool carries the new content as
        // `streamContent` and the target as `path`.
        if (toolKey === 'editToolCall' && env.subtype === 'started' && typeof args.path === 'string') {
          yield {
            type: 'file_edit',
            filePath: args.path,
            fileContent: typeof args.streamContent === 'string' ? args.streamContent : '',
            fileOperation: 'edit',
          };
          continue;
        }
        if (toolKey === 'editToolCall') continue; // 'completed' edit — already shown
        // Other tools (read/shell/…): surface on completion.
        if (env.subtype === 'started') {
          if (env.call_id) pendingTools.set(env.call_id, { name: prettyToolName(toolKey), args });
        } else if (env.subtype === 'completed') {
          const pending = env.call_id ? pendingTools.get(env.call_id) : undefined;
          if (env.call_id) pendingTools.delete(env.call_id);
          yield {
            type: 'tool_executed',
            toolName: pending?.name ?? prettyToolName(toolKey),
            toolInput: JSON.stringify(pending?.args ?? args),
            toolOutput: summarizeCursorResult(body?.result),
            isError: !!(body?.result as Record<string, unknown> | undefined)?.error,
          };
        }
      }
      return;
    }
    case 'result': {
      if (env.is_error) {
        yield { type: 'error', error: (typeof env.result === 'string' && env.result) || 'Cursor request failed' };
        return;
      }
      yield { type: 'complete', finishReason: 'end_turn' };
      return;
    }
    default:
      return;
  }
}

function prettyToolName(toolKey: string): string {
  // editToolCall → edit, readToolCall → read, shellToolCall → shell, etc.
  return toolKey.replace(/ToolCall$/, '');
}

function summarizeCursorResult(result: Record<string, unknown> | undefined): string {
  if (!result) return '';
  const success = result.success as Record<string, unknown> | undefined;
  if (success) {
    if (typeof success.content === 'string') return success.content.slice(0, 2000);
    if (typeof success.diffString === 'string') return success.diffString.slice(0, 2000);
    return JSON.stringify(success).slice(0, 500);
  }
  return JSON.stringify(result).slice(0, 500);
}

/** Serialize the conversation into a single prompt for cursor-agent's print mode. */
function buildPrompt(systemPrompt: string | undefined, messages: ProviderMessage[]): string {
  const lines: string[] = [];
  if (systemPrompt?.trim()) lines.push(systemPrompt.trim(), '');
  const turns = messages.filter((m) => m.role !== 'system');
  if (turns.length === 1 && turns[0].role === 'user' && lines.length === 0) {
    return flattenContent(turns[0].content);
  }
  for (const m of turns) {
    const text = flattenContent(m.content);
    if (!text.trim()) continue;
    const label = m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool result' : 'User';
    lines.push(`${label}: ${text}`);
  }
  return lines.join('\n\n');
}

function flattenContent(content: string | ProviderContentBlock[]): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) parts.push(block.text);
    else if (block.type === 'tool_use')
      parts.push(`[tool call: ${block.toolName ?? 'tool'} ${JSON.stringify(block.toolInput ?? {})}]`);
    else if (block.type === 'tool_result') parts.push(`[tool result: ${block.toolOutput ?? ''}]`);
  }
  return parts.join('\n');
}
