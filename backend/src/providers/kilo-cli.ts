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
//
// Usage: single-turn completion; continuation via --continue/--session is left
// for future work.

import type { ProviderConfig, ModelDef } from '@koryphaios/shared';
import { spawn, spawnSync } from 'node:child_process';
import {
  type Provider,
  type ProviderEvent,
  type ProviderMessage,
  type ProviderContentBlock,
  type StreamRequest,
  type CliCommand,
  getModelsForProvider,
} from './types';
import { whichBinary } from './cli-detection';
import { providerLog } from '../logger';

const KILO_CLI_TIMEOUT_MS = 300_000;
const KILO_CLI_AUTH_MARKER = 'cli:kilo:connected';

function detectKiloLogin(): boolean {
  const bin = whichBinary('kilo');
  if (!bin) return false;
  try {
    const result = spawnSync(bin, ['profile', '--json'], { timeout: 5_000, encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout) return false;
    const profile = JSON.parse(result.stdout);
    return !!(profile.email || profile.name);
  } catch {
    return false;
  }
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

  isAvailable(): boolean {
    if (this.config.disabled) return false;
    return !!this.config.authToken || detectKiloLogin();
  }

  getCliCommands(): CliCommand[] {
    return KILO_CLI_COMMANDS;
  }

  listModels(): ModelDef[] {
    return getModelsForProvider('kilocode');
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

    // Resolve the model arg — use the apiModelId if defined (e.g. "kilo-auto/frontier")
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
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      providerLog.warn({ provider: 'kilocode' }, 'Kilo CLI harness timed out — killing');
      try { child.kill('SIGKILL'); } catch { /* noop */ }
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
          try { ev = JSON.parse(line); } catch { continue; }

          const part = ev.part as Record<string, unknown> | undefined;
          if (ev.type === 'text' && part && typeof part.text === 'string' && part.text) {
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
  // e.g. "kilocode/kilo-auto/frontier" → "kilo-auto/frontier"
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
  // For single-turn, just return the last user message
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (lastUser) return flattenContent(lastUser.content);
  return turns.join('\n\n');
}

function flattenContent(content: string | ProviderContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('');
}
