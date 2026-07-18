// Grok Build subscription provider — runs xAI's official `grok` CLI harness.
//
// Mirrors the Claude Code pattern (claude-code.ts): the Grok Build CLI owns its own auth
// (SuperGrok / X Premium+ subscription via `grok login`, or an xAI key in the environment),
// so this provider never holds the credential — it shells out to the locally installed,
// logged-in `grok` CLI in headless print mode and translates its output into Koryphaios
// ProviderEvents. Koryphaios remains the single owner of its own tool loop.
//
// Headless interface (docs.x.ai/build/cli/headless-scripting):
//   grok -p "<prompt>" -m <model> --output-format json --no-alt-screen --always-approve
//   → final JSON object: { "text", "stopReason", "sessionId", "requestId" }
// We use `--output-format json` (documented, stable) rather than the undocumented
// streaming-json event schema; `parseGrokOutput` is tolerant of json / NDJSON / plain so
// the harness keeps working if a future CLI version changes the surface.

import type { ProviderConfig, ModelDef } from '@koryphaios/shared';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { buildSoftJail, wrapCommand } from '../collaboration/sandbox-runner';
import {
  type Provider,
  type ProviderContentBlock,
  type ProviderEvent,
  type ProviderMessage,
  type StreamRequest,
  getModelsForProvider,
} from './types';
import { GrokModels } from './models/grok';
import { detectGrokCLILogin } from './auth-utils';
import { whichBinary } from './cli-detection';
import { providerLog } from '../logger';
import { isModelListCacheFresh } from './model-list-cache';

const GROK_STREAM_TIMEOUT_MS = 300_000;
const DEFAULT_CLI_MODEL = GrokModels[0]?.apiModelId ?? 'grok-composer-2.5-fast';

let cachedModels: ModelDef[] | null = null;
let cachedModelsAt = 0;
let modelsFetchInProgress = false;

export class GrokBuildProvider implements Provider {
  readonly name = 'grok' as const;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    if (this.config.disabled) return false;
    // Either the user explicitly connected (opt-in marker stored as authToken) or the
    // Grok Build CLI is logged in on this machine. The CLI itself owns the real credential.
    const available = !!this.config.authToken || detectGrokCLILogin();
    if (available && !isModelListCacheFresh(cachedModelsAt)) {
      refreshModelsInBackground();
    }
    return available;
  }

  listModels(): ModelDef[] {
    const fallback = getModelsForProvider('grok');
    if (cachedModels && isModelListCacheFresh(cachedModelsAt)) {
      return cachedModels;
    }
    refreshModelsInBackground();
    // The CLI maintains this cache itself from its authenticated model API.
    // Read it synchronously so context limits do not wait behind the slower
    // `grok models` process or reasoning-level probe.
    const cliCachedModels = modelsFromGrokCliCache(readGrokCliModelsCache());
    return cachedModels ?? (cliCachedModels.length > 0 ? cliCachedModels : fallback);
  }

  private resolveCliModel(modelId: string): string {
    const model = this.listModels().find((m) => m.id === modelId || m.apiModelId === modelId);
    if (model?.apiModelId) return model.apiModelId;
    if (/^grok[-/]/i.test(modelId)) return modelId; // accept a full/bare grok id passed through
    return DEFAULT_CLI_MODEL;
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const bin = whichBinary('grok');
    if (!bin) {
      yield {
        type: 'error',
        error:
          'Grok Build CLI not found on PATH. Install it and run "grok login" (see docs.x.ai/build), then reconnect.',
      };
      return;
    }

    const prompt = buildPrompt(request.systemPrompt, request.messages);
    if (!prompt.trim()) {
      yield { type: 'error', error: 'Grok Build: empty prompt' };
      return;
    }

    const cliModel = this.resolveCliModel(request.model);
    const grokSessionId = randomUUID();
    const args = [
      '-p',
      prompt,
      '--model',
      cliModel,
      // streaming-json streams live 'thought' (reasoning) + 'text' tokens as
      // they arrive; plain 'json' only returned one blob at exit, dropping
      // reasoning entirely. Web search + built-in tools stay ENABLED (the CLI
      // runs them internally and folds results/citations into the text).
      '--output-format',
      'streaming-json',
      '--no-alt-screen',
      // Headless: never block on an interactive tool-approval prompt.
      '--always-approve',
      // Delegation is Koryphaios's job (manager → workers → critic) — never let
      // the CLI spawn its own native subagents outside our orchestration/UI.
      '--no-subagents',
      // Run in the session's project directory when one is set so the CLI sees
      // the real workspace; fall back to a neutral temp dir otherwise.
      '--cwd',
      request.workingDirectory?.trim() || tmpdir(),
      // Deterministic session id → we know EXACTLY which session dir holds the
      // tool telemetry to tail (updates.jsonl), instead of guessing by mtime.
      '--session-id',
      grokSessionId,
      // ISOLATION: grok coordinates invocations through a shared "leader"
      // process (default ~/.grok/leader.sock). Without our own socket,
      // Koryphaios's grok attaches to the SAME leader as the user's
      // interactive `grok` in a terminal — cross-contaminating session lists
      // and state. A dedicated Koryphaios leader socket keeps the two worlds
      // completely separate; Koryphaios must never touch the user's sessions.
      '--leader-socket',
      join(tmpdir(), 'koryphaios-grok-leader.sock'),
    ];

    // Web search + web fetch are ON by default (the model runs them internally
    // and folds citations into its answer). Honor the user's global web-search
    // setting: only disable when they explicitly turned it off.
    try {
      const cwd = request.workingDirectory?.trim();
      if (cwd) {
        const { loadAgentSettings } =
          require('../agent-settings') as typeof import('../agent-settings');
        if (loadAgentSettings(cwd).localWebSearch === 'off') args.push('--disable-web-search');
      }
    } catch {
      /* settings unavailable — keep web search on */
    }

    // Only pass --reasoning-effort when the CLI's own metadata says this model
    // supports it (canReason is derived from ~/.grok/models_cache.json).
    if (request.reasoningLevel) {
      const def = this.listModels().find(
        (m) => m.id === request.model || m.apiModelId === request.model,
      );
      const level = request.reasoningLevel.toLowerCase().trim();
      const allowed = def?.reasoningLevels ?? [];
      if (def?.canReason && allowed.includes(level)) {
        args.push('--reasoning-effort', level);
      }
    }

    const cwd = request.workingDirectory?.trim() || tmpdir();
    const jail = request.sandbox ? buildSoftJail(process.env, [join(homedir(), '.grok')]) : null;
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
        /* already gone */
      }
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    child.once('close', () => jail?.cleanup());

    const timeout = setTimeout(() => {
      providerLog.warn({ provider: 'grok' }, 'Grok Build harness timed out — killing CLI');
      onAbort();
    }, GROK_STREAM_TIMEOUT_MS);
    timeout.unref?.();

    // Live NDJSON stream: each line is one event. Push parsed ProviderEvents
    // into a queue the generator drains, so tokens reach the UI as they land.
    const queue: ProviderEvent[] = [];
    let resolveWaiter: (() => void) | null = null;
    const wake = () => {
      resolveWaiter?.();
      resolveWaiter = null;
    };
    let stderr = '';
    let lineBuf = '';
    let sawContent = false;
    let sawThinking = false;
    let stopReason: string | undefined;
    let errorMsg: string | undefined;

    const handleEvent = (ev: Record<string, unknown>) => {
      if (ev.error || ev.is_error) {
        errorMsg = extractError(ev);
        return;
      }
      const type = ev.type as string | undefined;
      // grok streaming-json: {type:'thought'|'text', data:'...'} then {type:'end', stopReason}.
      if (type === 'thought') {
        const t = typeof ev.data === 'string' ? ev.data : '';
        if (t) {
          sawThinking = true;
          queue.push({ type: 'thinking_delta', thinking: t });
        }
      } else if (type === 'text') {
        const t = typeof ev.data === 'string' ? ev.data : '';
        if (t) {
          sawContent = true;
          queue.push({ type: 'content_delta', content: t });
        }
      } else if (type === 'end' || type === 'result') {
        stopReason = (ev.stopReason ?? ev.stop_reason) as string | undefined;
      } else {
        // Non-streaming shapes (single json blob, or a final object): fold text
        // + reasoning in so nothing is lost across CLI versions.
        const thought = pickText({ text: ev.thought ?? ev.reasoning });
        if (thought) {
          sawThinking = true;
          queue.push({ type: 'thinking_delta', thinking: thought });
        }
        const text = pickText(ev);
        if (text) {
          sawContent = true;
          queue.push({ type: 'content_delta', content: text });
        }
        const s = (ev.stopReason ?? ev.stop_reason) as string | undefined;
        if (s) stopReason = s;
      }
    };

    child.stdout.on('data', (c: Buffer) => {
      lineBuf += c.toString();
      let nl: number;
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line || line[0] !== '{') continue;
        try {
          handleEvent(JSON.parse(line) as Record<string, unknown>);
        } catch {
          /* banner/progress */
        }
      }
      wake();
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });

    let exitCode = 0;
    let done = false;
    child.once('error', () => {
      exitCode = -1;
      done = true;
      wake();
    });
    child.once('exit', (code) => {
      exitCode = code ?? 0;
      done = true;
      wake();
    });

    // The grok CLI runs tools INTERNALLY and doesn't emit them on stdout — but
    // it records every tool call (name, file path, diff, status) to its
    // session's updates.jsonl. Tail that to surface file reads/writes/edits and
    // other tool runs as real events, the same way the app shows every action.
    const tailer = newGrokToolTailer(request.workingDirectory?.trim() || tmpdir(), grokSessionId);

    // Drain the queue live until the process exits and the buffer is empty.
    while (true) {
      while (queue.length) {
        if (request.signal?.aborted) break;
        yield queue.shift()!;
      }
      for (const ev of drainGrokToolTailer(tailer)) yield ev;
      if (done) break;
      await new Promise<void>((r) => {
        resolveWaiter = r;
        setTimeout(r, 100);
      });
    }

    // Flush any trailing partial line.
    const tail = lineBuf.trim();
    if (tail && tail[0] === '{') {
      try {
        handleEvent(JSON.parse(tail) as Record<string, unknown>);
      } catch {
        /* ignore */
      }
    }
    while (queue.length) yield queue.shift()!;
    // Final tool telemetry lands just after exit — give it a moment.
    await new Promise((r) => setTimeout(r, 250));
    for (const ev of drainGrokToolTailer(tailer)) yield ev;

    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', onAbort);
    if (request.signal?.aborted) return;

    if (exitCode === -1) {
      yield { type: 'error', error: 'Grok Build: failed to launch the grok CLI process.' };
      return;
    }
    if (errorMsg || (!sawContent && !sawThinking && exitCode !== 0)) {
      const hint = errorMsg || stderr.trim() || `grok CLI exited with status ${exitCode}`;
      const loginHint = /not.*logged in|unauthorized|login|authenticate|api key/i.test(hint)
        ? ' — run "grok login" (or set GROK_CODE_XAI_API_KEY) to authenticate.'
        : '';
      yield { type: 'error', error: `Grok Build: ${hint.slice(0, 300)}${loginHint}` };
      return;
    }

    yield {
      type: 'complete',
      finishReason: stopReason === 'tool_use' ? 'tool_use' : 'end_turn',
    };
  }
}

function refreshModelsInBackground(): void {
  if (modelsFetchInProgress) return;
  const bin = whichBinary('grok');
  if (!bin) return;

  modelsFetchInProgress = true;
  Promise.all([fetchGrokModels(bin), probeGrokReasoningLevels(bin)])
    .then(([models, reasoningLevels]) => {
      if (models.length > 0) {
        // The CLI's own per-model metadata cache (~/.grok/models_cache.json)
        // is authoritative: real context_window and, critically, whether the
        // model ACTUALLY accepts --reasoning-effort. The flag exists globally
        // in the CLI parser even for models that don't support it, so the
        // probed levels are only attached when the cache says so.
        const cliMeta = readGrokCliModelsCache();
        cachedModels = models.map((m) => {
          const key = m.apiModelId ?? m.id;
          const meta = cliMeta?.get(key);
          if (!meta) return m;
          return {
            ...m,
            ...(meta.name
              ? { name: m.name.includes('(default)') ? `${meta.name} (default)` : meta.name }
              : {}),
            ...(meta.contextWindow && meta.contextWindow > 0
              ? { contextWindow: meta.contextWindow, contextVerified: true }
              : {}),
            ...(meta.maxOutputTokens && meta.maxOutputTokens > 0
              ? { maxOutputTokens: meta.maxOutputTokens }
              : {}),
            canReason: meta.supportsReasoningEffort,
            reasoningLevels:
              meta.supportsReasoningEffort && reasoningLevels?.length ? reasoningLevels : undefined,
          };
        });
        cachedModelsAt = Date.now();
        providerLog.debug(
          {
            provider: 'grok',
            models: cachedModels.map((m) => m.apiModelId ?? m.id),
            reasoningLevels,
            cliMetaFound: !!cliMeta,
          },
          'Grok Build model list refreshed',
        );
      }
    })
    .catch((err) => {
      providerLog.warn({ provider: 'grok', err }, 'Grok Build model list refresh failed');
    })
    .finally(() => {
      modelsFetchInProgress = false;
    });
}

interface GrokCliModelMeta {
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsReasoningEffort: boolean;
  hidden: boolean;
}

/** Parse the grok CLI's own model metadata cache (~/.grok/models_cache.json). */
function readGrokCliModelsCache(): Map<string, GrokCliModelMeta> | null {
  try {
    const path = `${homedir()}/.grok/models_cache.json`;
    return parseGrokCliModelsCache(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Parse the authenticated cache written by the Grok CLI itself. */
export function parseGrokCliModelsCache(raw: string): Map<string, GrokCliModelMeta> | null {
  try {
    const parsed = JSON.parse(raw) as {
      models?: Record<string, { info?: Record<string, unknown> }>;
    };
    if (!parsed.models) return null;
    const out = new Map<string, GrokCliModelMeta>();
    for (const [id, entry] of Object.entries(parsed.models)) {
      const info = entry?.info ?? {};
      out.set(id, {
        name: typeof info.name === 'string' ? info.name : undefined,
        contextWindow:
          typeof info.context_window === 'number' && info.context_window >= 1024
            ? info.context_window
            : undefined,
        maxOutputTokens:
          typeof info.max_completion_tokens === 'number' && info.max_completion_tokens > 0
            ? info.max_completion_tokens
            : undefined,
        supportsReasoningEffort: info.supports_reasoning_effort === true,
        hidden: info.hidden === true,
      });
    }
    return out;
  } catch {
    return null;
  }
}

function modelsFromGrokCliCache(cliMeta: Map<string, GrokCliModelMeta> | null): ModelDef[] {
  if (!cliMeta) return [];
  const models: ModelDef[] = [];
  for (const [id, meta] of cliMeta) {
    if (meta.hidden) continue;
    const model = modelDefFromGrokCliId(id);
    models.push({
      ...model,
      ...(meta.name ? { name: meta.name } : {}),
      ...(meta.contextWindow ? { contextWindow: meta.contextWindow, contextVerified: true } : {}),
      ...(meta.maxOutputTokens ? { maxOutputTokens: meta.maxOutputTokens } : {}),
      canReason: meta.supportsReasoningEffort,
      reasoningLevels: undefined,
    });
  }
  return models;
}

// The grok CLI does not document its effort values anywhere machine-readable,
// but it enumerates them in the invalid-value error, e.g.:
//   error: invalid value 'x' for '--reasoning-effort <EFFORT>': invalid reasoning
//   effort: "x" (expected one of: none, minimal, low, medium, high, xhigh)
// Probe with a bogus value (clap rejects it before any network call) and parse.
let cachedReasoningLevels: string[] | null = null;

async function probeGrokReasoningLevels(bin: string): Promise<string[] | null> {
  if (cachedReasoningLevels) return cachedReasoningLevels;
  return new Promise((resolve) => {
    let settled = false;
    const done = (levels: string[] | null) => {
      if (settled) return;
      settled = true;
      if (levels?.length) cachedReasoningLevels = levels;
      resolve(levels);
    };

    const child = spawn(bin, ['--reasoning-effort', '__koryphaios_probe__', '-p', ''], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env },
    });
    let err = '';
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.once('error', () => done(null));
    child.once('exit', () => {
      const m = err.match(/expected one of:\s*([a-z0-9_\-,\s]+)\)/i);
      done(
        m
          ? m[1]
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : null,
      );
    });
    setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      done(null);
    }, 8_000);
  });
}

async function fetchGrokModels(bin: string): Promise<ModelDef[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['models'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env },
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`grok models exited with status ${code ?? 'unknown'}`));
        return;
      }
      const parsed = parseGrokModelsOutput(out);
      if (parsed.modelIds.length === 0) {
        resolve([]);
        return;
      }
      resolve(
        parsed.modelIds.map((modelId) =>
          modelDefFromGrokCliId(modelId, modelId === parsed.defaultModelId),
        ),
      );
    });
  });
}

function grokCliIdToDisplayName(cliId: string): string {
  const known = GrokModels.find((m) => m.apiModelId === cliId);
  if (known) return known.name;
  const words = cliId
    .replace(/^grok[-/]?/i, '')
    .split(/[-._]+/)
    .filter(Boolean)
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)));
  return words.length > 0 ? `Grok ${words.join(' ')}` : cliId;
}

function modelDefFromGrokCliId(cliId: string, isDefault = false): ModelDef {
  const existing = GrokModels.find((m) => m.apiModelId === cliId || m.id === cliId);
  if (existing) {
    return isDefault ? { ...existing, name: `${existing.name} (default)` } : existing;
  }

  const isFast = /fast|mini|flash/i.test(cliId);
  const isReasoning = /reason|think/i.test(cliId);
  const isBuild = /build/i.test(cliId);

  return {
    id: cliId,
    name: grokCliIdToDisplayName(cliId) + (isDefault ? ' (default)' : ''),
    provider: 'grok',
    apiModelId: cliId,
    contextWindow: 256_000,
    maxOutputTokens: 50_000,
    canReason: isBuild || isReasoning || /composer/i.test(cliId),
    supportsAttachments: false,
    supportsStreaming: true,
    tier: isReasoning ? 'reasoning' : isFast ? 'fast' : isBuild ? 'flagship' : 'fast',
  };
}

/**
 * Parse `grok models` stdout. Example:
 *   Default model: grok-composer-2.5-fast
 *   Available models:
 *     - grok-build
 *     * grok-composer-2.5-fast (default)
 */
export function parseGrokModelsOutput(raw: string): {
  defaultModelId?: string;
  modelIds: string[];
} {
  const lines = (raw ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  let defaultModelId: string | undefined;
  const modelIds: string[] = [];
  let inList = false;

  for (const line of lines) {
    const defaultMatch = line.match(/^Default model:\s*(.+)$/i);
    if (defaultMatch?.[1]) {
      defaultModelId = defaultMatch[1].trim();
      continue;
    }

    if (/^Available models:/i.test(line)) {
      inList = true;
      continue;
    }

    if (!inList) continue;

    const bulletMatch = line.match(/^[*-]\s+([^\s(]+)(?:\s+\(default\))?$/i);
    if (bulletMatch?.[1]) {
      const modelId = bulletMatch[1].trim();
      if (!modelIds.includes(modelId)) modelIds.push(modelId);
      if (/\(default\)/i.test(line)) defaultModelId = modelId;
    }
  }

  if (defaultModelId && !modelIds.includes(defaultModelId)) {
    modelIds.unshift(defaultModelId);
  }

  return { defaultModelId, modelIds };
}

// ── Output parsing (pure + exported for tests) ───────────────────────────────

function pickText(obj: Record<string, unknown>): string | null {
  for (const key of ['text', 'result', 'content', 'response', 'output', 'message']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function pickDelta(ev: Record<string, unknown>): string {
  for (const key of ['delta', 'text', 'content', 'chunk']) {
    const v = ev[key];
    if (typeof v === 'string') return v;
  }
  return '';
}

function extractError(obj: Record<string, unknown>): string {
  const e = obj.error ?? obj.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && typeof (e as Record<string, unknown>).message === 'string') {
    return (e as Record<string, unknown>).message as string;
  }
  return 'Grok Build request failed';
}

/**
 * Parse the grok CLI's headless output. Tolerant of all three documented `--output-format`
 * modes (and any future drift):
 *   - `json`           → one final object `{ text, stopReason, sessionId, requestId }`
 *   - `streaming-json` → newline-delimited events (text accumulated)
 *   - `plain`          → raw text
 */
export function parseGrokOutput(raw: string): {
  text: string;
  stopReason?: string;
  error?: string;
} {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { text: '', error: 'Grok Build returned no output' };

  // 1) Single JSON object (--output-format json).
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const o = obj as Record<string, unknown>;
      if (o.error || o.is_error) return { text: '', error: extractError(o) };
      const text = pickText(o);
      if (text != null) {
        const stop = (o.stopReason ?? o.stop_reason) as string | undefined;
        return { text, stopReason: stop };
      }
    }
  } catch {
    /* not a single JSON object — fall through */
  }

  // 2) NDJSON (--output-format streaming-json): accumulate text across events.
  const lines = trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.some((l) => l.startsWith('{'))) {
    let acc = '';
    let stop: string | undefined;
    let err: string | undefined;
    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as Record<string, unknown>;
        if (ev.error || ev.is_error) {
          err = extractError(ev);
          continue;
        }
        acc += pickDelta(ev);
        const s = (ev.stopReason ?? ev.stop_reason) as string | undefined;
        if (s) stop = s;
      } catch {
        /* skip non-JSON lines (banners, progress) */
      }
    }
    if (acc) return { text: acc, stopReason: stop };
    if (err) return { text: '', error: err };
  }

  // 3) Plain text.
  return { text: trimmed };
}

// ── Grok tool-call tailer ────────────────────────────────────────────────────
// grok's headless stdout has only thought/text/end — but the session's
// updates.jsonl carries the full ACP tool stream (tool_call + tool_call_update
// with name, rawInput file paths, kind, status). We tail it so every file
// read/write/edit and other tool run shows up in the app, live.

const GROK_SESSIONS_DIR = join(homedir(), '.grok', 'sessions');

// grok encodes the cwd as a single path segment: %2F for '/', %2E for '.', etc.
function encodeGrokCwd(cwd: string): string {
  return encodeURIComponent(cwd).replace(/\./g, '%2E');
}

interface GrokToolTailer {
  updatesPath: string;
  offset: number;
  /** toolCallId → { name, filePath } captured from the initial tool_call so a
   *  later completed update can be tied back to it. */
  calls: Map<string, { name: string; filePath?: string; content?: string; emitted: boolean }>;
}

function newGrokToolTailer(cwd: string, sessionId: string): GrokToolTailer {
  const dir = join(GROK_SESSIONS_DIR, encodeGrokCwd(cwd), sessionId);
  return { updatesPath: join(dir, 'updates.jsonl'), offset: 0, calls: new Map() };
}

const GROK_FILE_WRITE_TOOLS = new Set(['write', 'create_file', 'write_file']);
const GROK_FILE_EDIT_TOOLS = new Set(['edit', 'edit_file', 'apply_patch', 'str_replace']);
const GROK_FILE_READ_TOOLS = new Set(['read_file', 'read', 'view_file']);

function drainGrokToolTailer(state: GrokToolTailer): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  let text: string;
  try {
    if (!existsSync(state.updatesPath)) return events;
    const size = statSync(state.updatesPath).size;
    if (size <= state.offset) return events;
    text = readFileSync(state.updatesPath, 'utf-8');
  } catch {
    return events;
  }
  const fresh = text.slice(state.offset);
  const lastNl = fresh.lastIndexOf('\n');
  if (lastNl === -1) return events;
  state.offset += Buffer.byteLength(fresh.slice(0, lastNl + 1), 'utf-8');

  for (const line of fresh.slice(0, lastNl).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    let update: Record<string, unknown>;
    try {
      const row = JSON.parse(trimmed) as { params?: { update?: Record<string, unknown> } };
      update = row.params?.update ?? {};
    } catch {
      continue;
    }
    const kind = update.sessionUpdate as string | undefined;
    const toolCallId = update.toolCallId as string | undefined;
    if (!toolCallId) continue;
    const raw = (update.rawInput ?? {}) as Record<string, unknown>;
    const path = (raw.file_path ?? raw.target_file ?? raw.path) as string | undefined;

    if (kind === 'tool_call') {
      state.calls.set(toolCallId, {
        name: String(update.title ?? 'tool'),
        filePath: path,
        content: typeof raw.content === 'string' ? raw.content : undefined,
        emitted: false,
      });
    } else if (kind === 'tool_call_update') {
      const call = state.calls.get(toolCallId) ?? { name: 'tool', emitted: false };
      if (path && !call.filePath) call.filePath = path;
      if (typeof raw.content === 'string' && !call.content) call.content = raw.content;
      state.calls.set(toolCallId, call);

      // Emit once, when the tool completes.
      if (update.status === 'completed' && !call.emitted) {
        call.emitted = true;
        const name = call.name.toLowerCase();
        if (call.filePath && (GROK_FILE_WRITE_TOOLS.has(name) || GROK_FILE_EDIT_TOOLS.has(name))) {
          events.push({
            type: 'file_edit',
            filePath: call.filePath,
            fileContent: call.content ?? '',
            fileOperation: GROK_FILE_WRITE_TOOLS.has(name) ? 'create' : 'edit',
          });
        } else {
          const detail = call.filePath ? ` ${call.filePath}` : '';
          events.push({
            type: 'tool_executed',
            toolName: call.name,
            toolInput: JSON.stringify(call.filePath ? { path: call.filePath } : {}),
            toolOutput: GROK_FILE_READ_TOOLS.has(name)
              ? `Read${detail}`
              : `Ran ${call.name}${detail}`,
          });
        }
      }
    }
  }
  return events;
}

/** Serialize the conversation into a single prompt for the CLI's print mode. */
// The CLI's native subagents are disabled via --no-subagents; this note keeps the
// model from trying (and tells it delegation happens at the Koryphaios layer).
const HARNESS_SYSTEM_NOTE =
  'You are running inside the Koryphaios orchestrator. Never spawn subagents or delegate ' +
  'to other agents yourself (subagents are disabled); if work should be parallelized or ' +
  'delegated, say so in your response and Koryphaios will dispatch its own worker agents.';

function buildPrompt(systemPrompt: string | undefined, messages: ProviderMessage[]): string {
  const lines: string[] = [];
  lines.push(
    systemPrompt?.trim() ? `${systemPrompt.trim()}\n\n${HARNESS_SYSTEM_NOTE}` : HARNESS_SYSTEM_NOTE,
    '',
  );
  const turns = messages.filter((m) => m.role !== 'system');

  // Single user turn → send its text verbatim after any system prompt.
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
      parts.push(
        `[tool call: ${block.toolName ?? 'tool'} ${JSON.stringify(block.toolInput ?? {})}]`,
      );
    else if (block.type === 'tool_result') parts.push(`[tool result: ${block.toolOutput ?? ''}]`);
    else if (block.type === 'image')
      parts.push('[image attachment omitted — Grok Build harness is text-only]');
  }
  return parts.join('\n');
}
