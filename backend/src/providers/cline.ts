// Cline CLI provider — runs the official `cline` CLI harness.
//
// CLI-ONLY: Cline has its OWN provider/auth store (~/.cline/data/secrets.json,
// set once via `cline auth --provider … --apikey …`). Koryphaios never holds a
// Cline key — it shells out to the logged-in binary. Headless
// `cline -p <prompt> --act --yolo --json` emits newline-delimited JSON events
// (say/ask/tool/completion) which we translate to ProviderEvents.

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { spawn } from 'node:child_process';
import { whichBinary } from './cli-detection';
import { detectClineCLILogin } from './auth-utils';
import { providerLog } from '../logger';
import {
  type Provider,
  type ProviderEvent,
  type ProviderMessage,
  type StreamRequest,
} from './types';

const CLINE_STREAM_TIMEOUT_MS = 300_000;

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
            .map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image attachment]' : ''))
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

interface ClineEvent {
  type?: string; // 'say' | 'ask' | 'task_started' | 'error' | 'completion' | …
  say?: string; // 'text' | 'reasoning' | 'tool' | 'command' | 'api_req_started' | 'completion_result'
  ask?: string;
  text?: string;
}

export class ClineProvider implements Provider {
  readonly name = 'cline' as const;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    return !this.config.disabled && !!whichBinary('cline') && detectClineCLILogin();
  }

  listModels(): ModelDef[] {
    // Cline uses whatever provider/model its own config selects; expose a
    // single passthrough entry (the CLI resolves the actual model).
    return [
      {
        id: 'cline-default',
        name: 'Cline (configured model)',
        provider: 'cline',
        apiModelId: '',
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        supportsStreaming: true,
        supportsAttachments: false,
        canReason: true,
        reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
      } as ModelDef,
    ];
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const bin = whichBinary('cline');
    if (!bin) {
      yield { type: 'error', error: 'Cline CLI (cline) not found on PATH.' };
      return;
    }
    if (!detectClineCLILogin()) {
      yield {
        type: 'error',
        error:
          'Cline CLI is not signed in — run "cline auth --provider <p> --apikey <k>" (Cline manages its own key).',
      };
      return;
    }

    const prompt = buildPrompt(request.systemPrompt, request.messages);
    if (!prompt.trim()) {
      yield { type: 'error', error: 'Cline: empty prompt' };
      return;
    }

    const args = ['-p', prompt, '--act', '--yolo', '--json'];
    if (request.reasoningLevel && request.reasoningLevel !== 'auto') {
      const lvl = request.reasoningLevel.toLowerCase();
      if (['none', 'low', 'medium', 'high', 'xhigh'].includes(lvl)) {
        args.push('--reasoning-effort', lvl);
      }
    }
    const cliModel = request.model?.replace(/^cline-/, '');
    if (cliModel && cliModel !== 'default') args.push('--model', cliModel);

    const child = spawn(bin, args, {
      cwd: request.workingDirectory?.trim() || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* gone */
      }
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      providerLog.warn({ provider: 'cline' }, 'Cline harness timed out — killing CLI');
      onAbort();
    }, CLINE_STREAM_TIMEOUT_MS);
    timeout.unref?.();

    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));

    const decoder = new TextDecoder();
    let buffer = '';
    let sawContent = false;
    let lastText = '';

    try {
      for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
        if (request.signal?.aborted) break;
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;
          let ev: ClineEvent;
          try {
            ev = JSON.parse(line) as ClineEvent;
          } catch {
            continue;
          }
          for (const out of this.mapEvent(ev, () => lastText, (t) => (lastText = t))) {
            if (out.type === 'content_delta' || out.type === 'thinking_delta') sawContent = true;
            yield out;
          }
        }
      }
    } catch (err) {
      const aborted =
        request.signal?.aborted || (err instanceof Error && err.name === 'AbortError');
      if (!aborted) {
        yield {
          type: 'error',
          error: `Cline harness error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', onAbort);
      return;
    }

    const exitCode: number = await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(child.exitCode);
      child.once('exit', (code) => resolve(code ?? 0));
    });
    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', onAbort);
    if (request.signal?.aborted) return;

    if (exitCode !== 0 && !sawContent) {
      const hint = stderr.trim() || `cline exited with status ${exitCode}`;
      const loginHint = /sign in|unauthorized|auth|api key/i.test(hint)
        ? ' — run "cline auth --provider <p> --apikey <k>".'
        : '';
      yield { type: 'error', error: `Cline: ${hint.slice(0, 300)}${loginHint}` };
      return;
    }
    yield { type: 'complete', finishReason: 'end_turn' };
  }

  private *mapEvent(
    ev: ClineEvent,
    getLast: () => string,
    setLast: (t: string) => void,
  ): Generator<ProviderEvent> {
    // Cline emits cumulative `say:text` snapshots; diff against the last one so
    // the UI streams deltas, not repeated full text.
    if (ev.type === 'say' && ev.say === 'text' && typeof ev.text === 'string') {
      const full = ev.text;
      const prev = getLast();
      const delta = full.startsWith(prev) ? full.slice(prev.length) : full;
      setLast(full);
      if (delta) yield { type: 'content_delta', content: delta };
      return;
    }
    if (ev.type === 'say' && ev.say === 'reasoning' && ev.text) {
      yield { type: 'thinking_delta', thinking: ev.text };
      return;
    }
    if (ev.type === 'say' && (ev.say === 'tool' || ev.say === 'command') && ev.text) {
      yield {
        type: 'tool_executed',
        toolName: ev.say === 'command' ? 'bash' : 'tool',
        toolInput: '{}',
        toolOutput: ev.text.slice(0, 8_000),
      };
      return;
    }
    if (ev.type === 'say' && ev.say === 'completion_result' && ev.text) {
      const prev = getLast();
      const delta = ev.text.startsWith(prev) ? ev.text.slice(prev.length) : ev.text;
      setLast(ev.text);
      if (delta) yield { type: 'content_delta', content: delta };
      return;
    }
    if (ev.type === 'error' && ev.text) {
      yield { type: 'error', error: ev.text.slice(0, 300) };
      return;
    }
  }
}
