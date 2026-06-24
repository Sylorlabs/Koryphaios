// Google provider — direct API access only.
// Uses Google's GenAI SDK for direct API access.
// Model list is refreshed from the Gemini API when available; static list is fallback only.

import type { ProviderConfig, ModelDef } from '@koryphaios/shared';
import {
  type Provider,
  type ProviderEvent,
  type ProviderMessage,
  type ProviderContentBlock,
  type StreamRequest,
  getModelsForProvider,
  resolveModel,
  createGenericModel,
} from './types';
import { GEMINI_V1BETA_BASE } from './api-endpoints';
import { withRetry } from './utils';
import { whichBinary } from './cli-detection';
import { isGeminiCLIAuthMarker } from './auth-utils';
import { spawn } from 'node:child_process';
import { realpathSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { providerLog } from '../logger';

const GEMINI_CLI_STREAM_TIMEOUT_MS = 300_000;

// ── Real model list from the installed Gemini CLI ───────────────────────────────
// The gemini CLI has NO model-list API (loadCodeAssist returns only the tier) and its
// `/model` picker is interactive-only. Its model catalog is baked into the CLI bundle.
// For OAuth users (no API key) we read that installed bundle to surface the SAME real
// models the CLI offers — cached + background-refreshed, with the static catalog as fallback.
let cachedCliGeminiModels: ModelDef[] | null = null;
let cliGeminiModelsAt = 0;
const GEMINI_CLI_MODELS_CACHE_MS = 10 * 60 * 1000;
let geminiCliProbeInFlight = false;

function resolveGeminiBundleDir(): string | null {
  const bin = whichBinary('gemini');
  if (!bin) return null;
  let real: string;
  try {
    real = realpathSync(bin);
  } catch {
    real = bin;
  }
  let dir = dirname(real);
  for (let i = 0; i < 8 && dir !== '/' && dir !== '.'; i++) {
    const scoped = join(dir, '@google', 'gemini-cli', 'bundle');
    if (existsSync(scoped)) return scoped;
    const local = join(dir, 'bundle');
    if (existsSync(join(dir, 'package.json')) && existsSync(local)) return local;
    dir = dirname(dir);
  }
  return null;
}

function extractGeminiModelIds(bundleDir: string): string[] {
  const ids = new Set<string>();
  // flash-lite before flash so the longer variant isn't truncated.
  const re = /gemini-[0-9]+(?:\.[0-9]+)?(?:-(?:pro|flash-lite|flash))?(?:-preview)?(?:-[0-9]{2,})?/g;
  let files: Array<{ f: string; size: number }>;
  try {
    files = readdirSync(bundleDir)
      .filter((f) => f.endsWith('.js'))
      .map((f) => ({ f, size: statSync(join(bundleDir, f)).size }))
      .sort((a, b) => b.size - a.size)
      .slice(0, 3);
  } catch {
    return [];
  }
  for (const { f } of files) {
    let txt: string;
    try {
      txt = readFileSync(join(bundleDir, f), 'utf8');
    } catch {
      continue;
    }
    for (const m of txt.matchAll(re)) {
      const id = m[0];
      if (/\.(js|ts)$/.test(id) || /9001|super-duper/.test(id)) continue;
      if (/^gemini-[0-9]+$/.test(id)) continue; // bare "gemini-3"
      ids.add(id);
    }
  }
  return [...ids];
}

function prettyGeminiName(id: string): string {
  return id
    .split('-')
    .map((p) => (/^[0-9]/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ')
    .replace(/^Gemini/, 'Gemini');
}

function buildCliGeminiModels(localModels: ModelDef[]): ModelDef[] {
  const dir = resolveGeminiBundleDir();
  if (!dir) return [];
  const ids = extractGeminiModelIds(dir);
  if (ids.length === 0) return [];
  const byId = new Map(localModels.map((m) => [m.apiModelId ?? m.id, m]));
  return ids.map((id) => {
    const existing = byId.get(id);
    if (existing) return existing; // keep curated metadata (cost/context) where we have it
    return {
      id: `gemini-cli:${id}`,
      name: prettyGeminiName(id),
      provider: 'gemini',
      apiModelId: id,
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      canReason: false,
      reasoningLevels: [],
      supportsAttachments: true,
      supportsStreaming: true,
      tier: /flash/.test(id) ? 'fast' : 'flagship',
    } as ModelDef;
  });
}

/** The gemini CLI --model value for a selection, or undefined to let it auto-pick. */
function geminiCliModelArg(model?: string): string | undefined {
  if (!model) return undefined;
  const id = model.includes(':') ? model.split(':').slice(1).join(':') : model;
  const def = resolveModel(id);
  const apiId = def?.apiModelId ?? id;
  if (!apiId || apiId === 'auto') return undefined;
  return apiId;
}

function flattenGeminiContent(content: string | ProviderContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((b) =>
      b.type === 'text' && b.text
        ? b.text
        : b.type === 'tool_result'
          ? `[tool result: ${b.toolOutput ?? ''}]`
          : '',
    )
    .filter(Boolean)
    .join('\n');
}

function buildGeminiPrompt(systemPrompt: string | undefined, messages: ProviderMessage[]): string {
  const lines: string[] = [];
  if (systemPrompt?.trim()) lines.push(systemPrompt.trim(), '');
  const turns = messages.filter((m) => m.role !== 'system');
  if (turns.length === 1 && turns[0].role === 'user' && lines.length === 0) {
    return flattenGeminiContent(turns[0].content);
  }
  for (const m of turns) {
    const text = flattenGeminiContent(m.content);
    if (!text.trim()) continue;
    const label = m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool result' : 'User';
    lines.push(`${label}: ${text}`);
  }
  return lines.join('\n\n');
}

/**
 * Drive the official `gemini` CLI as a harness (OAuth, no API key). Parses its stream-json
 * NDJSON (init / message / result) into ProviderEvents. If a specific model is rejected by
 * the account's tier (the bundle lists more models than `-m` accepts), it retries with the
 * CLI's auto model selection so gemini still responds.
 */
async function* streamGeminiCli(request: StreamRequest): AsyncGenerator<ProviderEvent> {
  const bin = whichBinary('gemini');
  if (!bin) {
    yield {
      type: 'error',
      error: 'Gemini CLI not found on PATH. Install it and run "gemini" to log in, then reconnect.',
    };
    return;
  }
  const prompt = buildGeminiPrompt(request.systemPrompt, request.messages);
  if (!prompt.trim()) {
    yield { type: 'error', error: 'Gemini: empty prompt' };
    return;
  }

  const modelArg = geminiCliModelArg(request.model);
  // First attempt with the requested model; if it's not available to this account, retry auto.
  let producedContent = false;
  let modelRejected = false;
  for await (const ev of runGeminiCliOnce(bin, prompt, modelArg, request)) {
    // If a specific model was requested and the run errors before producing anything, the
    // model likely isn't available to this account's tier — swallow it and retry with auto.
    if (ev.type === 'error' && !producedContent && modelArg) {
      modelRejected = true;
      break;
    }
    if (ev.type === 'content_delta') producedContent = true;
    yield ev;
  }
  if (modelRejected) {
    providerLog.info(
      { model: modelArg },
      'Gemini model not available to this account — retrying with CLI auto selection',
    );
    yield* runGeminiCliOnce(bin, prompt, undefined, request);
  }
}

async function* runGeminiCliOnce(
  bin: string,
  prompt: string,
  modelArg: string | undefined,
  request: StreamRequest,
): AsyncGenerator<ProviderEvent> {
  const args = ['-p', prompt, '-y', '--output-format', 'stream-json'];
  if (modelArg) args.push('-m', modelArg);

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
    providerLog.warn({ provider: 'google' }, 'Gemini CLI harness timed out — killing CLI');
    try {
      child.kill('SIGKILL');
    } catch {
      /* noop */
    }
  }, GEMINI_CLI_STREAM_TIMEOUT_MS);

  const lines = streamLines(child.stdout!);
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  let emittedComplete = false;
  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== '{') continue;
      let env: {
        type?: string;
        role?: string;
        content?: string;
        status?: string;
        stats?: { input_tokens?: number; output_tokens?: number };
      };
      try {
        env = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (env.type === 'message' && env.role === 'assistant' && typeof env.content === 'string') {
        if (env.content) yield { type: 'content_delta', content: env.content };
      } else if (env.type === 'result') {
        if (env.stats) {
          yield {
            type: 'usage_update',
            tokensIn: env.stats.input_tokens ?? 0,
            tokensOut: env.stats.output_tokens ?? 0,
          };
        }
        if (env.status && env.status !== 'success') {
          yield { type: 'error', error: `Gemini CLI: ${env.status}` };
        } else {
          emittedComplete = true;
          yield { type: 'complete', finishReason: 'end_turn' };
        }
      }
    }
    const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 0)));
    if (!emittedComplete) {
      if (code !== 0) {
        yield {
          type: 'error',
          error: `Gemini CLI exited (${code}): ${stderr.slice(0, 300) || 'no output'}`,
        };
      } else {
        yield { type: 'complete', finishReason: 'end_turn' };
      }
    }
  } catch (err: unknown) {
    yield { type: 'error', error: `Gemini CLI harness error: ${String(err).slice(0, 300)}` };
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', onAbort);
  }
}

/** Yield complete newline-delimited lines from a readable stream. */
async function* streamLines(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  let buf = '';
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
    }
  }
  if (buf) yield buf;
}

function refreshCliGeminiModelsInBackground(localModels: ModelDef[]): void {
  if (geminiCliProbeInFlight) return;
  if (cachedCliGeminiModels && Date.now() - cliGeminiModelsAt < GEMINI_CLI_MODELS_CACHE_MS) return;
  geminiCliProbeInFlight = true;
  // Defer the (large) bundle read so listModels() stays fast/synchronous.
  setTimeout(() => {
    try {
      const models = buildCliGeminiModels(localModels);
      if (models.length > 0) {
        cachedCliGeminiModels = models;
        cliGeminiModelsAt = Date.now();
        providerLog.info(
          { count: models.length },
          'Pulled real gemini model list from installed CLI bundle',
        );
      }
    } catch {
      /* keep static fallback */
    } finally {
      geminiCliProbeInFlight = false;
    }
  }, 0);
}

export class GeminiProvider implements Provider {
  readonly name: 'google' | 'gemini' | 'vertexai';

  constructor(readonly config: ProviderConfig) {
    this.name = config.name === 'vertexai' ? 'vertexai' : config.name === 'gemini' ? 'gemini' : 'google';
  }

  isAvailable(): boolean {
    return !this.config.disabled && !!(this.config.apiKey || this.config.authToken);
  }

  /** OAuth/CLI-harness mode: no real API key, opted into the gemini CLI via the marker. */
  private isCliHarnessMode(): boolean {
    return (
      this.name === 'google' &&
      !this.config.apiKey &&
      isGeminiCLIAuthMarker(this.config.authToken)
    ) || this.name === 'gemini';
  }

  private cachedModels: ModelDef[] | null = null;
  private lastFetch = 0;

  listModels(): ModelDef[] {
    const localModels = getModelsForProvider(this.name);
    if (this.name !== 'google' && this.name !== 'gemini') return localModels;
    if (!this.isAvailable()) return localModels;
    // OAuth/CLI mode: the gemini CLI has no model-list API, so read the installed CLI's
    // own catalog from its bundle (the real models the CLI offers).
    if (this.isCliHarnessMode()) {
      if (!cachedCliGeminiModels) {
        const models = buildCliGeminiModels(localModels);
        if (models.length > 0) {
          cachedCliGeminiModels = models;
          cliGeminiModelsAt = Date.now();
        }
      }
      refreshCliGeminiModelsInBackground(localModels);
      return cachedCliGeminiModels ?? [];
    }
    if (this.cachedModels && Date.now() - this.lastFetch < 5 * 60 * 1000) {
      return this.cachedModels;
    }
    this.refreshModelsInBackground(localModels);
    return this.cachedModels ?? localModels;
  }

  private refreshModelsInBackground(localModels: ModelDef[]) {
    const apiKey = this.config.apiKey || this.config.authToken;
    if (!apiKey) return;
    const url = `${GEMINI_V1BETA_BASE}/models?key=${encodeURIComponent(apiKey)}`;
    withRetry(() =>
      fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText)))),
    )
      .then((body: { models?: Array<{ name?: string }> }) => {
        const remote: ModelDef[] = [];
        for (const m of body.models ?? []) {
          const name = m.name;
          if (!name || !name.startsWith('models/')) continue;
          const id = name.replace(/^models\//, '');
          if (localModels.some((l) => l.id === id || l.apiModelId === id)) continue;
          const def = createGenericModel(id, 'google');
          def.apiModelId = id;
          remote.push(def);
        }
        this.cachedModels = [...localModels, ...remote];
        this.lastFetch = Date.now();
      })
      .catch(() => {
        if (!this.cachedModels) this.cachedModels = localModels;
      });
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    // OAuth/CLI mode: drive the official gemini CLI as a harness (it owns OAuth + Code
    // Assist, so no API key is needed) instead of the @google/genai API SDK.
    if (this.isCliHarnessMode()) {
      yield* streamGeminiCli(request);
      return;
    }

    const { GoogleGenAI } = await import('@google/genai');

    const apiKey = this.config.apiKey || this.config.authToken;
    if (!apiKey) {
      yield {
        type: 'error',
        error:
          this.name === 'vertexai'
            ? 'Vertex AI requires an explicit API key (set GOOGLE_VERTEX_AI_API_KEY)'
            : 'No API key available',
      };
      return;
    }

    // Vertex AI is a DIFFERENT backend from the consumer Gemini API: it routes to
    // {location}-aiplatform.googleapis.com under a GCP project, not generativelanguage.
    // The official SDK builds that wire shape when vertexai:true. Project/location come
    // from the standard GCP env vars; an API key enables Vertex express mode.
    const clientOptions: any =
      this.name === 'vertexai'
        ? {
            vertexai: true,
            apiKey,
            project: process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_VERTEX_PROJECT,
            location:
              process.env.GOOGLE_CLOUD_LOCATION || process.env.GOOGLE_VERTEX_LOCATION || undefined,
          }
        : { apiKey };

    if (this.config.baseUrl) {
      clientOptions.baseUrl = this.config.baseUrl;
    }

    const client = new GoogleGenAI(clientOptions);

    const contents = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts:
          typeof m.content === 'string'
            ? [{ text: m.content }]
            : (m.content as any[]).map((b) =>
                b.type === 'text' ? { text: b.text ?? '' } : { text: '' },
              ),
      }));

    const generationConfig: any = {
      systemInstruction: request.systemPrompt,
      maxOutputTokens: request.maxTokens ?? 65_536,
      temperature: request.temperature,
    };

    const modelDef = resolveModel(request.model);
    const apiModel = modelDef?.apiModelId || request.model;
    const isGemini3 = /gemini-3/i.test(request.model) || /gemini-3/i.test(apiModel ?? '');

    if (request.reasoningLevel !== undefined && request.reasoningLevel !== '') {
      const level = String(request.reasoningLevel).trim();
      if (isGemini3) {
        const thinkingLevel = ['low', 'medium', 'high'].includes(level.toLowerCase())
          ? level.toUpperCase()
          : 'MEDIUM';
        generationConfig.thinkingConfig = { thinkingLevel };
      } else {
        const budget =
          level === '0' || level.toLowerCase() === 'off'
            ? 0
            : Math.max(0, parseInt(level, 10) || 8192);
        generationConfig.thinkingConfig = { thinkingBudget: budget };
      }
    }

    try {
      const response = await client.models.generateContentStream({
        model: apiModel,
        contents,
        config: generationConfig,
      });

      for await (const chunk of response) {
        const candidate = chunk.candidates?.[0];
        if (!candidate?.content?.parts) continue;
        for (const part of candidate.content.parts) {
          if (part.text) yield { type: 'content_delta', content: part.text };
        }
        if (candidate.finishReason) yield { type: 'complete', finishReason: 'end_turn' };
      }
    } catch (err: any) {
      yield { type: 'error', error: err.message ?? String(err) };
    }
  }
}
