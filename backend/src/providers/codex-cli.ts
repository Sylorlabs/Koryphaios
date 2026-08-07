// OpenAI Codex subscription provider — runs the official local `codex` CLI.
//
// Koryphaios never copies, refreshes, or sends the CLI's ChatGPT credential.
// The installed, logged-in CLI owns authentication and performs each turn.

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { whichBinary } from './cli-detection';
import { discoverCliAccounts, type DiscoveredCliAccount } from './cli-accounts';
import {
  type Provider,
  type ProviderContentBlock,
  type ProviderEvent,
  type ProviderMessage,
  type StreamRequest,
} from './types';
import { providerLog } from '../logger';
import { getCliBridge, getKoryphaiosCodexHome } from './cli-bridges';
import { buildSoftJail, wrapCommand } from '../collaboration/sandbox-runner';

const CODEX_TIMEOUT_MS = 300_000;
const CODEX_MODEL_LIST_TIMEOUT_MS = 15_000;
const CODEX_MODELS_CACHE_MS = 5 * 60_000;

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
      env: { ...process.env, CODEX_HOME: account.profileDir },
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
        providerLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Codex CLI child already exited on finish');
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
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', (error) => finish(undefined, error));
    child.once('exit', (code) => {
      if (!settled)
        finish(
          undefined,
          new Error((stderr.trim() || `Codex app-server exited with status ${code}`).slice(0, 500)),
        );
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
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
          providerLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Codex CLI skipping non-JSON diagnostics/partial line');
        }
      }
    });
    send(1, 'initialize', {
      clientInfo: { name: 'Koryphaios', version: '1.0' },
      capabilities: null,
    });
  });
}

function flatten(content: string | ProviderContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
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
    providerLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Codex tool tag parse failed — returning raw text');
    return { content: text };
  }
}

/** Translate the public Codex CLI JSONL protocol into Kory events. Codex does
 * not expose private chain-of-thought; with model_reasoning_summary enabled it
 * emits a safe textual summary as a reasoning item, which we can show. */
export function codexJsonEvents(
  event: Record<string, any>,
  allowedToolNames: readonly string[],
  accountId?: string,
): { events: ProviderEvent[]; completed: boolean } {
  const events: ProviderEvent[] = [];
  const item = event.item as Record<string, any> | undefined;
  if (event.type === 'item.completed' && item?.type === 'agent_message' && item.text) {
    const extracted = extractKoryToolEnvelope(String(item.text), allowedToolNames);
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
  } else if (event.type === 'item.completed' && item?.type === 'reasoning' && item.text) {
    events.push({ type: 'thinking_delta', thinking: String(item.text) });
  } else if (event.type === 'item.completed' && item?.type === 'command_execution') {
    events.push({
      type: 'tool_executed',
      toolName: 'codex_command',
      toolInput: JSON.stringify({ command: item.command ?? '' }),
      toolOutput: String(item.aggregated_output ?? item.output ?? '').slice(0, 4_000),
      isError: item.exit_code != null && item.exit_code !== 0,
    });
  } else if (event.type === 'turn.completed') {
    const usage = event.usage as Record<string, unknown> | undefined;
    if (typeof usage?.input_tokens === 'number' || typeof usage?.output_tokens === 'number') {
      events.push({
        type: 'usage_update',
        tokensIn: usage.input_tokens as number | undefined,
        tokensOut: usage.output_tokens as number | undefined,
        accountId,
      });
    }
    return { events, completed: true };
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

function buildPrompt(
  systemPrompt: string | undefined,
  messages: ProviderMessage[],
  tools: StreamRequest['tools'],
  harnessRole: StreamRequest['harnessRole'],
): string {
  const turns = messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      const text = flatten(message.content).trim();
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

function resolveCliModel(modelId: string, models: ModelDef[]): string {
  const match = models.find((model) => model.id === modelId || model.apiModelId === modelId);
  return match?.apiModelId ?? modelId;
}

export class CodexCliProvider implements Provider {
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
            providerLog.warn(
              {
                provider: 'codex',
                error:
                  result.reason instanceof Error ? result.reason.message : String(result.reason),
              },
              'Could not load models for one Codex CLI account',
            );
            failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
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
        this.models = models;
        this.modelsAt = Date.now();
        this.modelDiscoveryError = models.length > 0
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
    const prompt = buildPrompt(
      request.systemPrompt,
      request.messages,
      request.tools,
      request.harnessRole,
    );
    const sandbox = 'read-only';

    // ── Wire rules (AGENTS.md) into the isolated codex home ────────────────
    // Codex has no MCP support, so the <KORY_TOOL_CALL> envelope in the prompt
    // is the bridge mechanism. But Codex DOES read AGENTS.md as always-on
    // rules — writing it ensures the CLI follows Kory's session conventions.
    const codexBridge = getCliBridge('codex');
    const bridgeCtx = {
      provider: 'codex' as const,
      role: request.harnessRole ?? 'manager',
      sandbox: request.sandbox,
      workingDirectory: request.workingDirectory?.trim() || process.cwd(),
      sessionId: request.sessionId,
      systemPrompt: request.systemPrompt ?? '',
      tools: request.tools ?? [],
    };
    if (!researchOnly) try {
      const ruleFiles = codexBridge?.buildRules(bridgeCtx);
      if (ruleFiles) {
        for (const rule of ruleFiles) {
          mkdirSync(dirname(rule.path), { recursive: true });
          writeFileSync(rule.path, rule.content);
        }
      }
    } catch (wiringErr) {
      providerLog.warn(
        { err: wiringErr, provider: 'codex' },
        'Failed to write rules file for Codex',
      );
    }

    const researchRoot = researchOnly ? mkdtempSync(join(tmpdir(), 'kory-web-research-codex-')) : null;
    const cwd = researchRoot ?? (request.workingDirectory?.trim() || process.cwd());
    const args = [
      '--ask-for-approval',
      'never',
      '--config',
      'mcp_servers={}',
      ...(researchOnly ? ['--search'] : []),
      'exec',
      '--json',
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
      prompt,
    ];
    const codexHome = getKoryphaiosCodexHome(account.profileDir);
    const baseEnv = { ...process.env, CODEX_HOME: codexHome };
    const jail = request.sandbox ? buildSoftJail(baseEnv, [codexHome]) : null;
    const wrapped = request.sandbox
      ? wrapCommand(binary, args, { cwd, configDirs: [codexHome], policy: request.sandbox })
      : { command: binary, args };
    const child = spawn(wrapped.command, wrapped.args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: jail?.env ?? baseEnv,
    });
    let stderr = '';
    let stdoutBuffer = '';
    let completed = false;
    const allowedToolNames = (request.tools ?? []).map((tool) => tool.name);
    const onAbort = () => child.kill('SIGTERM');
    request.signal?.addEventListener('abort', onAbort, { once: true });
    child.once('close', () => {
      jail?.cleanup();
      if (researchRoot) rmSync(researchRoot, { recursive: true, force: true });
    });
    const timeout = setTimeout(() => child.kill('SIGTERM'), CODEX_TIMEOUT_MS);
    timeout.unref?.();

    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const queue: ProviderEvent[] = [];
    const consumeLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as Record<string, any>;
        const translated = codexJsonEvents(event, allowedToolNames, account.id);
        queue.push(...translated.events);
        if (translated.completed) completed = true;
      } catch (err: unknown) {
        // Codex's JSON mode is JSONL; ignore a malformed partial line.
        providerLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Codex CLI skipping malformed JSONL partial line');
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        consumeLine(line);
      }
    });

    const exitCode = await new Promise<number>((resolve) => {
      child.once('error', () => resolve(-1));
      child.once('exit', (code) => resolve(code ?? 0));
    });
    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', onAbort);
    consumeLine(stdoutBuffer);
    while (queue.length) yield queue.shift()!;
    if (request.signal?.aborted) return;
    if (exitCode !== 0) {
      yield {
        type: 'error',
        error: `Codex CLI failed: ${(stderr.trim() || `exit status ${exitCode}`).slice(0, 500)}`,
      };
      return;
    }
    if (!completed)
      providerLog.warn({ provider: 'codex' }, 'Codex CLI exited without a turn.completed event');
    yield { type: 'complete', finishReason: 'end_turn' };
  }
}
