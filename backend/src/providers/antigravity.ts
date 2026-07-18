// Antigravity CLI harness provider — runs Google's official `agy` CLI.
//
// Auth: `agy auth` (Google subscription OAuth) or ANTIGRAVITY_API_KEY in environment.
// Koryphaios never holds the credential — it shells out to the locally installed CLI.
//
// Headless interface:
//   agy --print "<prompt>" --model "<model>" --dangerously-skip-permissions --log-file <path>
//
// Streaming sources (agy ≥1.0.16 writes only glog server logs to --log-file, so
// the SSE parser below is a legacy fallback for older builds):
//   • trajectory SQLite (conversations/<id>.db, step_type 15, proto …20.3) —
//     the step_payload GROWS IN PLACE while the model streams; we re-read the
//     newest row each 150ms poll and emit the appended thinking suffix live.
//   • brain transcript JSONL — responses + tool runs as steps complete.
//   • stdout — the final answer, streamed as chunks arrive.
//
// Model discovery: `agy models` → one model name per line, refreshed with a 5-min TTL.
// Antigravity exposes Gemini, Claude, and GPT models under a single Google subscription.

import type { ProviderConfig, ModelDef } from '@koryphaios/shared';
import { spawn } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  statSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
} from 'node:fs';
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
import { buildSoftJail, wrapCommand } from '../collaboration/sandbox-runner';
import { AntigravityModels } from './models/antigravity';

const AGY_TIMEOUT_MS = 300_000;
const MODELS_CACHE_TTL_MS = 5 * 60_000;
const LOG_POLL_INTERVAL_MS = 150;
const DEFAULT_CLI_MODEL = 'Gemini 3.5 Flash (Medium)';

// ── Session → agy conversation continuity ────────────────────────────────────
// agy supports `--conversation <id>` to resume. Without it every Koryphaios turn
// spawns a brand-new agentic session that re-explores the workspace (dozens of
// tool runs before the answer). We map each Koryphaios session to the agy
// conversation it created on its first turn and resume it afterwards, sending
// only the NEW turn — agy keeps its own history.
const sessionConversations = new Map<string, string>();

/** Snapshot conversation ids currently on disk. */
function listConversationIds(): Set<string> {
  try {
    return new Set(
      readdirSync(AGY_CONV_DIR)
        .filter((f) => f.endsWith('.db'))
        .map((f) => f.slice(0, -3)),
    );
  } catch {
    return new Set();
  }
}

/** The conversation Koryphaios's agy just created — the NEWEST db that wasn't
 *  in `before`. Picking newest-by-mtime (not "first") avoids grabbing the
 *  user's OWN concurrently-running agy conversation: our just-spawned process
 *  is the one actively writing, so its db is the freshest new one. */
function detectNewConversation(before: Set<string>): string | null {
  let best: string | null = null;
  let bestMtime = -1;
  for (const id of listConversationIds()) {
    if (before.has(id)) continue;
    try {
      const mt = statSync(join(AGY_CONV_DIR, `${id}.db`)).mtimeMs;
      if (mt > bestMtime) {
        bestMtime = mt;
        best = id;
      }
    } catch {
      /* raced away */
    }
  }
  return best;
}

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
    .catch(() => {
      /* best-effort; static list remains the fallback */
    })
    .finally(() => {
      modelsFetchInProgress = false;
    });
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
      const lines = out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      resolve(lines.length === 0 ? [] : lines.map(modelDefFromCliName));
    });
  });
}

function modelDefFromCliName(cliName: string): ModelDef {
  const existing = AntigravityModels.find((m) => m.apiModelId === cliName);
  if (existing) return existing;

  const id = `antigravity-${cliName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+$/, '')}`;
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
    // Antigravity exposes effort choices as distinct model names, not a
    // separate reasoning parameter. An explicit empty list suppresses the
    // composer's reasoning picker for every dynamically discovered model.
    reasoningLevels: [],
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

function tryEmitFileEdit(name: string, args: Record<string, unknown>): ProviderEvent | null {
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
  if (debug && chunk.trim())
    providerLog.debug({ chunk: chunk.slice(0, 500) }, '[agy-debug] raw log chunk');

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
    const models = this.listModels();
    const model = models.find((m) => m.id === modelId || m.apiModelId === modelId);
    return model?.apiModelId ?? DEFAULT_CLI_MODEL;
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

    // Resume the agy conversation tied to this Koryphaios session when we have
    // one — then only the NEW turn is sent (agy holds the prior history), which
    // avoids a fresh agentic session re-exploring the workspace every message.
    let convId = request.sessionId ? sessionConversations.get(request.sessionId) : undefined;
    if (convId && !existsSync(join(AGY_CONV_DIR, `${convId}.db`))) {
      // agy pruned it — start a fresh conversation with full history.
      if (request.sessionId) sessionConversations.delete(request.sessionId);
      convId = undefined;
    }
    const convsBefore = convId ? null : listConversationIds();

    const prompt = convId
      ? buildTurnPrompt(request.messages)
      : buildPrompt(request.systemPrompt, request.messages);
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
      ...(convId ? ['--conversation', convId] : []),
      // agy scopes its workspace via --add-dir (process cwd alone is ignored
      // for tool resolution — verified: it listed $HOME instead of cwd).
      ...(cwd ? ['--add-dir', cwd] : []),
    ];

    // Run in the session's project directory when one is set so the CLI sees
    // the real workspace; fall back to a neutral temp dir otherwise.
    const jail = request.sandbox
      ? buildSoftJail(process.env, [join(homedir(), '.gemini'), join(homedir(), '.antigravity')])
      : null;
    const wrapped = request.sandbox
      ? wrapCommand(bin, args, { cwd: cwd || tmpdir(), policy: request.sandbox })
      : { command: bin, args };
    const child = spawn(wrapped.command, wrapped.args, {
      cwd: request.workingDirectory?.trim() || tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: jail?.env ?? { ...process.env },
    });

    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    child.once('close', () => jail?.cleanup());

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
    const transcriptTail = newTranscriptTail(() => stdout, convId);
    // Reasoning source: the trajectory store (proto field 20.3 of model steps).
    const trajectoryTail = newTrajectoryTail(convId);
    // Thinking from the SSE log is the primary reasoning stream; the trajectory
    // db is the fallback — never mix both or reasoning shows twice/erratically.
    let sseThinkingEvents = 0;

    const rememberConversation = () => {
      if (convId || !convsBefore) return;
      const found = detectNewConversation(convsBefore);
      if (found) {
        convId = found;
        if (request.sessionId) sessionConversations.set(request.sessionId, found);
        // Focus the tailers on the discovered conversation.
        transcriptTail.convId = found;
        trajectoryTail.convId = found;
      }
    };

    const drainLog = (): ProviderEvent[] => {
      try {
        const full = readFileSync(logPath, 'utf-8');
        const newChunk = full.slice(logOffset);
        if (!newChunk) return [];
        logOffset = full.length;
        const { events, gotContent } = parseLogChunk(newChunk);
        if (gotContent) totalContentEvents++;
        sseThinkingEvents += events.filter((e) => e.type === 'thinking_delta').length;
        return events;
      } catch {
        return [];
      }
    };

    // Poll while agy runs, yielding events as they arrive.
    while (true) {
      const result = await Promise.race([
        exitPromise.then((code) => ({ done: true as const, code })),
        new Promise<{ done: false }>((res) =>
          setTimeout(() => res({ done: false }), LOG_POLL_INTERVAL_MS),
        ),
      ]);

      rememberConversation();
      for (const event of drainLog()) yield event;
      if (sseThinkingEvents === 0) {
        for (const event of drainTrajectoryThinking(trajectoryTail)) yield event;
      }
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
        rememberConversation();
        if (sseThinkingEvents === 0) {
          for (const event of drainTrajectoryThinking(trajectoryTail)) yield event;
        }
        for (const event of drainTranscript(transcriptTail)) {
          if (event.type === 'content_delta') totalContentEvents++;
          yield event;
        }
        clearTimeout(timeout);
        request.signal?.removeEventListener('abort', onAbort);

        try {
          unlinkSync(logPath);
        } catch {
          /* best-effort */
        }

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
  /** Known agy conversation id — when set, only that db is polled. */
  convId?: string;
  /** Highest step idx per db that is fully consumed AND closed (a later step
   *  exists). The newest row is deliberately NOT finalized: agy grows its
   *  step_payload in place while the model streams (verified: 287→1625 bytes
   *  over ~2.5s), so it must be re-read every poll. */
  finalizedIdx: Map<string, number>;
  /** chars of thinking already emitted per `${file}:${idx}` row */
  emittedLen: Map<string, number>;
}

function newTrajectoryTail(convId?: string): TrajectoryTailState {
  const state: TrajectoryTailState = {
    spawnedAt: Date.now(),
    convId,
    finalizedIdx: new Map(),
    emittedLen: new Map(),
  };
  // Resuming an existing conversation: its db already holds every prior turn's
  // steps — seed past them so old reasoning isn't replayed into this turn.
  if (convId) {
    const file = join(AGY_CONV_DIR, `${convId}.db`);
    try {
      const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
      const db = new Database(file, { readonly: true });
      try {
        const row = db.query('select max(idx) as m from steps').get() as { m: number | null };
        if (row?.m != null) state.finalizedIdx.set(file, row.m);
      } finally {
        db.close();
      }
    } catch {
      /* db missing/locked — worst case we re-emit prior-turn thinking once */
    }
  }
  return state;
}

/** Concatenated reasoning text (proto field …20.3) of a model-response step. */
function stepThinkingText(payload: Uint8Array): string {
  let out = '';
  for (const [path, text] of protoStrings(payload)) {
    // 20.3 = reasoning text (20.1/20.8 are the final answer, streamed
    // elsewhere; 20.14 is the encrypted thought signature).
    if (path.endsWith('20.3')) out += text;
  }
  return out;
}

/** Poll live conversation dbs for new model-response steps; extract thinking. */
function drainTrajectoryThinking(state: TrajectoryTailState): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  let dbs: string[] = [];
  if (state.convId) {
    // Exact conversation known — no mtime-window guessing across all dbs.
    const f = join(AGY_CONV_DIR, `${state.convId}.db`);
    if (existsSync(f)) dbs = [f];
  } else {
    try {
      dbs = readdirSync(AGY_CONV_DIR)
        .filter((f) => f.endsWith('.db'))
        .map((f) => join(AGY_CONV_DIR, f))
        .filter((f) => {
          if (state.finalizedIdx.has(f)) return true;
          try {
            return statSync(f).mtimeMs >= state.spawnedAt - 2_000;
          } catch {
            return false;
          }
        });
    } catch {
      return events;
    }
  }
  for (const file of dbs) {
    try {
      // Bun's sqlite reads WAL-mode dbs fine in readonly.
      const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
      const db = new Database(file, { readonly: true });
      try {
        const fin = state.finalizedIdx.get(file) ?? -1;
        // idx > fin includes the newest (still-growing) row every poll — its
        // payload streams in place, so we diff and emit only the new suffix.
        const rows = db
          .query('select idx, step_type, step_payload from steps where idx > ? order by idx')
          .all(fin) as Array<{ idx: number; step_type: number; step_payload: Uint8Array | null }>;
        if (rows.length === 0) continue;
        for (const row of rows) {
          if (row.step_type !== 15 || !row.step_payload) continue;
          const full = stepThinkingText(new Uint8Array(row.step_payload));
          const key = `${file}:${row.idx}`;
          const prev = state.emittedLen.get(key) ?? 0;
          if (full.length > prev) {
            events.push({ type: 'thinking_delta', thinking: full.slice(prev) });
            state.emittedLen.set(key, full.length);
          }
        }
        // Everything below the newest row can no longer change.
        const maxIdx = rows[rows.length - 1].idx;
        if (maxIdx - 1 > fin) state.finalizedIdx.set(file, maxIdx - 1);
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
  /** Known agy conversation id — when set, only its transcript is tailed. */
  convId?: string;
  /** Live stdout text so far — used to skip transcript responses the user
   *  already saw streaming (the final answer is printed to stdout too). */
  stdoutSoFar: () => string;
}

function transcriptPath(convId: string): string {
  return join(AGY_BRAIN_DIR, convId, '.system_generated', 'logs', 'transcript_full.jsonl');
}

function newTranscriptTail(stdoutSoFar: () => string, convId?: string): TranscriptTailState {
  const state: TranscriptTailState = {
    offsets: new Map(),
    spawnedAt: Date.now(),
    emittedContent: false,
    convId,
    stdoutSoFar,
  };
  // Resuming: skip the transcript content from earlier turns.
  if (convId) {
    const f = transcriptPath(convId);
    try {
      state.offsets.set(f, statSync(f).size);
    } catch {
      /* transcript not created yet */
    }
  }
  return state;
}

/** Transcript files touched since this run started. */
function findLiveTranscripts(state: TranscriptTailState): string[] {
  if (state.convId) {
    const f = transcriptPath(state.convId);
    return existsSync(f) ? [f] : [];
  }
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
  lines.push(
    systemPrompt?.trim() ? `${systemPrompt.trim()}\n\n${HARNESS_SYSTEM_NOTE}` : HARNESS_SYSTEM_NOTE,
    '',
  );
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

/** Prompt for a resumed conversation: only the turns since the last assistant
 *  reply — agy already holds the earlier history in its own conversation. */
function buildTurnPrompt(messages: ProviderMessage[]): string {
  const turns = messages.filter((m) => m.role !== 'system');
  let start = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'assistant') {
      start = i + 1;
      break;
    }
  }
  const fresh = turns.slice(start);
  if (fresh.length === 1 && fresh[0].role === 'user') return flattenContent(fresh[0].content);
  return fresh
    .map((m) => {
      const text = flattenContent(m.content);
      if (!text.trim()) return '';
      const label = m.role === 'tool' ? 'Tool result' : 'User';
      return `${label}: ${text}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

/** Persist a pasted image to a temp file so the CLI's own tools can view it —
 *  the piped prompt is text-only, but the agent has file access. */
function imageBlockToTempFile(imageData: string | undefined, mime: string | undefined): string {
  if (!imageData) return '[image attachment omitted — no data]';
  try {
    const ext =
      mime === 'image/jpeg'
        ? 'jpg'
        : mime === 'image/webp'
          ? 'webp'
          : mime === 'image/gif'
            ? 'gif'
            : 'png';
    const file = join(tmpdir(), `kory-attach-${Math.random().toString(36).slice(2, 10)}.${ext}`);
    writeFileSync(file, Buffer.from(imageData, 'base64'));
    return `[image attached — saved to ${file}; use your image/file viewing tool to look at it]`;
  } catch {
    return '[image attachment omitted — could not persist to disk]';
  }
}

function flattenContent(content: string | ProviderContentBlock[]): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) parts.push(block.text);
    else if (block.type === 'tool_use')
      parts.push(
        `[tool call: ${block.toolName ?? 'tool'} ${JSON.stringify(block.toolInput ?? {})}]`,
      );
    else if (block.type === 'tool_result') parts.push(`[tool result: ${block.toolOutput ?? ''}]`);
    else if (block.type === 'image')
      parts.push(imageBlockToTempFile(block.imageData, block.imageMimeType));
  }
  return parts.join('\n');
}
