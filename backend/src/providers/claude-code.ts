// Claude Code subscription provider — runs the OFFICIAL `claude` CLI harness.
//
// COMPLIANCE: A Claude Pro/Max subscription OAuth token must only be used through
// Anthropic's own Claude Code product, NOT to call api.anthropic.com directly. So,
// unlike AnthropicProvider (which takes an API key and hits the SDK), this provider
// never holds or transmits the subscription token. It shells out to the locally
// installed, logged-in `claude` CLI in headless print mode (`-p --output-format
// stream-json`), which authenticates each request itself, and translates the CLI's
// NDJSON event stream into Koryphaios ProviderEvents.
//
// The CLI's own agentic tools are disabled so it behaves as a streaming text/thinking
// generator: Koryphaios remains the single owner of tool execution and permissions.

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
import { detectClaudeCodeLogin } from './auth-utils';
import { providerLog } from '../logger';
import { recordClaudeCodeRateLimit } from '../credit-accountant';

const CLAUDE_STREAM_TIMEOUT_MS = 300_000;
const DEFAULT_CLI_MODEL = 'sonnet';

// Claude Code's built-in agentic tools — disabled so this acts as a pure model
// endpoint. Koryphaios drives its own tool loop for every provider.
const DISABLED_TOOLS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'TodoWrite',
].join(',');

interface ClaudeStreamEnvelope {
  type: string;
  subtype?: string;
  // stream_event payloads carry the raw Anthropic SSE event
  event?: {
    type: string;
    delta?: { type?: string; text?: string; thinking?: string };
    content_block?: { type?: string; thinking?: string };
    message?: { usage?: ClaudeUsage };
  };
  // result payloads
  is_error?: boolean;
  result?: string;
  stop_reason?: string;
  usage?: ClaudeUsage;
  total_cost_usd?: number;
  // error payloads
  error?: string | { message?: string };
  message?: string;
  // rate_limit_event payloads
  rate_limit_info?: ClaudeRateLimitInfo;
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ClaudeRateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
}

export class ClaudeCodeProvider implements Provider {
  readonly name = 'claude' as const;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    if (this.config.disabled) return false;
    // Either the user explicitly connected (marker stored as authToken) or the
    // CLI is logged in on this machine. The CLI itself owns the real credential.
    return !!this.config.authToken || detectClaudeCodeLogin();
  }

  listModels(): ModelDef[] {
    return getModelsForProvider('claude');
  }

  private resolveCliModel(modelId: string): string {
    const model = this.listModels().find((m) => m.id === modelId || m.apiModelId === modelId);
    if (model?.apiModelId) return model.apiModelId;
    // Accept bare aliases / full ids passed through directly.
    if (/^(opus|sonnet|haiku)\b/i.test(modelId) || /^claude-/i.test(modelId)) return modelId;
    return DEFAULT_CLI_MODEL;
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const cliModel = this.resolveCliModel(request.model);
    const prompt = buildPrompt(request.messages);

    if (!prompt.trim()) {
      yield { type: 'error', error: 'Claude Code: empty prompt' };
      return;
    }

    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model',
      cliModel,
      '--disallowed-tools',
      DISABLED_TOOLS,
    ];
    if (request.systemPrompt?.trim()) {
      args.push('--append-system-prompt', request.systemPrompt);
    }

    const child = spawn('claude', args, {
      // Neutral working dir: this is a generation endpoint, not an in-repo agent.
      cwd: tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
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
      providerLog.warn({ provider: 'claude' }, 'Claude Code harness timed out — killing CLI');
      onAbort();
    }, CLAUDE_STREAM_TIMEOUT_MS);
    timeout.unref?.();

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Feed the prompt via stdin (no arg-length limits, no shell escaping).
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (err) {
      providerLog.error({ provider: 'claude', err }, 'Failed to write prompt to Claude Code stdin');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let sawContent = false;
    let emittedComplete = false;

    try {
      for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const raw = line.trim();
          if (!raw) continue;
          let envelope: ClaudeStreamEnvelope;
          try {
            envelope = JSON.parse(raw) as ClaudeStreamEnvelope;
          } catch {
            continue;
          }
          for (const event of this.mapEnvelope(envelope)) {
            if (event.type === 'content_delta' || event.type === 'thinking_delta') {
              sawContent = true;
            }
            if (event.type === 'complete') emittedComplete = true;
            yield event;
          }
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof Error && err.name === 'AbortError')) {
        yield { type: 'error', error: `Claude Code harness error: ${message}` };
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
      const hint = stderr.trim() || 'Claude Code CLI exited with a non-zero status';
      const loginHint = /not.*logged in|unauthorized|login|authenticate/i.test(hint)
        ? ' — run "claude login" to sign in with your Claude subscription.'
        : '';
      yield { type: 'error', error: `Claude Code: ${hint.slice(0, 300)}${loginHint}` };
      return;
    }

    if (!emittedComplete) {
      yield { type: 'complete', finishReason: 'end_turn' };
    }
  }

  private *mapEnvelope(envelope: ClaudeStreamEnvelope): Generator<ProviderEvent> {
    switch (envelope.type) {
      case 'stream_event': {
        const event = envelope.event;
        if (!event) return;
        if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            yield { type: 'content_delta', content: delta.text };
          } else if (delta?.type === 'thinking_delta' && delta.thinking) {
            yield { type: 'thinking_delta', thinking: delta.thinking };
          }
        } else if (event.type === 'message_start' && event.message?.usage) {
          const u = event.message.usage;
          yield {
            type: 'usage_update',
            tokensIn: u.input_tokens,
            tokensOut: u.output_tokens,
            tokensCache: u.cache_read_input_tokens,
          };
        }
        return;
      }
      case 'rate_limit_event': {
        // Subscription quota signal — surfaced to the billing/subscription route.
        if (envelope.rate_limit_info) {
          recordClaudeCodeRateLimit(envelope.rate_limit_info);
        }
        return;
      }
      case 'result': {
        if (envelope.usage) {
          yield {
            type: 'usage_update',
            tokensIn: envelope.usage.input_tokens,
            tokensOut: envelope.usage.output_tokens,
            tokensCache: envelope.usage.cache_read_input_tokens,
          };
        }
        if (envelope.is_error) {
          yield {
            type: 'error',
            error: extractError(envelope) ?? 'Claude Code request failed',
          };
          return;
        }
        yield {
          type: 'complete',
          finishReason: envelope.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn',
        };
        return;
      }
      case 'error': {
        yield { type: 'error', error: extractError(envelope) ?? 'Claude Code error' };
        return;
      }
      default:
        return;
    }
  }
}

function extractError(envelope: ClaudeStreamEnvelope): string | undefined {
  if (typeof envelope.error === 'string') return envelope.error;
  if (envelope.error && typeof envelope.error === 'object' && envelope.error.message) {
    return envelope.error.message;
  }
  if (typeof envelope.message === 'string') return envelope.message;
  if (typeof envelope.result === 'string' && envelope.is_error) return envelope.result;
  return undefined;
}

/** Serialize the conversation into a single prompt for the CLI's print mode. */
function buildPrompt(messages: ProviderMessage[]): string {
  const turns = messages.filter((m) => m.role !== 'system');

  // Single user turn → send its text verbatim (most common chat case).
  if (turns.length === 1 && turns[0].role === 'user') {
    return flattenContent(turns[0].content);
  }

  const lines: string[] = [];
  for (const m of turns) {
    const text = flattenContent(m.content);
    if (!text.trim()) continue;
    const label =
      m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool result' : 'User';
    lines.push(`${label}: ${text}`);
  }
  return lines.join('\n\n');
}

function flattenContent(content: string | ProviderContentBlock[]): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      parts.push(`[tool call: ${block.toolName ?? 'tool'} ${JSON.stringify(block.toolInput ?? {})}]`);
    } else if (block.type === 'tool_result') {
      parts.push(`[tool result: ${block.toolOutput ?? ''}]`);
    } else if (block.type === 'image') {
      parts.push('[image attachment omitted — Claude Code harness is text-only]');
    }
  }
  return parts.join('\n');
}
