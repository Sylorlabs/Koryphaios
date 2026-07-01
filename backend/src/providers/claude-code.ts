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
import {
  type Provider,
  type ProviderContentBlock,
  type ProviderEvent,
  type ProviderMessage,
  type StreamRequest,
  getModelsForProvider,
  resolveModel,
} from './types';
import { detectClaudeCodeLogin } from './auth-utils';
import { providerLog } from '../logger';
import { recordClaudeCodeRateLimit } from '../credit-accountant';
import { ClaudeCodeModels } from './models/claude-code';

const CLAUDE_STREAM_TIMEOUT_MS = 300_000;
const DEFAULT_CLI_MODEL = 'sonnet';
const MODELS_CACHE_TTL_MS = 5 * 60_000;

// ── Dynamic alias → real model ID discovery ────────────────────────────────

// Module-level cache shared across all provider instances.
let cachedModels: ModelDef[] | null = null;
let cachedModelsAt = 0;
let refreshInProgress = false;

/**
 * Probe a single claude alias (e.g. 'opus') by spawning a minimal headless
 * run and reading the first assistant message's `model` field. Kills the child
 * immediately after getting the ID so we spend negligible tokens.
 */
async function probeAlias(alias: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('claude', ['-p', '.', '--output-format', 'stream-json', '--model', alias], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env },
    });

    let buf = '';
    let settled = false;

    const done = (id: string | null) => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      resolve(id);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const d = JSON.parse(line.trim()) as Record<string, unknown>;
          if (
            d.type === 'assistant' &&
            d.message &&
            typeof d.message === 'object' &&
            typeof (d.message as Record<string, unknown>).model === 'string'
          ) {
            done((d.message as Record<string, unknown>).model as string);
            return;
          }
        } catch { /* skip non-JSON */ }
      }
    });

    child.once('exit', () => done(null));
    child.once('error', () => done(null));
    // Hard timeout so a hung probe never stalls the refresh.
    setTimeout(() => done(null), 12_000);
  });
}

/** Convert a real model ID to a human display name.
 *  claude-opus-4-8        → "Claude Opus 4.8"
 *  claude-haiku-4-5-20251001 → "Claude Haiku 4.5"
 *  claude-fable-5         → "Claude Fable 5"
 */
function realIdToName(id: string): string {
  // family + two-part version, optional date suffix
  const m = id.match(/^claude-([a-z]+)-(\d+)-(\d+)/);
  if (m) {
    const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    return `Claude ${family} ${m[2]}.${m[3]}`;
  }
  // family + single version (e.g. claude-fable-5)
  const s = id.match(/^claude-([a-z]+)-(\d+)$/);
  if (s) {
    const family = s[1].charAt(0).toUpperCase() + s[1].slice(1);
    return `Claude ${family} ${s[2]}`;
  }
  return id;
}

function refreshModelsInBackground(): void {
  if (refreshInProgress) return;
  refreshInProgress = true;

  const aliases = ClaudeCodeModels.map((m) => m.apiModelId!);

  Promise.all(aliases.map((alias) => probeAlias(alias)))
    .then((results) => {
      const models: ModelDef[] = ClaudeCodeModels.map((base, i) => {
        const realId = results[i];
        if (!realId) return base;
        // The probe confirmed which real Anthropic model the alias resolves to —
        // inherit that model's documented context window, output limit, and
        // reasoning capability instead of the wrapper's hardcoded guesses.
        const real = resolveModel(realId);
        const realTrusted = !!real && !real.isGeneric && real.provider === 'anthropic';
        return {
          ...base,
          realModelId: realId,
          name: realIdToName(realId),
          ...(realTrusted && real.contextWindow > 0
            ? { contextWindow: real.contextWindow, contextVerified: true }
            : {}),
          ...(realTrusted && real.maxOutputTokens > 0
            ? { maxOutputTokens: real.maxOutputTokens }
            : {}),
          ...(realTrusted && real.canReason !== undefined ? { canReason: real.canReason } : {}),
          ...(realTrusted && real.reasoningLevels?.length
            ? { reasoningLevels: real.reasoningLevels }
            : {}),
        };
      });
      cachedModels = models;
      cachedModelsAt = Date.now();
      providerLog.debug({ provider: 'claude', models: models.map((m) => m.name) }, 'Claude Code model names refreshed');
    })
    .catch((err) => {
      providerLog.warn({ provider: 'claude', err }, 'Claude Code alias probe failed');
    })
    .finally(() => {
      refreshInProgress = false;
    });
}

// Claude Code runs as a FULL AGENT here: it executes its OWN tools (Write/Edit/Bash/…) in
// the project directory, and we parse its stream to surface progress, tool activity, and
// file edits (the live diff preview). We pre-approve the standard toolset so a headless
// `-p` run never blocks on an interactive permission prompt.
const ALLOWED_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'Glob',
  'Grep',
  'LS',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
].join(',');

interface ClaudeToolUseBlock {
  type: string; // 'text' | 'tool_use' | 'tool_result'
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // tool_result blocks (in user messages)
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | Array<{ type?: string; text?: string }>;
}

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
  // assistant/user payloads carry a full message with content blocks (tool_use/tool_result)
  message?:
    | string
    | { content?: ClaudeToolUseBlock[]; usage?: ClaudeUsage };
  // result payloads
  is_error?: boolean;
  result?: string;
  stop_reason?: string;
  usage?: ClaudeUsage;
  total_cost_usd?: number;
  // error payloads
  error?: string | { message?: string };
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
    const available = !!this.config.authToken || detectClaudeCodeLogin();
    if (available && Date.now() - cachedModelsAt > MODELS_CACHE_TTL_MS) {
      refreshModelsInBackground();
    }
    return available;
  }

  listModels(): ModelDef[] {
    const fallback = getModelsForProvider('claude');
    if (cachedModels && Date.now() - cachedModelsAt < MODELS_CACHE_TTL_MS) {
      return cachedModels;
    }
    refreshModelsInBackground();
    return cachedModels ?? fallback;
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
      // Agentic, non-interactive: auto-approve edits + the pre-approved toolset so a
      // headless run never hangs waiting for a permission prompt.
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      ALLOWED_TOOLS,
    ];
    if (request.systemPrompt?.trim()) {
      args.push('--append-system-prompt', request.systemPrompt);
    }

    // Run in the project directory so the CLI edits the real files (falls back to cwd).
    const cwd = request.workingDirectory?.trim() || process.cwd();
    const child = spawn('claude', args, {
      cwd,
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
    // Correlate tool_use (assistant msg) → tool_result (user msg) for non-file tools.
    const pendingTools = new Map<string, { name: string; input: Record<string, unknown> }>();

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
          for (const event of this.mapEnvelope(envelope, pendingTools)) {
            if (
              event.type === 'content_delta' ||
              event.type === 'thinking_delta' ||
              event.type === 'file_edit' ||
              event.type === 'tool_executed'
            ) {
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

  private *mapEnvelope(
    envelope: ClaudeStreamEnvelope,
    pendingTools: Map<string, { name: string; input: Record<string, unknown> }>,
  ): Generator<ProviderEvent> {
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
      case 'assistant': {
        // Full assistant message — surface the tool_use blocks the agent is running.
        // (Text is streamed live via stream_event text_delta; skip it here to avoid dupes.)
        const msg = envelope.message;
        if (!msg || typeof msg === 'string' || !Array.isArray(msg.content)) return;
        for (const block of msg.content) {
          if (block.type !== 'tool_use' || !block.name) continue;
          const input = (block.input ?? {}) as Record<string, unknown>;
          yield* this.mapToolUse(block.id ?? '', block.name, input, pendingTools);
        }
        return;
      }
      case 'user': {
        // Tool results for the non-file tools we're tracking → surface as executed actions.
        const msg = envelope.message;
        if (!msg || typeof msg === 'string' || !Array.isArray(msg.content)) return;
        for (const block of msg.content) {
          if (block.type !== 'tool_result' || !block.tool_use_id) continue;
          const pending = pendingTools.get(block.tool_use_id);
          if (!pending) continue;
          pendingTools.delete(block.tool_use_id);
          yield {
            type: 'tool_executed',
            toolName: pending.name,
            toolInput: JSON.stringify(pending.input),
            toolOutput: flattenToolResult(block.content),
            isError: block.is_error === true,
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

  /** Map a built-in tool_use block → a display event (file_edit for writes, else pending). */
  private *mapToolUse(
    id: string,
    name: string,
    input: Record<string, unknown>,
    pendingTools: Map<string, { name: string; input: Record<string, unknown> }>,
  ): Generator<ProviderEvent> {
    const filePath = typeof input.file_path === 'string' ? input.file_path : undefined;
    if (name === 'Write' && filePath) {
      yield {
        type: 'file_edit',
        filePath,
        fileContent: String(input.content ?? ''),
        fileOperation: 'create',
      };
      return;
    }
    if (name === 'Edit' && filePath) {
      yield {
        type: 'file_edit',
        filePath,
        fileOldContent: typeof input.old_string === 'string' ? input.old_string : undefined,
        fileContent: String(input.new_string ?? ''),
        fileOperation: 'edit',
      };
      return;
    }
    if (name === 'MultiEdit' && filePath && Array.isArray(input.edits)) {
      for (const e of input.edits as Array<{ old_string?: string; new_string?: string }>) {
        yield {
          type: 'file_edit',
          filePath,
          fileOldContent: e.old_string,
          fileContent: String(e.new_string ?? ''),
          fileOperation: 'edit',
        };
      }
      return;
    }
    // Non-file tool (Bash, Read, Grep, …): surface it once its result arrives.
    if (id) pendingTools.set(id, { name, input });
  }
}

function flattenToolResult(
  content: string | Array<{ type?: string; text?: string }> | undefined,
): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c?.text ?? '').join('');
  return '';
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
