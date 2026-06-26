// Antigravity CLI harness provider — runs Google's official `agy` CLI.
//
// Mirrors the Grok Build pattern (grok-build.ts): the Antigravity CLI owns its own auth
// (Google subscription via `agy auth`, or ANTIGRAVITY_API_KEY in the environment),
// so this provider never holds the credential — it shells out to the locally installed,
// logged-in `agy` CLI in print mode and translates its output into Koryphaios
// ProviderEvents. Koryphaios remains the single owner of its own tool loop.
//
// Headless interface:
//   agy --print "<prompt>" --model "<model>" --dangerously-skip-permissions
//   → plain text response (no JSON output mode unlike grok or claude)
//
// Model discovery:
//   agy models → one model name per line; refreshed in background with a 5 min TTL.
//
// Live progress:
//   agy is a full agent CLI. We write its internal log to a temp file (--log-file) and
//   tail it while the process runs. Each `streamGenerateContent?alt=sse` line signals a
//   new model request round (initial call + one per agentic tool turn). We emit a
//   tool_executed event per round > 1 so the UI shows the agent working between turns.
//   The final stdout (plain text) is chunked to simulate word-level streaming.

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
const DEFAULT_CLI_MODEL = 'Gemini 3.5 Flash (Medium)';

// ── Dynamic model cache (module-level, shared across provider instances) ──────

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
      if (lines.length === 0) {
        resolve([]);
        return;
      }
      const models = lines.map((name) => modelDefFromCliName(name));
      resolve(models);
    });
  });
}

function modelDefFromCliName(cliName: string): ModelDef {
  // Try to find an existing static def first (preserves curated metadata).
  const existing = AntigravityModels.find((m) => m.apiModelId === cliName);
  if (existing) return existing;

  // Build a generic def for any model not yet in the static list.
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
        error:
          'Antigravity CLI not found on PATH. Install it from antigravity.google and run "agy auth", then reconnect.',
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
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
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

    // Promise that resolves when the child exits.
    let exitCode = 0;
    const exitPromise = new Promise<number>((resolve) => {
      child.once('error', () => resolve(-1));
      child.once('exit', (code) => resolve(code ?? 0));
    });

    // Poll the log file while agy runs. Each `streamGenerateContent?alt=sse` line
    // marks one model request round. Rounds > 1 mean the agent ran a tool turn.
    let logOffset = 0;
    let sseRound = 0;

    const readNewLogEvents = (): ProviderEvent[] => {
      try {
        const content = readFileSync(logPath, 'utf-8');
        const newContent = content.slice(logOffset);
        logOffset = content.length;
        const matches = newContent.match(/streamGenerateContent\?alt=sse/g);
        if (!matches) return [];
        const events: ProviderEvent[] = [];
        for (let i = 0; i < matches.length; i++) {
          sseRound++;
          if (sseRound === 1) {
            // First round = initial request. Show a lightweight "thinking" signal.
            events.push({
              type: 'tool_executed',
              toolName: 'agy',
              toolInput: cliModel,
              toolOutput: 'Antigravity agent started',
              isError: false,
            });
          } else {
            // Subsequent rounds = the agent completed a tool turn and is re-querying.
            events.push({
              type: 'tool_executed',
              toolName: 'agy',
              toolInput: `turn ${sseRound}`,
              toolOutput: `Antigravity agent executed tools (turn ${sseRound - 1})`,
              isError: false,
            });
          }
        }
        return events;
      } catch {
        return [];
      }
    };

    // Interleave log polling with process completion.
    const POLL_INTERVAL_MS = 200;
    while (true) {
      const result = await Promise.race([
        exitPromise.then((code) => ({ done: true as const, code })),
        new Promise<{ done: false }>((res) => setTimeout(() => res({ done: false }), POLL_INTERVAL_MS)),
      ]);

      for (const event of readNewLogEvents()) {
        yield event;
      }

      if (result.done) {
        exitCode = result.code;
        // Drain any remaining log lines written before shutdown.
        for (const event of readNewLogEvents()) {
          yield event;
        }
        break;
      }
    }

    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', onAbort);

    // Clean up the temp log file.
    try {
      unlinkSync(logPath);
    } catch {
      /* best-effort */
    }

    if (request.signal?.aborted) return;

    if (exitCode === -1) {
      yield { type: 'error', error: 'Antigravity: failed to launch the agy CLI process.' };
      return;
    }

    const text = stdout.trim();
    if (!text && exitCode !== 0) {
      const hint = stderr.trim() || `agy exited with status ${exitCode}`;
      const loginHint = /not.*logged in|unauthorized|login|authenticate|api key/i.test(hint)
        ? ' — run "agy auth" (or set ANTIGRAVITY_API_KEY) to authenticate.'
        : '';
      yield { type: 'error', error: `Antigravity: ${hint.slice(0, 300)}${loginHint}` };
      return;
    }

    if (text) {
      // Chunk the text at word boundaries to give a streaming appearance.
      yield* chunkText(text);
    }
    yield { type: 'complete', finishReason: 'end_turn' };
  }
}

// Emit the plain-text response in small word-group chunks so the UI renders
// progressively rather than painting the whole answer at once.
function* chunkText(text: string): Generator<ProviderEvent> {
  const CHUNK_SIZE = 8; // words per chunk
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
