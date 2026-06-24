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
import { spawn, spawnSync } from 'node:child_process';
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

// ── Real model list, pulled live from cursor-agent ──────────────────────────────
// cursor-agent exposes no reasoning-effort flag; reasoning is chosen via the model
// variant (e.g. claude-4.5-sonnet-thinking, gpt-5.3-codex-xhigh). So the "real" data
// to pull is the model list itself — `cursor-agent --list-models`. Cached + refreshed
// in the background; we never hardcode the catalog.
let cachedCursorModels: ModelDef[] | null = null;
let cursorModelsAt = 0;
const CURSOR_MODELS_CACHE_MS = 10 * 60 * 1000;
let cursorModelsInFlight: Promise<void> | null = null;
let cursorModelListError: string | undefined;

function parseCursorModels(output: string): ModelDef[] {
  const models: ModelDef[] = [];
  const seen = new Set<string>();
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (/no models available/i.test(line)) cursorModelListError = line;
    // Lines look like: "gpt-5.3-codex-xhigh - Codex 5.3 Extra High" or "auto - Auto (current)".
    const m = line.match(/^([A-Za-z0-9][\w.-]*)\s+-\s+(.+)$/);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const name = m[2].replace(/\s*\(current\)\s*$/i, '').trim() || id;
    models.push({
      id,
      name,
      provider: 'cursor',
      apiModelId: id,
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      costPerMInputTokens: 0,
      costPerMOutputTokens: 0,
      // Reasoning is the model variant itself, so there's no separate effort picker.
      canReason: false,
      reasoningLevels: [],
      supportsAttachments: false,
      supportsStreaming: true,
      tier: id === 'auto' ? 'flagship' : 'flagship',
    });
  }
  return models;
}

function probeCursorModels(): Promise<ModelDef[] | null> {
  return new Promise((resolve) => {
    const bin = whichBinary('cursor-agent');
    if (!bin) return resolve(null);
    let buf = '';
    let settled = false;
    const finish = (v: ModelDef[] | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const child = spawn(bin, ['--list-models'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      child.stdout?.on('data', (d: Buffer) => (buf += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (buf += d.toString()));
      child.on('close', () => {
        const models = parseCursorModels(buf);
        finish(models.length > 0 ? models : null);
      });
      child.on('error', () => finish(null));
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* noop */
        }
        finish(parseCursorModels(buf));
      }, 12_000);
    } catch {
      finish(null);
    }
  });
}

function probeCursorModelsSync(): ModelDef[] | null {
  const bin = whichBinary('cursor-agent');
  if (!bin) return null;
  try {
    const result = spawnSync(bin, ['--list-models'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      encoding: 'utf8',
      timeout: 5000,
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const models = parseCursorModels(output);
    if (models.length === 0 && /no models available/i.test(output)) {
      cursorModelListError = 'No models available for this Cursor account. Cursor CLI reports the account has no model access; sign into a Cursor account/tier with agent model access or set CURSOR_API_KEY.';
    }
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

function refreshCursorModelsInBackground(): void {
  if (cursorModelsInFlight) return;
  if (cachedCursorModels && Date.now() - cursorModelsAt < CURSOR_MODELS_CACHE_MS) return;
  cursorModelsInFlight = probeCursorModels()
    .then((models) => {
      if (models && models.length > 0) {
        cursorModelListError = undefined;
        cachedCursorModels = models;
        cursorModelsAt = Date.now();
        providerLog.info({ count: models.length }, 'Pulled real cursor model list from CLI');
      }
    })
    .catch(() => {})
    .finally(() => {
      cursorModelsInFlight = null;
    });
}

/** The cursor-agent --model value for a selection.
 *  Returns 'auto' when no named model is requested (ensures the CLI doesn't fall back
 *  to whatever named model is set in the editor config, which breaks free-plan accounts). */
function cursorModelArg(model?: string): string {
  if (!model) return 'auto';
  const id = model.includes(':') ? model.split(':').slice(1).join(':') : model;
  if (!id || id === 'auto' || id === 'cursor-agent') return 'auto';
  return id;
}

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
    // Pull the real model list from cursor-agent. The first status read does a short
    // synchronous probe so the UI does not expose a fake placeholder catalog.
    if (!cachedCursorModels && whichBinary('cursor-agent')) {
      const models = probeCursorModelsSync();
      if (models && models.length > 0) {
        cursorModelListError = undefined;
        cachedCursorModels = models;
        cursorModelsAt = Date.now();
      }
    }
    refreshCursorModelsInBackground();
    return cachedCursorModels ?? [];
  }

  getStatusError(): string | undefined {
    return cursorModelListError;
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
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--trust',
      // Non-interactive: run tools without an approval prompt (headless agentic).
      '--force',
    ];

    // Always pass --model explicitly: without it cursor-agent falls back to whatever
    // model is configured in the Cursor editor, which breaks free-plan accounts that
    // can only use "auto". cursorModelArg() returns 'auto' when no named model is chosen.
    args.push('--model', cursorModelArg(request.model));
    args.push(prompt);

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
