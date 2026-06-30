// Antigravity CLI harness provider — runs Google's official `agy` CLI.
//
// Auth: `agy auth` (Google subscription OAuth) or ANTIGRAVITY_API_KEY in environment.
// Koryphaios never holds the credential — it shells out to the locally installed CLI.
//
// Headless interface:
//   agy --print "<prompt>" --model "<model>" --dangerously-skip-permissions --log-file <path>
//
// Streaming (Option A): agy writes its raw Gemini SSE traffic to --log-file. We tail
// that file at 150ms intervals, parse Gemini SSE JSON lines, and emit real ProviderEvents:
//   • part.text + !part.thought → content_delta (live text streaming)
//   • part.thought === true     → thinking_delta (reasoning tokens)
//   • part.functionCall         → tool_executed  (tools agy ran internally)
// If the log yields no content_delta events (e.g. log file unreadable) we fall back to
// chunking stdout at word boundaries so the response always appears.
//
// Model discovery: `agy models` → one model name per line, refreshed with a 5-min TTL.
// Antigravity exposes Gemini, Claude, and GPT models under a single Google subscription.

import type { ProviderConfig, ModelDef } from '@koryphaios/shared';
import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  type Provider,
  type ProviderContentBlock,
  type ProviderEvent,
  type ProviderMessage,
  type StreamRequest,
  getModelsForProvider,
} from './types';
import { detectAntigravityCLILogin } from './auth-utils';
import { whichBinary } from './cli-detection';
import { providerLog } from '../logger';
import { AntigravityModels } from './models/antigravity';

const AGY_TIMEOUT_MS = 300_000;
const MODELS_CACHE_TTL_MS = 5 * 60_000;
const LOG_POLL_INTERVAL_MS = 150;
const DEFAULT_CLI_MODEL = 'Gemini 3.5 Flash (Medium)';

// ── Dynamic model cache ────────────────────────────────────────────────────────

let cachedModels: ModelDef[] | null = null;
let cachedModelsAt = 0;
let modelsFetchInProgress = false;

function refreshModelsInBackground(): void {
  if (modelsFetchInProgress) return;
  const bin = whichBinary('agy');
  if (!bin) return;

  modelsFetchInProgress = true;
  fetchAgyModels(bin)
    .then((models) => {
      if (models.length > 0) {
        cachedModels = models;
        cachedModelsAt = Date.now();
      }
    })
    .catch(() => { /* best-effort; static list remains the fallback */ })
    .finally(() => { modelsFetchInProgress = false; });
}

async function fetchAgyModels(bin: string): Promise<ModelDef[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['models'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env },
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.once('error', reject);
    child.once('exit', () => {
      const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
      resolve(lines.length === 0 ? [] : lines.map(modelDefFromCliName));
    });
  });
}

function modelDefFromCliName(cliName: string): ModelDef {
  const existing = AntigravityModels.find((m) => m.apiModelId === cliName);
  if (existing) return existing;

  const id = `antigravity-${cliName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}`;
  const isHigh = /\(high\)/i.test(cliName);
  const isThinking = /thinking/i.test(cliName);
  const isPro = /pro/i.test(cliName);
  const isOpus = /opus/i.test(cliName);

  return {
    id,
    name: cliName,
    provider: 'antigravity',
    apiModelId: cliName,
    contextWindow: isPro || isOpus ? 2_097_152 : 1_048_576,
    maxOutputTokens: 65_536,
    canReason: isHigh || isThinking,
    supportsAttachments: false,
    supportsStreaming: true,
    tier: isHigh || isThinking ? 'reasoning' : isPro || isOpus ? 'flagship' : 'fast',
  };
}

// ── File-edit tool detection ──────────────────────────────────────────────────

// agy tool names that create or overwrite a file entirely.
const AGY_CREATE_TOOLS = new Set(['write_to_file', 'write_file']);
// agy tool names that patch/replace content within an existing file.
const AGY_EDIT_TOOLS = new Set(['replace_file_content', 'multi_replace_file_content', 'edit_file']);

function tryEmitFileEdit(
  name: string,
  args: Record<string, unknown>,
): ProviderEvent | null {
  const isCreate = AGY_CREATE_TOOLS.has(name);
  const isEdit = AGY_EDIT_TOOLS.has(name);
  if (!isCreate && !isEdit) return null;

  // agy uses "path" or "filename" for the file path field.
  const filePath = (args.path ?? args.filename ?? args.file_path) as string | undefined;
  if (!filePath) return null;

  // For full-write tools the content is in "content" or "new_content".
  // For patch tools we concatenate replacement strings so the UI shows something.
  let fileContent: string | undefined;
  if (isCreate) {
    fileContent = (args.content ?? args.new_content ?? '') as string;
  } else {
    // multi_replace_file_content: { replacements: [{old_string, new_string}] }
    const replacements = args.replacements as Array<{ new_string?: string }> | undefined;
    fileContent = replacements
      ? replacements.map((r) => r.new_string ?? '').join('\n')
      : ((args.new_content ?? args.content ?? '') as string);
  }

  return {
    type: 'file_edit',
    filePath,
    fileContent,
    fileOperation: isCreate ? 'create' : 'edit',
  };
}

// ── SSE log parser ─────────────────────────────────────────────────────────────

interface ParsedLogEvents {
  events: ProviderEvent[];
  gotContent: boolean;
}

function parseLogChunk(chunk: string, debug = false): ParsedLogEvents {
  const events: ProviderEvent[] = [];
  let gotContent = false;
  if (debug && chunk.trim()) providerLog.debug({ chunk: chunk.slice(0, 500) }, '[agy-debug] raw log chunk');

  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const jsonStr = trimmed.slice(5).trim();
    if (!jsonStr || jsonStr === '[DONE]') continue;

    try {
      const payload = JSON.parse(jsonStr) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              text?: string;
              thought?: boolean;
              functionCall?: { name?: string; args?: unknown };
            }>;
          };
        }>;
      };

      for (const part of payload.candidates?.[0]?.content?.parts ?? []) {
        if (part.thought === true && part.text) {
          events.push({ type: 'thinking_delta', thinking: part.text });
        } else if (part.text) {
          events.push({ type: 'content_delta', content: part.text });
          gotContent = true;
        } else if (part.functionCall) {
          const name = part.functionCall.name ?? 'tool';
          const args = (part.functionCall.args ?? {}) as Record<string, unknown>;
          const fileEvent = tryEmitFileEdit(name, args);
          if (fileEvent) {
            events.push(fileEvent);
          } else {
            events.push({
              type: 'tool_executed',
              toolName: name,
              toolInput: JSON.stringify(args),
            });
          }
        }
      }
    } catch {
      // malformed SSE line — skip
    }
  }

  return { events, gotContent };
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class AntigravityProvider implements Provider {
  readonly name = 'antigravity' as const;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    if (this.config.disabled) return false;
    const available = !!this.config.authToken || detectAntigravityCLILogin();
    if (available && Date.now() - cachedModelsAt > MODELS_CACHE_TTL_MS) {
      refreshModelsInBackground();
    }
    return available;
  }

  listModels(): ModelDef[] {
    const fallback = getModelsForProvider('antigravity');
    if (cachedModels && Date.now() - cachedModelsAt < MODELS_CACHE_TTL_MS) {
      return cachedModels;
    }
    refreshModelsInBackground();
    return cachedModels ?? fallback;
  }

  private resolveCliModel(modelId: string): string {
    const model = this.listModels().find((m) => m.id === modelId || m.apiModelId === modelId);
    if (model?.apiModelId) return model.apiModelId;
    return DEFAULT_CLI_MODEL;
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const bin = whichBinary('agy');
    if (!bin) {
      yield {
        type: 'error',
        error: 'Antigravity CLI not found on PATH. Install it and run "agy auth", then reconnect.',
      };
      return;
    }

    const prompt = buildPrompt(request.systemPrompt, request.messages);
    if (!prompt.trim()) {
      yield { type: 'error', error: 'Antigravity: empty prompt' };
      return;
    }

    const cliModel = this.resolveCliModel(request.model);
    const logPath = join(tmpdir(), `agy-${Date.now()}.log`);

    const args = [
      '--print',
      prompt,
      '--model',
      cliModel,
      '--dangerously-skip-permissions',
      '--log-file',
      logPath,
    ];

    const child = spawn(bin, args, {
      cwd: tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });

    const timeout = setTimeout(() => {
      providerLog.warn({ provider: 'antigravity' }, 'Antigravity harness timed out — killing CLI');
      onAbort();
    }, AGY_TIMEOUT_MS);
    timeout.unref?.();

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));

    const exitPromise = new Promise<number>((resolve) => {
      child.once('error', () => resolve(-1));
      child.once('exit', (code) => resolve(code ?? 0));
    });

    // Tail the log file, parse Gemini SSE JSON, emit real streaming events.
    let logOffset = 0;
    let totalContentEvents = 0;

    const drainLog = (): ProviderEvent[] => {
      try {
        const full = readFileSync(logPath, 'utf-8');
        const newChunk = full.slice(logOffset);
        if (!newChunk) return [];
        logOffset = full.length;
        const { events, gotContent } = parseLogChunk(newChunk, true);
        if (gotContent) totalContentEvents++;
        return events;
      } catch {
        return [];
      }
    };

    // Poll while agy runs, yielding events as they arrive.
    while (true) {
      const result = await Promise.race([
        exitPromise.then((code) => ({ done: true as const, code })),
        new Promise<{ done: false }>((res) => setTimeout(() => res({ done: false }), LOG_POLL_INTERVAL_MS)),
      ]);

      for (const event of drainLog()) yield event;

      if (result.done) {
        // Drain any final log bytes written before shutdown.
        for (const event of drainLog()) yield event;
        clearTimeout(timeout);
        request.signal?.removeEventListener('abort', onAbort);

        try { unlinkSync(logPath); } catch { /* best-effort */ }

        if (request.signal?.aborted) return;

        if (result.code === -1) {
          yield { type: 'error', error: 'Antigravity: failed to launch the agy CLI process.' };
          return;
        }

        const text = stdout.trim();
        if (!text && result.code !== 0) {
          const hint = stderr.trim() || `agy exited with status ${result.code}`;
          const loginHint = /not.*logged in|unauthorized|login|authenticate|api key/i.test(hint)
            ? ' — run "agy auth" (or set ANTIGRAVITY_API_KEY) to authenticate.'
            : '';
          yield { type: 'error', error: `Antigravity: ${hint.slice(0, 300)}${loginHint}` };
          return;
        }

        // Fall back to stdout chunking only if the log produced no content (e.g. log
        // was unreadable or agy used a non-SSE output path).
        if (totalContentEvents === 0 && text) {
          yield* chunkText(text);
        }

        yield { type: 'complete', finishReason: 'end_turn' };
        return;
      }
    }
  }
}

function* chunkText(text: string): Generator<ProviderEvent> {
  const CHUNK_SIZE = 8;
  const words = text.split(/(\s+)/);
  let buf = '';
  let wordCount = 0;
  for (const token of words) {
    buf += token;
    if (!/^\s+$/.test(token)) wordCount++;
    if (wordCount >= CHUNK_SIZE) {
      yield { type: 'content_delta', content: buf };
      buf = '';
      wordCount = 0;
    }
  }
  if (buf) yield { type: 'content_delta', content: buf };
}

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
    else if (block.type === 'image') parts.push('[image omitted — Antigravity harness is text-only]');
  }
  return parts.join('\n');
}
