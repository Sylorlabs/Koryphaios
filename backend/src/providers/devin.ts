// Devin CLI provider — runs Cognition's official `devin` CLI harness.
//
// Like the other subscription CLIs (claude-code, cursor): no API key needed in
// Koryphaios — the locally logged-in `devin` binary authenticates itself.
// Headless `-p` streams the answer text to stdout; the richer trajectory
// (per-step reasoning, tool calls with output, and exact token usage) is
// written to an `--export` JSON file which we tail for tools + usage.
//
// Model list + reasoning: Devin exposes a fixed set of named models (SWE-1.6,
// Claude, GPT, Gemini, GLM, Kimi families) selected via --model. There is NO
// separate reasoning-effort flag — the tier is part of the model name
// (e.g. swe-1.6-fast / swe-1.6-slow), so we surface models only.

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { whichBinary } from './cli-detection';
import { detectDevinCLILogin } from './auth-utils';
import { providerLog } from '../logger';
import { buildSoftJail, wrapCommand } from '../collaboration/sandbox-runner';
import {
  type Provider,
  type ProviderEvent,
  type ProviderMessage,
  type StreamRequest,
} from './types';

const DEVIN_STREAM_TIMEOUT_MS = 300_000;
const EXPORT_POLL_MS = 250;

// Verified live from `devin -p "hi" --model <bad>` → "Available: …".
const DEVIN_MODELS: Array<{ id: string; name: string; ctx?: number }> = [
  { id: 'swe-1.6', name: 'SWE-1.6' },
  { id: 'swe-1.6-fast', name: 'SWE-1.6 Fast' },
  { id: 'swe-1.6-slow', name: 'SWE-1.6 Slow' },
  { id: 'swe-1.5', name: 'SWE-1.5' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', ctx: 1_000_000 },
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', ctx: 200_000 },
  { id: 'claude-opus-4.8', name: 'Claude Opus 4.8', ctx: 1_000_000 },
  { id: 'claude-opus-4.5', name: 'Claude Opus 4.5', ctx: 200_000 },
  { id: 'claude-fable-5', name: 'Claude Fable 5', ctx: 1_000_000 },
  { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', ctx: 200_000 },
  { id: 'gpt-5.5', name: 'GPT-5.5' },
  { id: 'gpt-5.2', name: 'GPT-5.2' },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', ctx: 1_000_000 },
  { id: 'glm-5.2', name: 'GLM-5.2' },
  { id: 'kimi-k2.7', name: 'Kimi K2.7' },
];

const HARNESS_SYSTEM_NOTE =
  'You are running inside the Koryphaios orchestrator. Never spawn subagents or delegate to ' +
  'other agents yourself; if work should be parallelized or delegated, say so in your response ' +
  'and Koryphaios will dispatch its own worker agents.';

function buildPrompt(systemPrompt: string | undefined, messages: ProviderMessage[]): string {
  const lines: string[] = [];
  const sys = systemPrompt?.trim();
  lines.push(sys ? `${sys}\n\n${HARNESS_SYSTEM_NOTE}` : HARNESS_SYSTEM_NOTE, '');
  for (const m of messages) {
    const content =
      typeof m.content === 'string'
        ? m.content
        : m.content
            .map((b) =>
              b.type === 'text' ? b.text : b.type === 'image' ? '[image attachment]' : '',
            )
            .filter(Boolean)
            .join('\n');
    if (!content.trim()) continue;
    if (m.role === 'user') lines.push(`User: ${content}`);
    else if (m.role === 'assistant') lines.push(`Assistant: ${content}`);
    else if (m.role === 'tool') lines.push(`Tool result: ${content.slice(0, 8_000)}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

interface DevinExportStep {
  step_id?: number;
  source?: string;
  message?: string;
  reasoning_content?: string;
  tool_calls?: Array<{ function_name?: string; arguments?: unknown }>;
  observation?: { results?: Array<{ content?: string }> };
}

interface DevinExport {
  steps?: DevinExportStep[];
  final_metrics?: {
    total_prompt_tokens?: number;
    total_completion_tokens?: number;
    total_cached_tokens?: number;
  };
}

export class DevinProvider implements Provider {
  readonly name = 'devin' as const;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    return !this.config.disabled && !!whichBinary('devin') && detectDevinCLILogin();
  }

  listModels(): ModelDef[] {
    return DEVIN_MODELS.map(
      (m) =>
        ({
          id: `devin-${m.id}`,
          name: m.name,
          provider: 'devin',
          apiModelId: m.id,
          contextWindow: m.ctx ?? 200_000,
          contextVerified: !!m.ctx,
          maxOutputTokens: 32_000,
          supportsStreaming: true,
          supportsAttachments: false,
          canReason: true,
        }) as ModelDef,
    );
  }

  private resolveCliModel(modelId: string | undefined): string | undefined {
    if (!modelId) return undefined;
    const def = this.listModels().find((m) => m.id === modelId || m.apiModelId === modelId);
    return def?.apiModelId ?? modelId.replace(/^devin-/, '');
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const bin = whichBinary('devin');
    if (!bin) {
      yield { type: 'error', error: 'Devin CLI (devin) not found on PATH.' };
      return;
    }
    if (!detectDevinCLILogin()) {
      yield {
        type: 'error',
        error: 'Devin CLI is not logged in — run "devin auth login" (or set COGNITION_API_KEY).',
      };
      return;
    }

    const prompt = buildPrompt(request.systemPrompt, request.messages);
    if (!prompt.trim()) {
      yield { type: 'error', error: 'Devin: empty prompt' };
      return;
    }

    const exportPath = join(tmpdir(), `devin-${Date.now()}-${Math.round(performance.now())}.json`);
    const args = [
      '-p',
      prompt,
      // Non-interactive: auto-approve so a headless run never blocks. Koryphaios
      // remains the permission/orchestration owner.
      '--permission-mode',
      'dangerous',
      '--export',
      exportPath,
    ];
    const cliModel = this.resolveCliModel(request.model);
    if (cliModel) args.push('--model', cliModel);

    const cwd = request.workingDirectory?.trim() || process.cwd();
    const jail = request.sandbox ? buildSoftJail(process.env, [join(homedir(), '.devin')]) : null;
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
        /* gone */
      }
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    child.once('close', () => jail?.cleanup());
    const timeout = setTimeout(() => {
      providerLog.warn({ provider: 'devin' }, 'Devin harness timed out — killing CLI');
      onAbort();
    }, DEVIN_STREAM_TIMEOUT_MS);
    timeout.unref?.();

    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));

    // Live text from stdout.
    const stdoutQueue: string[] = [];
    let fullStdout = '';
    child.stdout.on('data', (c: Buffer) => {
      const t = c.toString();
      fullStdout += t;
      stdoutQueue.push(t);
    });

    const exitPromise = new Promise<number>((resolve) => {
      child.once('error', () => resolve(-1));
      child.once('exit', (code) => resolve(code ?? 0));
    });

    let sawContent = false;
    while (true) {
      const settled = await Promise.race([
        exitPromise.then((code) => ({ done: true as const, code })),
        new Promise<{ done: false }>((r) => setTimeout(() => r({ done: false }), EXPORT_POLL_MS)),
      ]);
      while (stdoutQueue.length > 0) {
        const chunk = stdoutQueue.shift()!;
        if (chunk) {
          sawContent = true;
          yield { type: 'content_delta', content: chunk };
        }
      }
      if (settled.done) {
        clearTimeout(timeout);
        request.signal?.removeEventListener('abort', onAbort);
        if (request.signal?.aborted) {
          this.cleanup(exportPath);
          return;
        }
        // Drain any trailing stdout.
        while (stdoutQueue.length > 0) {
          const chunk = stdoutQueue.shift()!;
          if (chunk) {
            sawContent = true;
            yield { type: 'content_delta', content: chunk };
          }
        }
        if (settled.code === -1) {
          yield { type: 'error', error: 'Devin: failed to launch the devin CLI process.' };
          this.cleanup(exportPath);
          return;
        }
        if (settled.code !== 0 && !sawContent) {
          const hint = stderr.trim() || `devin exited with status ${settled.code}`;
          const loginHint = /not.*logged in|unauthorized|login|authenticate|api key/i.test(hint)
            ? ' — run "devin auth login".'
            : '';
          yield { type: 'error', error: `Devin: ${hint.slice(0, 300)}${loginHint}` };
          this.cleanup(exportPath);
          return;
        }
        // Surface tools + reasoning + usage from the export trajectory.
        yield* this.drainExport(exportPath);
        yield { type: 'complete', finishReason: 'end_turn' };
        this.cleanup(exportPath);
        return;
      }
    }
  }

  private *drainExport(exportPath: string): Generator<ProviderEvent> {
    if (!existsSync(exportPath)) return;
    let data: DevinExport;
    try {
      data = JSON.parse(readFileSync(exportPath, 'utf-8')) as DevinExport;
    } catch {
      return;
    }
    for (const step of data.steps ?? []) {
      if (step.source !== 'agent') continue;
      if (step.reasoning_content?.trim()) {
        yield { type: 'thinking_delta', thinking: step.reasoning_content };
      }
      for (const call of step.tool_calls ?? []) {
        const outputs = step.observation?.results?.map((r) => r.content ?? '').join('\n') ?? '';
        yield {
          type: 'tool_executed',
          toolName: call.function_name ?? 'tool',
          toolInput: JSON.stringify(call.arguments ?? {}),
          toolOutput: outputs.slice(0, 8_000),
        };
      }
    }
    const m = data.final_metrics;
    if (m && (m.total_prompt_tokens || m.total_completion_tokens)) {
      yield {
        type: 'usage_update',
        // prompt tokens INCLUDE cached (total_cached_tokens is a breakdown) —
        // no separate tokensCache, so billing counts the real total once.
        tokensIn: m.total_prompt_tokens ?? 0,
        tokensOut: m.total_completion_tokens ?? 0,
      };
    }
  }

  private cleanup(exportPath: string): void {
    try {
      if (existsSync(exportPath)) unlinkSync(exportPath);
    } catch {
      /* best-effort */
    }
  }
}

// Re-export for detection modules that only need the home dir.
export const DEVIN_CREDENTIALS = join(homedir(), '.local', 'share', 'devin', 'credentials.toml');
