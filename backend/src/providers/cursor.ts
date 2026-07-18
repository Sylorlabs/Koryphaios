// Cursor CLI provider — runs the official `cursor-agent` harness.
//
// Like claude-code: no API key needed, the locally logged-in CLI authenticates
// itself (Cursor subscription). Headless `-p --output-format stream-json
// --stream-partial-output` gives real streaming: thinking deltas WITH full
// text, tool_call started/completed with args + results, assistant text
// deltas, and a final result line with exact usage (input/output/cache).

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { spawn } from 'node:child_process';
import { whichBinary } from './cli-detection';
import { detectCursorCLILogin } from './auth-utils';
import { providerLog } from '../logger';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildSoftJail, wrapCommand } from '../collaboration/sandbox-runner';
import {
  type Provider,
  type ProviderEvent,
  type ProviderMessage,
  type StreamRequest,
} from './types';

const CURSOR_STREAM_TIMEOUT_MS = 300_000;
const MODELS_CACHE_TTL_MS = 5 * 60_000;

const HARNESS_SYSTEM_NOTE =
  'You are running inside the Koryphaios orchestrator. Never spawn subagents or delegate to ' +
  'other agents yourself; if work should be parallelized or delegated, say so in your response ' +
  'and Koryphaios will dispatch its own worker agents.';

function buildPrompt(systemPrompt: string | undefined, messages: ProviderMessage[]): string {
  const lines: string[] = [];
  const sys = systemPrompt?.trim();
  lines.push(sys ? `${sys}\n\n${HARNESS_SYSTEM_NOTE}` : HARNESS_SYSTEM_NOTE, '');
  for (const m of messages) {
    const content =
      typeof m.content === 'string'
        ? m.content
        : m.content
            .map((b) =>
              b.type === 'text' ? b.text : b.type === 'image' ? '[image attachment]' : '',
            )
            .filter(Boolean)
            .join('\n');
    if (!content.trim()) continue;
    if (m.role === 'user') lines.push(`User: ${content}`);
    else if (m.role === 'assistant') lines.push(`Assistant: ${content}`);
    else if (m.role === 'tool') lines.push(`Tool result: ${content.slice(0, 8_000)}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

interface CursorStreamLine {
  type?: string;
  subtype?: string;
  timestamp_ms?: number;
  text?: string;
  is_error?: boolean;
  result?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
  call_id?: string;
  tool_call?: Record<string, { args?: Record<string, unknown>; result?: unknown }>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

export class CursorProvider implements Provider {
  readonly name = 'cursor' as const;
  private cachedModels: ModelDef[] | null = null;
  private modelsFetchedAt = 0;
  private modelsInFlight = false;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    return !this.config.disabled && !!whichBinary('cursor-agent') && detectCursorCLILogin();
  }

  listModels(): ModelDef[] {
    if (!this.cachedModels || Date.now() - this.modelsFetchedAt > MODELS_CACHE_TTL_MS) {
      this.refreshModels();
    }
    return (
      this.cachedModels ?? [
        {
          id: 'cursor-auto',
          name: 'Cursor Auto',
          provider: 'cursor',
          apiModelId: 'auto',
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
          supportsStreaming: true,
          supportsAttachments: false,
          canReason: true,
        } as ModelDef,
      ]
    );
  }

  private refreshModels(): void {
    if (this.modelsInFlight) return;
    this.modelsInFlight = true;
    const child = spawn('cursor-agent', ['--list-models'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    const finish = () => {
      this.modelsInFlight = false;
      // Lines look like: `gpt-5.3-codex-high - Codex 5.3 High` (reasoning tier
      // is baked into the model id — no separate effort flag).
      const models: ModelDef[] = [];
      for (const line of out.split('\n')) {
        const m = /^\s*([a-z0-9._[\]=,-]+)\s+-\s+(.+?)(?:\s+\(current\))?\s*$/i.exec(line);
        if (!m) continue;
        models.push({
          id: `cursor-${m[1]}`,
          name: m[2].trim(),
          provider: 'cursor',
          apiModelId: m[1],
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
          supportsStreaming: true,
          supportsAttachments: false,
          canReason: /think|high|low|max|auto/i.test(m[1]),
        } as ModelDef);
      }
      if (models.length > 0) {
        this.cachedModels = models;
        this.modelsFetchedAt = Date.now();
        providerLog.debug(
          { provider: 'cursor', count: models.length },
          'Cursor model list refreshed',
        );
      }
    };
    child.once('exit', finish);
    child.once('error', finish);
    setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* gone */
      }
    }, 20_000).unref?.();
  }

  private resolveCliModel(modelId: string | undefined): string | undefined {
    if (!modelId) return undefined;
    const def = this.listModels().find((m) => m.id === modelId || m.apiModelId === modelId);
    if (def?.apiModelId) return def.apiModelId;
    return modelId.replace(/^cursor-/, '');
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const bin = whichBinary('cursor-agent');
    if (!bin) {
      yield { type: 'error', error: 'Cursor CLI (cursor-agent) not found on PATH.' };
      return;
    }
    if (!detectCursorCLILogin()) {
      yield {
        type: 'error',
        error: 'Cursor CLI is not logged in — run "cursor-agent login" (no API key needed).',
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
      '--stream-partial-output',
      // Headless: never block on interactive approval prompts.
      '--force',
      '--trust',
    ];
    const cliModel = this.resolveCliModel(request.model);
    if (cliModel && cliModel !== 'auto') args.push('--model', cliModel);

    const cwd = request.workingDirectory?.trim() || process.cwd();
    const jail = request.sandbox ? buildSoftJail(process.env, [join(homedir(), '.cursor')]) : null;
    const wrapped = request.sandbox
      ? wrapCommand(bin, args, { cwd, policy: request.sandbox })
      : { command: bin, args };
    const child = spawn(wrapped.command, wrapped.args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: jail?.env ?? { ...process.env },
    });

    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* gone */
      }
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    child.once('close', () => jail?.cleanup());
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

    try {
      for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
        if (request.signal?.aborted) break;
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;
          let row: CursorStreamLine;
          try {
            row = JSON.parse(line) as CursorStreamLine;
          } catch {
            continue;
          }
          for (const event of this.mapLine(row)) {
            if (event.type === 'content_delta' || event.type === 'thinking_delta')
              sawContent = true;
            if (event.type === 'complete') emittedComplete = true;
            yield event;
          }
        }
      }
    } catch (err) {
      const aborted =
        request.signal?.aborted || (err instanceof Error && err.name === 'AbortError');
      if (!aborted) {
        yield {
          type: 'error',
          error: `Cursor harness error: ${err instanceof Error ? err.message : String(err)}`,
        };
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
      const loginHint = /not.*logged in|unauthorized|login|authenticate/i.test(hint)
        ? ' — run "cursor-agent login".'
        : '';
      yield { type: 'error', error: `Cursor: ${hint.slice(0, 300)}${loginHint}` };
      return;
    }
    if (!emittedComplete) yield { type: 'complete', finishReason: 'end_turn' };
  }

  private *mapLine(row: CursorStreamLine): Generator<ProviderEvent> {
    switch (row.type) {
      case 'thinking': {
        // Real reasoning TEXT (unlike Claude Code's redacted stream).
        if (row.subtype === 'delta' && row.text) {
          yield { type: 'thinking_delta', thinking: row.text };
        }
        return;
      }
      case 'assistant': {
        // Delta lines carry timestamp_ms; the CLI also emits one final
        // accumulated duplicate WITHOUT it — skip that to avoid double text.
        if (row.timestamp_ms === undefined) return;
        for (const block of row.message?.content ?? []) {
          if (block.type === 'text' && block.text) {
            yield { type: 'content_delta', content: block.text };
          }
        }
        return;
      }
      case 'tool_call': {
        if (row.subtype !== 'completed' || !row.tool_call) return;
        const [kind, payload] = Object.entries(row.tool_call)[0] ?? ['tool', {}];
        const name = kind.replace(/ToolCall$/, '');
        let output = '';
        try {
          output = JSON.stringify(payload?.result ?? '').slice(0, 8_000);
        } catch {
          /* unstringifiable */
        }
        yield {
          type: 'tool_executed',
          toolName: name,
          toolInput: JSON.stringify(payload?.args ?? {}),
          toolOutput: output,
        };
        return;
      }
      case 'result': {
        if (row.usage) {
          yield {
            type: 'usage_update',
            // inputTokens already INCLUDES cached tokens (cacheReadTokens is a
            // detail breakdown) — emitting tokensCache would double count.
            tokensIn: row.usage.inputTokens ?? 0,
            tokensOut: row.usage.outputTokens ?? 0,
          };
        }
        if (row.is_error) {
          yield { type: 'error', error: row.result || 'Cursor request failed' };
          return;
        }
        yield { type: 'complete', finishReason: 'end_turn' };
        return;
      }
      default:
        return;
    }
  }
}
