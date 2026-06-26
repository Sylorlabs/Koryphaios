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
//   → plain text response (no JSON output mode, unlike grok)

import type { ProviderConfig, ModelDef } from '@koryphaios/shared';
import { spawn } from 'node:child_process';
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

const AGY_TIMEOUT_MS = 300_000;
const DEFAULT_CLI_MODEL = 'Gemini 3.5 Flash (Medium)';

export class AntigravityProvider implements Provider {
  readonly name = 'antigravity' as const;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    if (this.config.disabled) return false;
    return !!this.config.authToken || detectAntigravityCLILogin();
  }

  listModels(): ModelDef[] {
    return getModelsForProvider('antigravity');
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
    const args = [
      '--print',
      prompt,
      '--model',
      cliModel,
      // Headless: never block on an interactive tool-approval prompt.
      '--dangerously-skip-permissions',
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

    const exitCode: number = await new Promise((resolve) => {
      child.once('error', () => resolve(-1));
      child.once('exit', (code) => resolve(code ?? 0));
    });

    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', onAbort);
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
      yield { type: 'content_delta', content: text };
    }
    yield { type: 'complete', finishReason: 'end_turn' };
  }
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
