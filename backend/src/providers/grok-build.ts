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
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
    return cachedModels ?? fallback;
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
    const args = [
      '-p',
      prompt,
      '--model',
      cliModel,
      '--output-format',
      'json',
      '--no-alt-screen',
      // Headless: never block on an interactive tool-approval prompt. The CLI runs in a
      // neutral temp dir (no repo to act on), so it behaves as a generation endpoint.
      '--always-approve',
      '--cwd',
      tmpdir(),
    ];

    const child = spawn(bin, args, {
      cwd: tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });

    const timeout = setTimeout(() => {
      providerLog.warn({ provider: 'grok' }, 'Grok Build harness timed out — killing CLI');
      onAbort();
    }, GROK_STREAM_TIMEOUT_MS);
    timeout.unref?.();

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));

    const exitCode: number = await new Promise((resolve) => {
      child.once('error', () => resolve(-1));
      child.once('exit', (code) => resolve(code ?? 0));
    });

    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', onAbort);
    if (request.signal?.aborted) return;

    if (exitCode === -1) {
      yield { type: 'error', error: 'Grok Build: failed to launch the grok CLI process.' };
      return;
    }

    const parsed = parseGrokOutput(stdout);
    if (parsed.error || (!parsed.text && exitCode !== 0)) {
      const hint = parsed.error || stderr.trim() || `grok CLI exited with status ${exitCode}`;
      const loginHint = /not.*logged in|unauthorized|login|authenticate|api key/i.test(hint)
        ? ' — run "grok login" (or set GROK_CODE_XAI_API_KEY) to authenticate.'
        : '';
      yield { type: 'error', error: `Grok Build: ${hint.slice(0, 300)}${loginHint}` };
      return;
    }

    if (parsed.text) {
      yield { type: 'content_delta', content: parsed.text };
    }
    yield {
      type: 'complete',
      finishReason: parsed.stopReason === 'tool_use' ? 'tool_use' : 'end_turn',
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
            ...(meta.name ? { name: m.name.includes('(default)') ? `${meta.name} (default)` : meta.name } : {}),
            ...(meta.contextWindow && meta.contextWindow > 0
              ? { contextWindow: meta.contextWindow, contextVerified: true }
              : {}),
            ...(meta.maxOutputTokens && meta.maxOutputTokens > 0
              ? { maxOutputTokens: meta.maxOutputTokens }
              : {}),
            canReason: meta.supportsReasoningEffort,
            reasoningLevels:
              meta.supportsReasoningEffort && reasoningLevels?.length
                ? reasoningLevels
                : undefined,
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
    const raw = readFileSync(path, 'utf8');
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
          typeof info.context_window === 'number' && info.context_window > 0
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
    tier: isReasoning ? 'reasoning' : isFast ? 'fast' : isBuild ? 'flagship' : 'standard',
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
  const lines = (raw ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
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
  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
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

/** Serialize the conversation into a single prompt for the CLI's print mode. */
function buildPrompt(systemPrompt: string | undefined, messages: ProviderMessage[]): string {
  const lines: string[] = [];
  if (systemPrompt?.trim()) lines.push(systemPrompt.trim(), '');
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
      parts.push(`[tool call: ${block.toolName ?? 'tool'} ${JSON.stringify(block.toolInput ?? {})}]`);
    else if (block.type === 'tool_result') parts.push(`[tool result: ${block.toolOutput ?? ''}]`);
    else if (block.type === 'image') parts.push('[image attachment omitted — Grok Build harness is text-only]');
  }
  return parts.join('\n');
}
