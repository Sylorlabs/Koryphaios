// Google Antigravity CLI provider.
//
// Antigravity is distributed as Google's agent-first coding surface. The local CLI
// surface is not guaranteed to expose the same flags as Gemini/Cursor/Claude, so this
// provider only advertises models discovered from the installed CLI. It never invents
// an "auto" model when the CLI cannot list models.

import type { ProviderConfig, ModelDef } from '@koryphaios/shared';
import { spawn, spawnSync } from 'node:child_process';
import {
  type Provider,
  type ProviderContentBlock,
  type ProviderEvent,
  type ProviderMessage,
  type StreamRequest,
} from './types';
import { detectAntigravityCLILogin } from './auth-utils';
import { whichBinary } from './cli-detection';
import { providerLog } from '../logger';

const ANTIGRAVITY_STREAM_TIMEOUT_MS = 300_000;
const ANTIGRAVITY_MODEL_CACHE_MS = 10 * 60 * 1000;

let cachedModels: ModelDef[] | null = null;
let cachedModelsAt = 0;
let modelListError: string | undefined;

function antigravityBin(): string | null {
  // `agy` is the official binary name as of Antigravity 2.0 (I/O 2026).
  // Keep legacy names as fallbacks for older installs.
  return whichBinary('agy') ?? whichBinary('antigravity-cli') ?? whichBinary('antigravity');
}

function parseModelList(output: string): ModelDef[] {
  const models: ModelDef[] = [];
  const seen = new Set<string>();
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!line || /^(available models|models|[-=]+)$/i.test(line)) continue;
    const match = line.match(/^([A-Za-z0-9][\w.:/-]*)(?:\s+-\s+|\s{2,})(.+)?$/);
    const id = match?.[1] ?? (/^[A-Za-z0-9][\w.:/-]+$/.test(line) ? line : '');
    if (!id || seen.has(id) || /failed|error|usage/i.test(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: match?.[2]?.trim() || id,
      provider: 'antigravity',
      apiModelId: id,
      contextWindow: 0,
      maxOutputTokens: 32_000,
      costPerMInputTokens: 0,
      costPerMOutputTokens: 0,
      canReason: false,
      supportsAttachments: false,
      supportsStreaming: true,
      isGeneric: true,
      tier: 'flagship',
    });
  }
  return models;
}

function probeModels(): ModelDef[] {
  const bin = antigravityBin();
  if (!bin) {
    modelListError = 'Antigravity CLI not found on PATH.';
    return [];
  }
  for (const args of [['models'], ['--list-models'], ['model', 'list']]) {
    try {
      const result = spawnSync(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
        encoding: 'utf8',
        timeout: 8000,
      });
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
      const models = parseModelList(output);
      if (models.length > 0) {
        modelListError = undefined;
        return models;
      }
      if (output) modelListError = output.split('\n').slice(0, 3).join(' ').slice(0, 300);
    } catch (error: any) {
      modelListError = error?.message ?? String(error);
    }
  }
  modelListError =
    modelListError ||
    'The installed Antigravity CLI did not expose a non-interactive model-list command.';
  return [];
}

function flattenContent(content: string | ProviderContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) =>
      block.type === 'text' && block.text
        ? block.text
        : block.type === 'tool_result'
          ? `[tool result: ${block.toolOutput ?? ''}]`
          : '',
    )
    .filter(Boolean)
    .join('\n');
}

function buildPrompt(systemPrompt: string | undefined, messages: ProviderMessage[]): string {
  const lines: string[] = [];
  if (systemPrompt?.trim()) lines.push(systemPrompt.trim(), '');
  for (const message of messages) {
    if (message.role === 'system') continue;
    const text = flattenContent(message.content);
    if (!text.trim()) continue;
    lines.push(`${message.role}: ${text}`);
  }
  return lines.join('\n\n');
}

export class AntigravityProvider implements Provider {
  readonly name = 'antigravity' as const;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    if (this.config.disabled) return false;
    return !!antigravityBin() && (!!this.config.authToken || detectAntigravityCLILogin());
  }

  listModels(): ModelDef[] {
    if (cachedModels && Date.now() - cachedModelsAt < ANTIGRAVITY_MODEL_CACHE_MS) return cachedModels;
    cachedModels = probeModels();
    cachedModelsAt = Date.now();
    return cachedModels;
  }

  getStatusError(): string | undefined {
    return modelListError;
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const bin = antigravityBin();
    if (!bin) {
      yield { type: 'error', error: 'Antigravity CLI not found on PATH. Install Google Antigravity first.' };
      return;
    }

    const model = request.model.includes(':') ? request.model.split(':').slice(1).join(':') : request.model;
    const prompt = buildPrompt(request.systemPrompt, request.messages);
    if (!prompt.trim()) {
      yield { type: 'error', error: 'Antigravity: empty prompt' };
      return;
    }

    const attempts = [
      ['-p', prompt, '--output-format', 'stream-json', '--model', model],
      ['--prompt', prompt, '--output-format', 'stream-json', '--model', model],
      ['run', '--model', model, prompt],
    ];

    for (const args of attempts) {
      const result = await runOnce(bin, args, request);
      if (result.started) {
        yield* result.events;
        return;
      }
    }

    yield {
      type: 'error',
      error:
        'The installed Antigravity CLI does not expose a supported headless prompt interface. Update/install the official Antigravity CLI, then reconnect.',
    };
  }
}

async function runOnce(
  bin: string,
  args: string[],
  request: StreamRequest,
): Promise<{ started: boolean; events: AsyncGenerator<ProviderEvent> }> {
  async function* events(): AsyncGenerator<ProviderEvent> {
    const child = spawn(bin, args, {
      cwd: request.workingDirectory?.trim() || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      providerLog.warn({ provider: 'antigravity' }, 'Antigravity CLI harness timed out');
      try {
        child.kill('SIGTERM');
      } catch {
        /* noop */
      }
    }, ANTIGRAVITY_STREAM_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number>((resolve) => {
      child.once('error', () => resolve(-1));
      child.once('exit', (exitCode) => resolve(exitCode ?? 0));
    });
    clearTimeout(timeout);
    if (code !== 0) {
      yield { type: 'error', error: (stderr || stdout || `Antigravity CLI exited with ${code}`).slice(0, 500) };
      return;
    }
    const text = parseText(stdout);
    if (text) yield { type: 'content_delta', content: text };
    yield { type: 'complete', finishReason: 'end_turn' };
  }
  return { started: true, events: events() };
}

function parseText(raw: string): string {
  const chunks: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const json = JSON.parse(trimmed);
      const text =
        json.text ??
        json.content ??
        json.message?.content?.map?.((part: any) => part?.text).filter(Boolean).join('') ??
        json.result;
      if (typeof text === 'string') chunks.push(text);
    } catch {
      chunks.push(line);
    }
  }
  return chunks.join('\n').trim();
}
