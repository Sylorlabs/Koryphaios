// OpenAI Codex subscription provider — runs the official local `codex` CLI.
//
// Koryphaios never copies, refreshes, or sends the CLI's ChatGPT credential.
// The installed, logged-in CLI owns authentication and performs each turn.

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { whichBinary } from './cli-detection';
import { discoverCliAccounts, type DiscoveredCliAccount } from './cli-accounts';
import {
  type Provider,
  type ProviderEvent,
  type ProviderMessage,
  type StreamRequest,
} from './types';
import { providerLog } from '../logger';
import { getCliBridge, getKoryphaiosCodexHome, serializeCodexMcpProfile } from './cli-bridges';
import { buildSoftJail } from '../collaboration/sandbox-runner';
import {
  assertPrivateValuesAbsentFromArgv,
  spawnWithPrivateArtifactCleanup,
  writePrivatePromptToStdin,
} from './private-cli-transport';
import { createCliAttachmentScope, type CliAttachmentScope } from './cli-attachments';
import {
  appendPrivateDiagnostic,
  safeProviderDiagnostic,
  safeProviderFailureMessage,
} from './provider-diagnostics';
import { writeManagedCliFile } from './managed-cli-storage';
import { appendBoundedProviderFrames } from './bounded-provider-stream';
import { createKoryBridgeGrantLease } from './bridge-grant';
import { buildProviderCliEnv } from './cli-environment';
import { readAllCodexModelsCaches, enrichCodexModelsWithCliCache } from './codex-models-cache';

const CODEX_TIMEOUT_MS = 300_000;
const CODEX_MODEL_LIST_TIMEOUT_MS = 15_000;
const CODEX_MODELS_CACHE_MS = 5 * 60_000;

// ─── Transient Codex failure classification ────────────────────────────────
// The `codex exec` binary has its own internal retry loop ("Reconnecting...
// 1/5"). When the ChatGPT side blips ("Something went wrong", stream
// disconnect), the CLI exhausts that loop and exits nonzero. That is a
// transient transport failure, not a turn failure — the registry retries it.
// Shared with codex-auth.ts, which shells the same binary and sees the same
// stderr shapes. Keep this as the single source of truth; do not duplicate
// these patterns.

/** Substrings that always mean "fix credentials", never "retry the turn". */
const CODEX_AUTH_FAILURE_MARKERS = [
  'invalid api key',
  'invalid_api_key',
  'invalid-api-key',
  'unauthorized',
  'unauthorised',
  'unauthenticated',
  'forbidden',
  'authentication',
  'authenticate',
  'not signed in',
  'not logged in',
  'not authenticated',
  'login required',
  'login expired',
  'log in',
  'signin',
  'sign in',
  'sign-in',
  'codex login',
  'auth.json',
  'auth file',
  'no auth',
  'missing auth',
  'credential',
  'invalid token',
  'expired token',
  'token expired',
  'refresh token',
];

/**
 * Substrings of the codex-chatgpt-web turn broker's stale-binding errors.
 * The broker mints a fresh turn token per turn, so a token that is invalid,
 * expired, revoked, or already finished is always recoverable by retrying the
 * turn (fresh process → fresh token) — never by fixing credentials. Shapes:
 * - `turn token is invalid, expired, or revoked` (broker `claim`, generic)
 * - `turn token is invalid or expired` (broker owner-path twin)
 * - `... which has already finished. This Codex Native action can no longer
 *   run.` (broker `claim`, specific retired-turn twin)
 * - `... has already finished; this Codex Native action can no longer run.`
 *   (broker binding-path twin)
 * Deliberately worded so none contains the fail-closed auth markers
 * (`invalid token`, `expired token`, `token expired` need the reverse order).
 */
const CODEX_TURN_TOKEN_FAILURE_MARKERS = [
  'turn token is invalid, expired, or revoked',
  'turn token is invalid or expired',
  'has already finished',
];

/** True when the text reports a stale turn-token binding — always retriable
 *  with a fresh turn, never a credentials problem. */
export function isCodexTurnTokenFailure(value: unknown): boolean {
  const text = codexFailureText(value).toLowerCase();
  if (!text) return false;
  return CODEX_TURN_TOKEN_FAILURE_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Substrings of the CLI's own transient ChatGPT-side blips (stderr text and
 * the sanitized user messages below). `transient` is deliberately included so
 * the honest user-facing message this module emits stays machine-recognizable
 * as retriable when it flows back through the registry retry check.
 */
const CODEX_TRANSIENT_FAILURE_MARKERS = [
  'transient',
  'stream disconnected',
  'disconnected before completion',
  'something went wrong',
  'reconnecting',
  'ended the turn',
  'socket hang up',
  'socket hangup',
  'hang up',
  'hangup',
  'econnreset',
  'econnaborted',
  'etimedout',
  'connection reset',
  'connection aborted',
  'connection refused',
  'timed out',
  'timeout',
  'deadline exceeded',
  'service unavailable',
  'temporarily unavailable',
  'bad gateway',
  'gateway timeout',
  'internal server error',
  'overloaded',
  'over capacity',
  'rate limit',
  'rate_limit',
  'too many requests',
  '429',
  '500',
  '502',
  '503',
  '504',
  'fetch failed',
  'failed to fetch',
  'upstream',
  'network error',
  'try again',
];

function codexFailureText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) {
    const cause = value.cause instanceof Error ? ` ${value.cause.message}` : '';
    return `${value.name} ${value.message}${cause}`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return [record.message, record.error, record.type, record.code]
      .filter((part): part is string => typeof part === 'string')
      .join(' ');
  }
  return value === undefined || value === null ? '' : String(value);
}

/** True when the text means "fix credentials" — always fail-closed, never retried. */
export function isCodexAuthFailure(value: unknown): boolean {
  const text = codexFailureText(value).toLowerCase();
  if (!text) return false;
  return CODEX_AUTH_FAILURE_MARKERS.some((marker) => text.includes(marker));
}

/**
 * True for the CLI's transient ChatGPT-side blips. Auth-looking text stays
 * fail-closed even when wrapped in retryable-sounding words. Stale
 * turn-token bindings are retriable: a fresh turn mints a fresh token.
 */
export function isTransientCodexFailure(value: unknown): boolean {
  const text = codexFailureText(value).toLowerCase();
  if (!text) return false;
  if (CODEX_AUTH_FAILURE_MARKERS.some((marker) => text.includes(marker))) return false;
  if (isCodexTurnTokenFailure(value)) return true;
  return CODEX_TRANSIENT_FAILURE_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Honest user-facing message for a transient ChatGPT disconnect. The raw
 * stderr stays in server logs via safeProviderDiagnostic; the banner carries
 * no upstream detail.
 */
export function codexTransientFailureMessage(): string {
  return 'Codex hit a transient ChatGPT disconnect. Nothing was lost — retry the turn.';
}

/** Same banner with the attempt count, for when registry retries are exhausted. */
export function codexTransientExhaustedMessage(attempts: number): string {
  const total = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 1;
  return `Codex hit a transient ChatGPT disconnect after ${total} ${total === 1 ? 'attempt' : 'attempts'}. Nothing was lost — retry the turn.`;
}

type CodexCliModel = {
  id?: string;
  model?: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
  defaultReasoningEffort?: string;
  inputModalities?: string[];
  supportedServiceTiers?: string[];
};

function supportsCodexFastTier(model: CodexCliModel): boolean {
  const advertised = model.supportedServiceTiers;
  return Array.isArray(advertised) && advertised.includes('fast');
}

function modelDefinition(model: CodexCliModel, account: DiscoveredCliAccount): ModelDef | null {
  const cliModel = typeof model.model === 'string' ? model.model : model.id;
  if (!cliModel) return null;
  const reasoningLevels = (model.supportedReasoningEfforts ?? [])
    .map((entry) => entry.reasoningEffort)
    .filter((level): level is string => typeof level === 'string' && level.length > 0);
  return {
    // The provider model is account-scoped. The real model name stays in
    // apiModelId and is the only value passed to `codex --model`.
    id: `codex-account:${Buffer.from(account.id).toString('base64url')}:${cliModel}`,
    apiModelId: cliModel,
    accountId: account.id,
    name: `${model.displayName?.trim() || cliModel} · ${account.label}`,
    provider: 'codex',
    contextWindow: 0,
    contextVerified: false,
    maxOutputTokens: 0,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: reasoningLevels.length > 0,
    reasoningLevels,
    supportsFastMode: supportsCodexFastTier(model),
    supportsAttachments: model.inputModalities?.includes('image') === true,
    supportsStreaming: true,
    tier: model.isDefault ? 'flagship' : undefined,
  };
}

/** Query the official local app-server protocol. This returns exactly the
 * models the installed, authenticated Codex CLI makes available to this user. */
async function queryCliModels(
  binary: string,
  account: DiscoveredCliAccount,
): Promise<CodexCliModel[]> {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // This is the actual profile boundary. A second account is not just a
      // display label: the official CLI reads its own auth store from here.
      env: buildProviderCliEnv('codex', {
        CODEX_HOME: account.profileDir,
        HOME: account.profileDir,
        USERPROFILE: account.profileDir,
      }),
    });
    let buffer = '';
    let stderr = '';
    let settled = false;
    const finish = (result?: CodexCliModel[], error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        child.kill('SIGTERM');
      } catch (err: unknown) {
        providerLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Codex CLI child already exited on finish',
        );
      }
      error ? reject(error) : resolve(result ?? []);
    };
    const send = (id: number, method: string, params: Record<string, unknown>) =>
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const timeout = setTimeout(
      () => finish(undefined, new Error('Codex CLI model discovery timed out')),
      CODEX_MODEL_LIST_TIMEOUT_MS,
    );
    timeout.unref?.();
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendPrivateDiagnostic(stderr, chunk);
    });
    child.once('error', (error) => finish(undefined, error));
    child.once('exit', (code) => {
      if (!settled)
        finish(
          undefined,
          new Error((stderr.trim() || `Codex app-server exited with status ${code}`).slice(0, 500)),
        );
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      let bounded: ReturnType<typeof appendBoundedProviderFrames>;
      try {
        bounded = appendBoundedProviderFrames(buffer, chunk.toString());
      } catch (error) {
        return finish(undefined, error as Error);
      }
      buffer = bounded.remainder;
      for (const line of bounded.frames) {
        try {
          const message = JSON.parse(line) as {
            id?: number;
            result?: Record<string, unknown>;
            error?: { message?: string };
          };
          if (message.id === 1) {
            send(2, 'model/list', { limit: 100, includeHidden: false });
          } else if (message.id === 2) {
            if (message.error)
              return finish(
                undefined,
                new Error(message.error.message ?? 'Codex model discovery failed'),
              );
            const data = Array.isArray(message.result?.data)
              ? (message.result.data as CodexCliModel[])
              : [];
            return finish(data.filter((model) => !model.hidden));
          }
        } catch (err: unknown) {
          // Ignore non-JSON diagnostics/partial lines from the CLI.
          providerLog.debug(
            safeProviderDiagnostic('codex', 'stdout', err),
            'Codex CLI skipping non-JSON diagnostics/partial line',
          );
        }
      }
    });
    send(1, 'initialize', {
      clientInfo: { name: 'Koryphaios', version: '1.0' },
      capabilities: null,
    });
  });
}

type KoryToolEnvelope = {
  name: string;
  input: Record<string, unknown>;
};

const KORY_TOOL_OPEN = '<KORY_TOOL_CALL>';
const KORY_TOOL_CLOSE = '</KORY_TOOL_CALL>';

/** Convert Codex's explicit control-plane envelope into Kory tool events. */
export function extractKoryToolEnvelope(
  text: string,
  allowedToolNames: readonly string[],
): { content: string; tool?: KoryToolEnvelope } {
  const start = text.indexOf(KORY_TOOL_OPEN);
  const end = text.indexOf(KORY_TOOL_CLOSE, start + KORY_TOOL_OPEN.length);
  if (start === -1 || end === -1) return { content: text };

  const raw = text.slice(start + KORY_TOOL_OPEN.length, end).trim();
  try {
    const parsed = JSON.parse(raw) as { name?: unknown; input?: unknown };
    if (
      typeof parsed.name !== 'string' ||
      !allowedToolNames.includes(parsed.name) ||
      !parsed.input ||
      typeof parsed.input !== 'object' ||
      Array.isArray(parsed.input)
    ) {
      return { content: text };
    }
    return {
      content: `${text.slice(0, start)}${text.slice(end + KORY_TOOL_CLOSE.length)}`.trim(),
      tool: { name: parsed.name, input: parsed.input as Record<string, unknown> },
    };
  } catch (err: unknown) {
    providerLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Codex tool tag parse failed — returning raw text',
    );
    return { content: text };
  }
}

/** Tolerant reading of an MCP tool item from Codex's JSONL. Shapes vary by
 *  CLI version (server_name/tool_name/arguments vs server/tool/input), so
 *  every field has fallbacks. Returns null when this is not an MCP item. */
function describeMcpItem(item: Record<string, unknown> | undefined): {
  name: string;
  input: string;
  output: string;
  isError: boolean;
} | null {
  const rawType = typeof item?.type === 'string' ? (item.type as string) : '';
  if (!/mcp/i.test(rawType)) return null;
  const record = item as Record<string, unknown>;
  const server =
    asText(record.server_name) ?? asText(record.server) ?? asText(record.server_label) ?? 'server';
  const tool = asText(record.tool_name) ?? asText(record.tool) ?? asText(record.name) ?? 'tool';
  const name = tool.startsWith('mcp__') ? tool : `mcp__${server}__${tool}`;
  const inputValue = record.arguments ?? record.input ?? record.parameters;
  const outputValue = record.result ?? record.output ?? record.response ?? record.error;
  return {
    name,
    input: typeof inputValue === 'string' ? inputValue : JSON.stringify(inputValue ?? {}),
    output: String(outputValue ?? '').slice(0, 4_000),
    isError: record.status === 'error' || record.is_error === true || record.error != null,
  };
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Read a Codex reasoning item as displayable thinking. Older CLIs emit
 *  `{ type: 'reasoning', text }`; newer ones emit
 *  `{ type: 'reasoning', summary: [{ text }, ...] }` with no top-level text.
 *  Summary entries each narrate one step, so they join as paragraphs.
 *  The trailing break is load-bearing: every thinking_delta from Codex is one
 *  COMPLETED item, and the WS coalescer concatenates consecutive thinking
 *  payloads verbatim — without it, separate summaries glue mid-word
 *  ("failureInspected"). Token-streaming providers are untouched; this only
 *  shapes Codex payloads. Returns null when there is nothing to show. */
function describeReasoningText(item: Record<string, unknown> | undefined): string | null {
  if (!item) return null;
  const parts: string[] = [];
  const direct =
    asText(item.text) ??
    (item.text != null && String(item.text).trim() ? String(item.text) : undefined);
  if (direct) parts.push(direct);
  if (Array.isArray(item.summary)) {
    for (const entry of item.summary) {
      const text = asText((entry as Record<string, unknown> | null)?.text);
      if (text) parts.push(text);
    }
  }
  if (parts.length === 0) return null;
  return `${parts.join('\n\n')}\n\n`;
}

/** Surface a native Codex tool item the translator has no dedicated branch
 *  for (file_change, web_search, todo_list, …) as a display-only activity
 *  row. Shapes vary by CLI version, so every field has fallbacks and output
 *  is capped. Display-only, like command_execution: the action already ran
 *  inside the CLI, so this must never become a tool_use the manager would
 *  execute a second time. */
function describeNativeToolItem(
  toolName: string,
  item: Record<string, unknown>,
): { toolName: string; toolInput: string; toolOutput: string } {
  const inputValue =
    item.command ??
    item.query ??
    item.path ??
    item.file ??
    item.input ??
    item.arguments ??
    item.items ??
    item.changes ??
    {};
  const outputValue =
    item.aggregated_output ??
    item.output ??
    item.result ??
    item.response ??
    item.diff ??
    item.summary ??
    '';
  const outputText =
    typeof outputValue === 'string' ? outputValue : JSON.stringify(outputValue ?? '');
  return {
    toolName,
    toolInput: typeof inputValue === 'string' ? inputValue : JSON.stringify(inputValue ?? {}),
    toolOutput: String(outputText ?? '').slice(0, 4_000),
  };
}

/** Translate the public Codex CLI JSONL protocol into Kory events. Codex does
 * not expose private chain-of-thought; with model_reasoning_summary enabled it
 * emits a safe textual summary as a reasoning item, which we can show. */
export function codexJsonEvents(
  event: Record<string, unknown>,
  allowedToolNames: readonly string[],
  accountId?: string,
): { events: ProviderEvent[]; completed: boolean } {
  const events: ProviderEvent[] = [];
  const item = event.item as Record<string, unknown> | undefined;
  // MCP tool calls already executed inside the kory bridge server — surface
  // them display-only (tool_executed), never as tool_use (which the manager
  // would execute a second time through ToolRegistry).
  if (event.type === 'item.completed') {
    const mcp = describeMcpItem(item);
    if (mcp) {
      if (isCodexTurnTokenFailure(mcp.output)) {
        // A Native2 connector call failed on a stale turn-token binding. The
        // turn cannot make further progress on this token, but a fresh turn
        // mints a fresh one — surface the retriable banner so the registry
        // retries instead of presenting a partial tool row as success.
        providerLog.warn(
          safeProviderDiagnostic('codex', 'stdout', mcp.output),
          'Codex MCP tool hit a stale turn-token binding',
        );
        events.push({ type: 'error', error: codexTransientFailureMessage() });
        return { events, completed: false };
      }
      events.push({
        type: 'tool_executed',
        toolName: mcp.name,
        toolInput: mcp.input,
        toolOutput: mcp.output,
        isError: mcp.isError,
      });
      return { events, completed: false };
    }
  }
  if (event.type === 'item.completed' && item?.type === 'agent_message' && item.text) {
    const text = String(item.text);
    if (isCodexTurnTokenFailure(text)) {
      // The bridge error reached ChatGPT as tool-result text and the model is
      // narrating it instead of emitting `turn.failed` (e.g. "Step 2 failed —
      // turn token is invalid..."). End the turn here with the retriable
      // banner; the registry re-runs it with a fresh token.
      providerLog.warn(
        safeProviderDiagnostic('codex', 'stdout', text),
        'Codex turn hit a stale turn-token binding',
      );
      events.push({ type: 'error', error: codexTransientFailureMessage() });
      return { events, completed: true };
    }
    const extracted = extractKoryToolEnvelope(text, allowedToolNames);
    if (extracted.content) events.push({ type: 'content_delta', content: extracted.content });
    if (extracted.tool) {
      const toolCallId = `codex-kory-${randomUUID()}`;
      const input = JSON.stringify(extracted.tool.input);
      events.push({ type: 'tool_use_start', toolCallId, toolName: extracted.tool.name });
      events.push({
        type: 'tool_use_delta',
        toolCallId,
        toolName: extracted.tool.name,
        toolInput: input,
      });
      events.push({
        type: 'tool_use_stop',
        toolCallId,
        toolName: extracted.tool.name,
        toolInput: input,
      });
    }
  } else if (event.type === 'item.completed' && item?.type === 'reasoning') {
    const thinking = describeReasoningText(item);
    if (thinking) events.push({ type: 'thinking_delta', thinking });
  } else if (event.type === 'item.completed' && item?.type === 'command_execution') {
    events.push({
      type: 'tool_executed',
      toolName: 'codex_command',
      toolInput: JSON.stringify({ command: item.command ?? '' }),
      toolOutput: String(item.aggregated_output ?? item.output ?? '').slice(0, 4_000),
      isError: item.exit_code != null && item.exit_code !== 0,
    });
  } else if (
    event.type === 'item.completed' &&
    (item?.type === 'file_change' ||
      item?.type === 'web_search' ||
      item?.type === 'todo_list' ||
      item?.type === 'exec' ||
      item?.type === 'view' ||
      item?.type === 'edit')
  ) {
    // Native tool items with no dedicated branch. Previously these were
    // silently dropped, so the Thought narration described actions that had
    // no visible tool row — tool calls appeared to render as thinking.
    const native = describeNativeToolItem(`codex_${item.type}`, item);
    events.push({
      type: 'tool_executed',
      toolName: native.toolName,
      toolInput: native.toolInput,
      toolOutput: native.toolOutput,
      isError: item.exit_code != null && item.exit_code !== 0,
    });
  } else if (event.type === 'turn.completed') {
    const usage = event.usage as Record<string, unknown> | undefined;
    if (typeof usage?.input_tokens === 'number' || typeof usage?.output_tokens === 'number') {
      // turn.completed input_tokens is CUMULATIVE across every internal model
      // request the CLI made during this exec (like the cumulative token_count
      // records in the on-disk session log — see billing/cli-usage.ts, which
      // bills from per-request last_token_usage instead). It is billing
      // evidence, not the final live context occupancy: mapping it 1:1 onto
      // the meter produces impossible ratios (e.g. 860k used on a 285k
      // window). Keep the raw totals for billing, flag the occupancy as
      // estimated, and let the manager clamp it to the trusted window and
      // withhold it from the auto-compact trigger.
      events.push({
        type: 'usage_update',
        tokensIn: usage.input_tokens as number | undefined,
        tokensOut: usage.output_tokens as number | undefined,
        estimated: true,
        usagePrecision: 'provider-reported',
        billingTokensIn: usage.input_tokens as number | undefined,
        billingTokensOut: usage.output_tokens as number | undefined,
        // Codex input_tokens already includes this cached prefix. Carry it as
        // explanatory metadata only; consumers must not add it a second time.
        tokensCacheRead:
          typeof usage.cached_input_tokens === 'number' ? usage.cached_input_tokens : undefined,
        accountId,
      });
    }
    return { events, completed: true };
  } else if (event.type === 'turn.failed') {
    const raw =
      (event.error as { message?: string } | undefined)?.message ??
      (event.message as string | undefined) ??
      '';
    if (isTransientCodexFailure(raw)) {
      // ChatGPT-side blip inside the CLI's own loop: honest banner, raw
      // detail stays in server logs only. The registry retries this.
      providerLog.warn(
        safeProviderDiagnostic('codex', 'stdout', raw),
        'Codex CLI hit a transient ChatGPT disconnect',
      );
      events.push({ type: 'error', error: codexTransientFailureMessage() });
      return { events, completed: true };
    }
    const diagnostic = safeProviderDiagnostic('codex', 'stdout', raw);
    events.push({ type: 'error', error: safeProviderFailureMessage('codex', diagnostic) });
    return { events, completed: true };
  } else if (event.type === 'error') {
    const raw = (event as { message?: string }).message ?? '';
    if (isTransientCodexFailure(raw)) {
      providerLog.warn(
        safeProviderDiagnostic('codex', 'stdout', raw),
        'Codex CLI hit a transient ChatGPT disconnect',
      );
      events.push({ type: 'error', error: codexTransientFailureMessage() });
      return { events, completed: false };
    }
    const diagnostic = safeProviderDiagnostic('codex', 'stdout', raw);
    events.push({ type: 'error', error: safeProviderFailureMessage('codex', diagnostic) });
  }
  return { events, completed: false };
}

export function codexReasoningArgs(reasoningLevel: string | undefined): string[] {
  if (!reasoningLevel) return [];
  const args = ['--config', `model_reasoning_effort=${JSON.stringify(reasoningLevel)}`];
  if (!['none', 'off', 'disabled'].includes(reasoningLevel.toLowerCase())) {
    args.push(
      // Ask the official CLI for its safe reasoning summary. The CLI keeps
      // private chain-of-thought encrypted and emits only the summary.
      '--config',
      'model_reasoning_summary="detailed"',
    );
  }
  return args;
}

/** Build the text part of a Codex turn. Image bytes travel through Codex's
 * documented `--image` transport; the path in the prompt preserves the image's
 * place in multi-turn context and lets the CLI inspect it with native tools. */
export function buildCodexPrompt(
  systemPrompt: string | undefined,
  messages: ProviderMessage[],
  tools: StreamRequest['tools'],
  harnessRole: StreamRequest['harnessRole'],
  attachments: Pick<CliAttachmentScope, 'renderContent'>,
): string {
  const turns = messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      const text = attachments.renderContent(message.content).trim();
      if (!text) return '';
      const label =
        message.role === 'assistant'
          ? 'Assistant'
          : message.role === 'tool'
            ? 'Tool result'
            : 'User';
      return `${label}: ${text}`;
    })
    .filter(Boolean);
  // Use the CodexCliBridge to build the harness note + tool whitelist
  // consistently with the other CLI providers (Phase 1 deep-integration).
  // The <KORY_TOOL_CALL> envelope protocol stays as the bridge mechanism.
  const codexBridge = getCliBridge('codex');
  const bridgeConfig = codexBridge?.buildAgentConfig({
    provider: 'codex',
    role: harnessRole ?? 'manager',
    sandbox: undefined,
    workingDirectory: process.cwd(),
    systemPrompt: systemPrompt ?? '',
    tools: tools ?? [],
  });
  const harnessNote =
    bridgeConfig?.systemInstructions?.[1] ??
    'You are running inside Koryphaios. Follow its supplied instructions and finish every turn with a concise user-facing answer. Do not delegate to native subagents or leave background tasks awaiting a later notification.';
  const allowedToolNames = tools?.map((tool) => tool.name) ?? [];
  const toolProtocol = tools?.length
    ? [
        'Kory control-plane tools are available. When you need one, emit exactly one final line and nothing after it:',
        `${KORY_TOOL_OPEN}{"name":"tool_name","input":{}}${KORY_TOOL_CLOSE}`,
        `Only use: ${allowedToolNames.join(', ')}. Do not claim a Kory tool ran unless you emitted that envelope.`,
      ].join('\n')
    : '';
  return [systemPrompt?.trim(), harnessNote, toolProtocol, ...turns].filter(Boolean).join('\n\n');
}

/** Build the official Codex image flags without ever putting image bytes in
 * argv. The paths point to per-turn 0600 private artifacts. */
export function codexImageArgs(attachments: Pick<CliAttachmentScope, 'artifacts'>): string[] {
  return attachments.artifacts.flatMap((artifact) => ['--image', artifact.path]);
}

function resolveCliModel(modelId: string, models: ModelDef[]): string {
  const match = models.find((model) => model.id === modelId || model.apiModelId === modelId);
  return match?.apiModelId ?? modelId;
}

export class CodexCliProvider implements Provider {
  readonly imageInputTransport = 'native' as const;
  readonly name = 'codex' as const;
  private models: ModelDef[] = [];
  private modelsAt = 0;
  private refreshInFlight: Promise<ModelDef[]> | null = null;
  private accountByModelId = new Map<string, DiscoveredCliAccount>();
  private modelDiscoveryError: string | undefined;

  constructor(readonly config: ProviderConfig) {
    if (this.isAvailable()) void this.refreshModels();
  }

  isAvailable(): boolean {
    return !this.config.disabled && !!whichBinary('codex') && this.accounts().length > 0;
  }

  private accounts(): DiscoveredCliAccount[] {
    // Expiry decoded from a cached JWT is only a hint. The official CLI owns
    // refresh and can still have a valid session, so do not hide a discovered
    // profile before the CLI itself gets a chance to report its model list.
    const discovered = discoverCliAccounts().filter((account) => account.provider === 'codex');
    const selectedOrder = this.config.fallbackOrder ?? [];
    if (selectedOrder.length === 0) return discovered;

    const byId = new Map(discovered.map((account) => [account.id, account]));
    // Once the user has selected profiles, only those profiles may be used;
    // their saved order is the stable priority for model discovery and runs.
    return selectedOrder
      .map((id) => byId.get(id))
      .filter((account): account is DiscoveredCliAccount => !!account);
  }

  listModels(): ModelDef[] {
    if (this.isAvailable() && Date.now() - this.modelsAt > CODEX_MODELS_CACHE_MS) {
      void this.refreshModels();
    }
    return this.models;
  }

  getModelDiscoveryError(): string | undefined {
    return this.modelDiscoveryError;
  }

  async refreshModels(): Promise<ModelDef[]> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const binary = whichBinary('codex');
    const accounts = this.accounts();
    if (!binary || accounts.length === 0) {
      this.models = [];
      this.modelDiscoveryError = !binary
        ? 'Codex CLI was not found on PATH. Install `codex` and reconnect.'
        : 'Codex CLI is not signed in. Run `codex login` and reconnect.';
      return [];
    }
    this.refreshInFlight = Promise.allSettled(
      accounts.map(async (account) => ({
        account,
        models: await queryCliModels(binary, account),
      })),
    )
      .then((results) => {
        const accountByModelId = new Map<string, DiscoveredCliAccount>();
        const failures: string[] = [];
        const models = results.flatMap((result) => {
          if (result.status === 'rejected') {
            const diagnostic = safeProviderDiagnostic('codex', 'stdout', result.reason);
            providerLog.warn(diagnostic, 'Could not load models for one Codex CLI account');
            failures.push(safeProviderFailureMessage('codex', diagnostic));
            return [];
          }
          return result.value.models
            .map((model) => modelDefinition(model, result.value.account))
            .filter((model): model is ModelDef => !!model)
            .map((model) => {
              accountByModelId.set(model.id, result.value.account);
              return model;
            });
        });
        this.accountByModelId = accountByModelId;
        // Stamp each model with the real context window the Codex CLI wrote
        // into its own on-disk cache (~/.codex/models_cache.json). The live
        // `model/list` JSON-RPC response deliberately omits this metadata; the
        // cache is the only authoritative source the running CLI exposes.
        const cliCache = readAllCodexModelsCaches();
        this.models = enrichCodexModelsWithCliCache(models, cliCache);
        this.modelsAt = Date.now();
        this.modelDiscoveryError =
          models.length > 0
            ? undefined
            : failures.length > 0
              ? `Codex CLI model discovery failed: ${failures.join('; ').slice(0, 500)}`
              : 'Codex CLI reported no models for the signed-in account.';
        providerLog.info(
          {
            provider: 'codex',
            models: models.map((model) => ({
              model: model.apiModelId,
              account: this.accountByModelId.get(model.id)?.label,
            })),
          },
          'Loaded provider-reported Codex CLI models',
        );
        return models;
      })
      .finally(() => {
        this.refreshInFlight = null;
      });
    return this.refreshInFlight;
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const binary = whichBinary('codex');
    if (!binary) {
      yield {
        type: 'error',
        error: 'Codex CLI was not found on PATH. Install `codex`, then reconnect.',
      };
      return;
    }
    const account = this.accountByModelId.get(request.model) ?? this.accounts()[0];
    if (!account) {
      yield {
        type: 'error',
        error: 'Codex CLI is not signed in. Run `codex login` in your terminal, then reconnect.',
      };
      return;
    }

    const researchOnly = request.capabilityProfile === 'research-only';
    const attachmentScope = createCliAttachmentScope();
    const prompt = buildCodexPrompt(
      request.systemPrompt,
      request.messages,
      request.tools,
      request.harnessRole,
      attachmentScope,
    );
    const sandbox = 'read-only';

    // ── Wire rules (AGENTS.md) into the isolated codex home ────────────────
    // Codex reads AGENTS.md as always-on rules — writing it ensures the CLI
    // follows Kory's session conventions. The <KORY_TOOL_CALL> envelope in
    // the prompt stays as the fallback transport when MCP is unavailable.
    const codexBridge = getCliBridge('codex');
    const bridgeGrantLease =
      !researchOnly && request.sessionId
        ? createKoryBridgeGrantLease(request.sessionId, request.harnessRole ?? 'manager')
        : undefined;
    const bridgeCtx = {
      provider: 'codex' as const,
      role: request.harnessRole ?? 'manager',
      sandbox: request.sandbox,
      workingDirectory: request.workingDirectory?.trim() || process.cwd(),
      sessionId: request.sessionId,
      systemPrompt: request.systemPrompt ?? '',
      tools: request.tools ?? [],
      bridgeGrantLease,
    };
    if (!researchOnly)
      try {
        const ruleFiles = codexBridge?.buildRules(bridgeCtx);
        if (ruleFiles) {
          for (const rule of ruleFiles) {
            writeManagedCliFile(rule.path, rule.content);
          }
        }
      } catch (wiringErr) {
        providerLog.warn(
          { err: wiringErr, provider: 'codex' },
          'Failed to write rules file for Codex',
        );
      }

    const codexHome = getKoryphaiosCodexHome(account.profileDir);

    // ── Mount the kory MCP server through a per-turn profile ────────────────
    // `codex --profile kory` layers <codexHome>/kory.config.toml on top of the
    // base config, so the isolated home's own config.toml (bridge route etc.)
    // is never rewritten. Each turn mints a fresh session-scoped grant; the
    // envelope protocol remains the fallback when MCP cannot be configured.
    let mcpProfile = false;
    if (!researchOnly) {
      try {
        const mcpConfigs = codexBridge?.buildMcpConfig(bridgeCtx);
        if (mcpConfigs && mcpConfigs.length > 0) {
          writeManagedCliFile(
            join(codexHome, 'kory.config.toml'),
            serializeCodexMcpProfile(mcpConfigs),
          );
          mcpProfile = true;
        }
      } catch (mcpErr) {
        providerLog.warn(
          { err: mcpErr, provider: 'codex' },
          'Failed to write kory MCP profile for Codex; continuing with envelope only',
        );
      }
    }

    const researchRoot = researchOnly
      ? mkdtempSync(join(tmpdir(), 'kory-web-research-codex-'))
      : null;
    const cwd = researchRoot ?? (request.workingDirectory?.trim() || process.cwd());
    const args = [
      '--ask-for-approval',
      'never',
      // MCP and the empty-servers override are mutually exclusive: the kory
      // profile carries the real server list, otherwise keep third-party
      // servers (and their credentials) out of Koryphaios turns entirely.
      ...(mcpProfile ? [] : ['--config', 'mcp_servers={}']),
      ...(researchOnly ? ['--search'] : []),
      'exec',
      '--json',
      // --profile is exec-scoped: it must come after `exec`.
      ...(mcpProfile ? ['--profile', 'kory'] : []),
      '--ephemeral',
      '--skip-git-repo-check',
      '--color',
      'never',
      '--sandbox',
      sandbox,
      '--model',
      resolveCliModel(request.model, this.models),
      // The official CLI maps service_tier="fast" to Fast mode. Do not use
      // reasoning effort as a fake substitute: it changes model work rather
      // than requesting the supported accelerated tier.
      ...(request.fastMode ? ['--config', 'service_tier="fast"'] : []),
      ...codexReasoningArgs(request.reasoningLevel),
      ...codexImageArgs(attachmentScope),
      '-',
    ];
    const baseEnv = buildProviderCliEnv('codex', {
      CODEX_HOME: codexHome,
      HOME: codexHome,
      USERPROFILE: codexHome,
    });
    const attachmentDirectories = attachmentScope.artifacts.map((artifact) => artifact.directory);
    const jail = request.sandbox
      ? buildSoftJail(baseEnv, [codexHome, ...attachmentDirectories])
      : null;
    // Deliberately NO wrapCommand() (Seatbelt/bwrap) here. Codex self-sandboxes
    // its native tools (see --sandbox read-only below) and OS jails cannot
    // nest: an outer jail breaks codex's own tool sandbox with
    // "sandbox-exec: sandbox_apply: Operation not permitted", degrading every
    // turn that touches files or shell. Soft-jail env isolation (above) plus
    // codex's own sandbox and approval policy remain in force — the same
    // containment the standalone CLI has.
    const wrapped = { command: binary, args };
    assertPrivateValuesAbsentFromArgv(wrapped.args, [prompt, request.systemPrompt]);
    const child = spawnWithPrivateArtifactCleanup(
      () =>
        spawn(wrapped.command, wrapped.args, {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: jail?.env ?? baseEnv,
        }),
      [...attachmentScope.artifacts],
      () => {
        jail?.cleanup();
        bridgeGrantLease?.cleanup();
        if (researchRoot) rmSync(researchRoot, { recursive: true, force: true });
      },
    );
    bridgeGrantLease?.bindToChild(child);
    writePrivatePromptToStdin(child, prompt);
    let stderr = '';
    let stdoutBuffer = '';
    let completed = false;
    let streamFrameFailure: unknown;
    const allowedToolNames = (request.tools ?? []).map((tool) => tool.name);
    const onAbort = () => child.kill('SIGTERM');
    request.signal?.addEventListener('abort', onAbort, { once: true });
    child.once('close', () => {
      jail?.cleanup();
      if (researchRoot) rmSync(researchRoot, { recursive: true, force: true });
    });
    const timeout = setTimeout(() => child.kill('SIGTERM'), CODEX_TIMEOUT_MS);
    timeout.unref?.();

    child.stderr.on('data', (chunk: Buffer) => (stderr = appendPrivateDiagnostic(stderr, chunk)));
    const queue: ProviderEvent[] = [];
    let resolveWaiter: (() => void) | null = null;
    let exited = false;
    let exitCode = 0;
    const wake = () => {
      resolveWaiter?.();
      resolveWaiter = null;
    };
    const consumeLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const translated = codexJsonEvents(event, allowedToolNames, account.id);
        queue.push(...translated.events);
        if (translated.completed) completed = true;
        wake();
      } catch {
        // Codex's JSON mode is JSONL; ignore a malformed partial line.
        providerLog.debug(
          safeProviderDiagnostic('codex', 'stdout', line),
          'Codex CLI skipping malformed JSONL partial line',
        );
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (streamFrameFailure) return;
      try {
        const bounded = appendBoundedProviderFrames(stdoutBuffer, chunk.toString());
        stdoutBuffer = bounded.remainder;
        for (const line of bounded.frames) consumeLine(line);
      } catch (error) {
        streamFrameFailure = error;
        child.kill('SIGTERM');
        wake();
      }
    });

    child.once('error', () => {
      exitCode = -1;
      exited = true;
      wake();
    });
    child.once('close', (code) => {
      exitCode = code ?? 0;
      exited = true;
      wake();
    });

    // Drain Codex's JSONL while the CLI is still running. Waiting for process
    // exit here used to buffer every reasoning, tool, and answer event behind
    // the misleading "Analyzing request..." row for the entire turn.
    while (!exited || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      await new Promise<void>((resolve) => {
        if (queue.length > 0 || exited) {
          resolve();
          return;
        }
        resolveWaiter = resolve;
        // A stdout/exit callback can land between the first check and
        // installing the waiter. Recheck to avoid waiting for a later event.
        if (queue.length > 0 || exited) wake();
      });
    }
    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', onAbort);
    if (streamFrameFailure) {
      const diagnostic = safeProviderDiagnostic('codex', 'stdout', streamFrameFailure);
      providerLog.warn(diagnostic, 'Codex CLI stream exceeded the structural limit');
      yield { type: 'error', error: safeProviderFailureMessage('codex', diagnostic) };
      return;
    }
    consumeLine(stdoutBuffer);
    while (queue.length) yield queue.shift()!;
    if (request.signal?.aborted) return;
    if (exitCode !== 0) {
      const diagnostic = safeProviderDiagnostic('codex', 'stderr', stderr, { exitCode });
      providerLog.warn(diagnostic, 'Codex CLI exited unsuccessfully');
      if (isTransientCodexFailure(stderr)) {
        // The CLI's own retry loop (e.g. "Reconnecting... 1/5") exhausted on
        // a ChatGPT-side blip. Honest banner without the raw stderr; the
        // registry retries this before it ever becomes a terminal error.
        yield { type: 'error', error: codexTransientFailureMessage() };
        return;
      }
      yield {
        type: 'error',
        error: safeProviderFailureMessage('codex', diagnostic, {
          authenticationAction: 'Run "codex login", then reconnect.',
        }),
      };
      return;
    }
    if (!completed)
      providerLog.warn({ provider: 'codex' }, 'Codex CLI exited without a turn.completed event');
    yield { type: 'complete', finishReason: 'end_turn' };
  }
}
