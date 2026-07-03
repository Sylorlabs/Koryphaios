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
import { readFileSync, unlinkSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
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

    const cwd = request.workingDirectory?.trim();
    const args = [
      '--print',
      prompt,
      '--model',
      cliModel,
      '--dangerously-skip-permissions',
      '--log-file',
      logPath,
      // agy scopes its workspace via --add-dir (process cwd alone is ignored
      // for tool resolution — verified: it listed $HOME instead of cwd).
      ...(cwd ? ['--add-dir', cwd] : []),
    ];

    // Run in the session's project directory when one is set so the CLI sees
    // the real workspace; fall back to a neutral temp dir otherwise.
    const child = spawn(bin, args, {
      cwd: request.workingDirectory?.trim() || tmpdir(),
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
    // Live stdout queue: agy --print writes progressively — stream each chunk
    // the moment it lands instead of dumping the whole reply at exit.
    const stdoutQueue: string[] = [];
    child.stdout.on('data', (c: Buffer) => {
      const text = c.toString();
      stdout += text;
      stdoutQueue.push(text);
    });
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));

    const exitPromise = new Promise<number>((resolve) => {
      child.once('error', () => resolve(-1));
      child.once('exit', (code) => resolve(code ?? 0));
    });

    // Tail the log file, parse Gemini SSE JSON, emit real streaming events.
    let logOffset = 0;
    let totalContentEvents = 0;
    let emittedStdout = false;
    // Primary live source: agy's own brain transcript (responses + tools).
    const transcriptTail = newTranscriptTail(() => stdout);
    // Reasoning source: the trajectory store (proto field 20.3 of model steps).
    const trajectoryTail = newTrajectoryTail();

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
      for (const event of drainTrajectoryThinking(trajectoryTail)) yield event;
      for (const event of drainTranscript(transcriptTail)) {
        if (event.type === 'content_delta') totalContentEvents++;
        yield event;
      }

      // Stream stdout live — unless the transcript/SSE path is already
      // delivering the response text (avoid double-emitting).
      if (totalContentEvents === 0 && !transcriptTail.emittedContent) {
        while (stdoutQueue.length > 0) {
          const chunk = stdoutQueue.shift()!;
          if (chunk) {
            emittedStdout = true;
            yield { type: 'content_delta', content: chunk };
          }
        }
      }

      if (result.done) {
        // Drain any final log/transcript bytes written before shutdown.
        for (const event of drainLog()) yield event;
        // The transcript's final lines can land marginally after exit.
        await new Promise((r) => setTimeout(r, 400));
        for (const event of drainTrajectoryThinking(trajectoryTail)) yield event;
        for (const event of drainTranscript(transcriptTail)) {
          if (event.type === 'content_delta') totalContentEvents++;
          yield event;
        }
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

        // Flush any stdout that arrived after the last poll tick.
        if (totalContentEvents === 0 && !transcriptTail.emittedContent) {
          while (stdoutQueue.length > 0) {
            const chunk = stdoutQueue.shift()!;
            if (chunk) {
              emittedStdout = true;
              yield { type: 'content_delta', content: chunk };
            }
          }
        }
        // Last resort: nothing streamed at all but stdout has text (shouldn't
        // happen — kept as a safety net).
        if (totalContentEvents === 0 && !emittedStdout && text) {
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

// ── Live transcript tailer ───────────────────────────────────────────────────
// The agy CLI writes a full JSONL transcript of every run to its local "brain"
// store (~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/
// transcript_full.jsonl): model responses, every tool call with output,
// errors, subagent spawns — appended live as steps complete. Tailing it gives
// Koryphaios the same real-time visibility the Antigravity app has, from the
// CLI's own artifacts (no API access, no auth games).

const AGY_BRAIN_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'brain');
const AGY_CONV_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'conversations');

// ── Trajectory thinking extraction ──────────────────────────────────────────
// The reasoning text ("collapsible thinking" in the Antigravity app) is NOT in
// the JSONL transcript — it lives in the conversation trajectory SQLite, in
// model-response steps (step_type 15), protobuf field path 20.3. We decode the
// proto generically (wire format only, no schema needed) and stream it.

/** Walk protobuf wire format collecting [fieldPath, string] pairs. */
function protoStrings(buf: Uint8Array, prefix = ''): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let i = 0;
  const readVarint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      if (i >= buf.length) throw new Error('eof');
      const b = buf[i++];
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  while (i < buf.length) {
    let key: number;
    try {
      key = readVarint();
    } catch {
      break;
    }
    const field = Math.floor(key / 8);
    const wire = key & 7;
    try {
      if (wire === 0) readVarint();
      else if (wire === 2) {
        const len = readVarint();
        if (len < 0 || i + len > buf.length) break;
        const data = buf.subarray(i, i + len);
        i += len;
        const path = prefix ? `${prefix}.${field}` : String(field);
        let asText: string | null = null;
        if (len > 0) {
          try {
            const t = new TextDecoder('utf-8', { fatal: true }).decode(data);
            // Heuristic: leading chars must be printable — otherwise treat as
            // a nested message and recurse.
            const head = t.slice(0, 80);
            if (/^[\x20-\x7e\n\t\r]*$/.test(head)) asText = t;
          } catch {
            /* not utf-8 */
          }
        }
        if (asText !== null) out.push([path, asText]);
        else out.push(...protoStrings(data, path));
      } else if (wire === 5) i += 4;
      else if (wire === 1) i += 8;
      else break;
    } catch {
      break;
    }
  }
  return out;
}

interface TrajectoryTailState {
  spawnedAt: number;
  /** last consumed step idx per conversation db */
  lastIdx: Map<string, number>;
  seenThinking: Set<string>;
}

function newTrajectoryTail(): TrajectoryTailState {
  return { spawnedAt: Date.now(), lastIdx: new Map(), seenThinking: new Set() };
}

/** Poll live conversation dbs for new model-response steps; extract thinking. */
function drainTrajectoryThinking(state: TrajectoryTailState): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  let dbs: string[] = [];
  try {
    dbs = readdirSync(AGY_CONV_DIR)
      .filter((f) => f.endsWith('.db'))
      .map((f) => join(AGY_CONV_DIR, f))
      .filter((f) => {
        if (state.lastIdx.has(f)) return true;
        try {
          return statSync(f).mtimeMs >= state.spawnedAt - 2_000;
        } catch {
          return false;
        }
      });
  } catch {
    return events;
  }
  for (const file of dbs) {
    try {
      // Bun's sqlite reads WAL-mode dbs fine in readonly.
      const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
      const db = new Database(file, { readonly: true });
      try {
        const last = state.lastIdx.get(file) ?? -1;
        const rows = db
          .query('select idx, step_type, step_payload from steps where idx > ? order by idx')
          .all(last) as Array<{ idx: number; step_type: number; step_payload: Uint8Array | null }>;
        for (const row of rows) {
          state.lastIdx.set(file, row.idx);
          if (row.step_type !== 15 || !row.step_payload) continue;
          for (const [path, text] of protoStrings(new Uint8Array(row.step_payload))) {
            // 20.3 = reasoning text (20.1/20.8 are the final answer, streamed
            // elsewhere; 20.14 is the encrypted thought signature).
            if (path.endsWith('20.3') && text.trim().length > 10) {
              const key = text.slice(0, 120);
              if (state.seenThinking.has(key)) continue;
              state.seenThinking.add(key);
              events.push({ type: 'thinking_delta', thinking: text });
            }
          }
        }
      } finally {
        db.close();
      }
    } catch {
      /* db busy/locked this tick — retry next poll */
    }
  }
  return events;
}


const AGY_TOOL_TYPES = new Set([
  'RUN_COMMAND',
  'VIEW_FILE',
  'LIST_DIRECTORY',
  'GREP_SEARCH',
  'CODE_ACTION',
  'SEARCH_WEB',
  'READ_URL_CONTENT',
  'GENERIC',
  'INVOKE_SUBAGENT',
  'MANAGE_TASK',
]);

interface TranscriptTailState {
  /** byte offsets per transcript file */
  offsets: Map<string, number>;
  spawnedAt: number;
  emittedContent: boolean;
  /** Live stdout text so far — used to skip transcript responses the user
   *  already saw streaming (the final answer is printed to stdout too). */
  stdoutSoFar: () => string;
}

function newTranscriptTail(stdoutSoFar: () => string): TranscriptTailState {
  return { offsets: new Map(), spawnedAt: Date.now(), emittedContent: false, stdoutSoFar };
}

/** Transcript files touched since this run started. */
function findLiveTranscripts(state: TranscriptTailState): string[] {
  const out: string[] = [];
  try {
    for (const id of readdirSync(AGY_BRAIN_DIR)) {
      const f = join(AGY_BRAIN_DIR, id, '.system_generated', 'logs', 'transcript_full.jsonl');
      try {
        if (state.offsets.has(f) || statSync(f).mtimeMs >= state.spawnedAt - 2_000) out.push(f);
      } catch {
        /* no transcript in this brain dir */
      }
    }
  } catch {
    /* brain dir absent — older agy or different install */
  }
  return out;
}

/** Read new complete lines from a transcript, mapped to provider events. */
function drainTranscript(state: TranscriptTailState): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  for (const file of findLiveTranscripts(state)) {
    try {
      const start = state.offsets.get(file) ?? 0;
      const fd = openSync(file, 'r');
      const size = fstatSync(fd).size;
      if (size <= start) {
        closeSync(fd);
        continue;
      }
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      closeSync(fd);
      const text = buf.toString('utf-8');
      // Only consume complete lines; partial tail re-reads next poll.
      const lastNl = text.lastIndexOf('\n');
      if (lastNl === -1) continue;
      state.offsets.set(file, start + Buffer.byteLength(text.slice(0, lastNl + 1), 'utf-8'));
      for (const line of text.slice(0, lastNl).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const row = JSON.parse(trimmed) as {
            type?: string;
            source?: string;
            content?: string;
            created_at?: string;
          };
          const kind = row.type ?? '';
          const content = (row.content ?? '').trim();
          if (kind === 'PLANNER_RESPONSE' && content) {
            // The FINAL response is also printed to stdout (already streamed
            // live) — only surface transcript responses the user hasn't seen.
            const probe = content.slice(0, 200);
            if (!state.stdoutSoFar().includes(probe)) {
              events.push({
                type: 'content_delta',
                content: state.emittedContent ? `\n\n${content}` : content,
              });
              state.emittedContent = true;
            }
          } else if (kind === 'ERROR_MESSAGE' && content) {
            events.push({
              type: 'tool_executed',
              toolName: 'antigravity',
              toolInput: '{}',
              toolOutput: content.slice(0, 4_000),
              isError: true,
            });
          } else if (AGY_TOOL_TYPES.has(kind) && content) {
            events.push({
              type: 'tool_executed',
              toolName: kind.toLowerCase(),
              toolInput: '{}',
              toolOutput: content.slice(0, 4_000),
            });
          }
          // USER_INPUT / EPHEMERAL_MESSAGE / SYSTEM_MESSAGE / CHECKPOINT /
          // CONVERSATION_HISTORY are prompt plumbing — not surfaced.
        } catch {
          /* partial or non-JSON line */
        }
      }
    } catch {
      /* file rotated/unreadable this tick — retry next poll */
    }
  }
  return events;
}

// The agy CLI has no flag to disable native subagent/delegation behavior, so the
// only lever is the prompt: delegation belongs to the Koryphaios layer.
const HARNESS_SYSTEM_NOTE =
  'You are running inside the Koryphaios orchestrator. Never spawn subagents or delegate ' +
  'to other agents yourself; if work should be parallelized or delegated, say so in your ' +
  'response and Koryphaios will dispatch its own worker agents.';

function buildPrompt(systemPrompt: string | undefined, messages: ProviderMessage[]): string {
  const lines: string[] = [];
  lines.push(systemPrompt?.trim() ? `${systemPrompt.trim()}\n\n${HARNESS_SYSTEM_NOTE}` : HARNESS_SYSTEM_NOTE, '');
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
