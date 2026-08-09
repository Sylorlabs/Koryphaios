// Kilo Code CLI provider — runs the official `kilo` CLI as a headless harness.
//
// Like ClaudeCodeProvider, this drives the locally installed, logged-in kilo CLI
// in headless JSON mode (`kilo run --format json`) so Koryphaios never holds the
// credential. The CLI owns auth (kilo.ai account or local API key).
//
// Stream format (verified):
//   step_start  { part.type: 'step-start' }
//   text        { part.text: string }  ← content delta
//   step_finish { part.tokens: { input, output, total, reasoning }, part.reason }
//   error       { error: { name, data: { message } } }
//
// Usage: single-turn completion; continuation via --continue/--session is left
// for future work.

import type { ProviderConfig, ModelDef } from '@koryphaios/shared';
import { spawn } from 'node:child_process';
import {
  type Provider,
  type ProviderEvent,
  type ProviderMessage,
  type ProviderContentBlock,
  type StreamRequest,
  type CliCommand,
} from './types';
import { whichBinary } from './cli-detection';
import { detectKiloCLILogin } from './auth-utils';
import { providerLog } from '../logger';

const KILO_CLI_TIMEOUT_MS = 300_000;
const KILO_MODELS_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

// ─── Model list parsing ────────────────────────────────────────────────────
//
// `kilo models` prints one model per line in `kilo/<provider>/<model>` format.
// Lines starting with `kilo/~` are alias/latest shortcuts — included.

function parseKiloModelList(output: string): ModelDef[] {
  const models: ModelDef[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!line || !line.startsWith('kilo/')) continue;
    const apiModelId = line;
    const id = `kilocode/${line}`;
    const shortName = line.split('/').pop() ?? line;
    models.push({
      id,
      name: shortName,
      provider: 'kilocode',
      apiModelId,
      contextWindow: 200_000, // conservative default; kilo doesn't report per-model
      maxOutputTokens: 16_384,
      supportsStreaming: true,
    });
  }
  return models;
}

// Kilo CLI slash commands (TUI commands runnable in Koryphaios via "/" palette).
const KILO_CLI_COMMANDS: CliCommand[] = [
  { name: 'clear', description: 'Clear conversation and start fresh', category: 'builtin' },
  { name: 'help', description: 'Show available Kilo commands and options', category: 'builtin' },
  { name: 'compact', description: 'Summarize and compress conversation context', category: 'builtin' },
  { name: 'cost', description: 'Show token usage and cost for this session', category: 'builtin' },
  { name: 'models', description: 'List available Kilo models', category: 'builtin' },
  { name: 'stats', description: 'Show session statistics and token usage', category: 'builtin' },
  { name: 'memory', description: 'Manage Kilo memory', category: 'builtin' },
];

export class KiloCodeCLIProvider implements Provider {
  readonly name = 'kilocode' as const;

  constructor(readonly config: ProviderConfig) {}

  private cachedModels: ModelDef[] | null = null;
  private modelsFetchedAt = 0;
  private modelsInFlight = false;

  isAvailable(): boolean {
    if (this.config.disabled) return false;
    return !!this.config.authToken || detectKiloCLILogin();
  }

  getCliCommands(): CliCommand[] {
    return KILO_CLI_COMMANDS;
  }

  listModels(): ModelDef[] {
    if (!this.cachedModels || Date.now() - this.modelsFetchedAt > KILO_MODELS_CACHE_TTL_MS) {
      this.refreshModels();
    }
    return this.cachedModels ?? [];
  }

  refreshModels(): void {
    // Non-blocking: spawn kilo models asynchronously so the event loop is
    // never blocked (spawnSync would stall the server for ~3s on every call).
    if (this.modelsInFlight) return;
    const bin = whichBinary('kilo');
    if (!bin) {
      providerLog.debug({ provider: 'kilocode' }, 'Kilo CLI not found — skipping model refresh');
      return;
    }
    this.modelsInFlight = true;
    const child = spawn(bin, ['models'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    const finish = () => {
      this.modelsInFlight = false;
      const models = parseKiloModelList(out);
      if (models.length > 0) {
        this.cachedModels = models;
        this.modelsFetchedAt = Date.now();
        providerLog.info({ provider: 'kilocode', count: models.length }, 'Kilo CLI model list refreshed');
      } else {
        providerLog.debug({ provider: 'kilocode' }, 'Kilo CLI model list empty');
      }
    };
    child.on('close', finish);
    child.on('error', (err) => {
      this.modelsInFlight = false;
      providerLog.debug({ err: err.message }, 'Kilo CLI model refresh failed');
    });
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const bin = whichBinary('kilo');
    if (!bin) {
      yield {
        type: 'error',
        error: 'Kilo CLI not found on PATH. Install it with: npm install -g @kilocode/cli',
      };
      return;
    }

    const prompt = buildKiloPrompt(request.systemPrompt, request.messages);
    if (!prompt.trim()) {
      yield { type: 'error', error: 'Kilo: empty prompt' };
      return;
    }

    // Resolve the model arg — strip the "kilocode/" prefix Koryphaios adds
    // e.g. "kilocode/kilo/kilo-auto/free" → "kilo/kilo-auto/free"
    const modelArg = resolveKiloModel(request.model);

    const args = ['run', prompt, '--format', 'json'];
    if (modelArg) args.push('-m', modelArg);

    const cwd = request.workingDirectory?.trim() || process.cwd();
    const child = spawn(bin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch (err: unknown) { /* already gone */ providerLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Kilo CLI abort kill failed (process already gone)'); }
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      providerLog.warn({ provider: 'kilocode' }, 'Kilo CLI harness timed out — killing');
      try { child.kill('SIGKILL'); } catch (err: unknown) { providerLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Kilo CLI child already gone on timeout kill'); }
    }, KILO_CLI_TIMEOUT_MS);

    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    let emittedComplete = false;

    try {
      let buf = '';
      for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line || line[0] !== '{') continue;

          let ev: Record<string, unknown>;
          try { ev = JSON.parse(line); } catch (err: unknown) { providerLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Kilo CLI skipping non-JSON line'); continue; }

          const part = ev.part as Record<string, unknown> | undefined;
          if (ev.type === 'error') {
            const error = ev.error as Record<string, unknown> | undefined;
            const message = (error?.data as Record<string, unknown> | undefined)?.message
              ?? error?.name
              ?? 'Kilo CLI error';
            yield { type: 'error', error: String(message) };
          } else if (ev.type === 'text' && part && typeof part.text === 'string' && part.text) {
            yield { type: 'content_delta', content: part.text };
          } else if (ev.type === 'step_finish' && part) {
            const tokens = part.tokens as Record<string, unknown> | undefined;
            if (tokens) {
              yield {
                type: 'usage_update',
                tokensIn: Number(tokens.input ?? 0),
                tokensOut: Number(tokens.output ?? 0),
              };
            }
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
            error: `Kilo CLI exited (${code}): ${stderr.slice(0, 300) || 'no output'}`,
          };
        } else {
          yield { type: 'complete', finishReason: 'end_turn' };
        }
      }
    } catch (err: unknown) {
      yield { type: 'error', error: `Kilo CLI error: ${String(err).slice(0, 300)}` };
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', onAbort);
    }
  }
}

function resolveKiloModel(modelId: string): string | undefined {
  // Strip the "kilocode/" prefix from model IDs stored in Koryphaios
  // e.g. "kilocode/kilo/kilo-auto/free" → "kilo/kilo-auto/free"
  if (modelId.startsWith('kilocode/')) return modelId.slice('kilocode/'.length);
  return modelId || undefined;
}

function buildKiloPrompt(systemPrompt: string | undefined, messages: ProviderMessage[]): string {
  const turns: string[] = [];
  if (systemPrompt?.trim()) turns.push(`[System: ${systemPrompt.trim()}]`);
  for (const m of messages) {
    if (m.role === 'system') continue;
    const content = flattenContent(m.content);
    if (content.trim()) turns.push(`${m.role === 'assistant' ? 'Assistant' : 'User'}: ${content}`);
  }
  // For single-turn, prepend the system prompt (if any) to the last user
  // message. Without this, compaction drops its system prompt and the model
  // doesn't know to produce JSON.
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (lastUser) {
    const userContent = flattenContent(lastUser.content);
    if (systemPrompt?.trim()) {
      return `[System: ${systemPrompt.trim()}]\n\n${userContent}`;
    }
    return userContent;
  }
  return turns.join('\n\n');
}

function flattenContent(content: string | ProviderContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('');
}
