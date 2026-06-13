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
import { tmpdir } from 'node:os';
import {
  type Provider,
  type ProviderContentBlock,
  type ProviderEvent,
  type ProviderMessage,
  type StreamRequest,
  getModelsForProvider,
} from './types';
import { detectGrokCLILogin } from './auth-utils';
import { whichBinary } from './cli-detection';
import { providerLog } from '../logger';

const GROK_STREAM_TIMEOUT_MS = 300_000;
const DEFAULT_CLI_MODEL = 'grok-build-0.1';

export class GrokBuildProvider implements Provider {
  readonly name = 'grok' as const;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    if (this.config.disabled) return false;
    // Either the user explicitly connected (opt-in marker stored as authToken) or the
    // Grok Build CLI is logged in on this machine. The CLI itself owns the real credential.
    return !!this.config.authToken || detectGrokCLILogin();
  }

  listModels(): ModelDef[] {
    return getModelsForProvider('grok');
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
