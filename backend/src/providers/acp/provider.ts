// Generic ACP agent provider: `acp:<id>`. Drives any user-registered agent that
// speaks ACP protocol 1 over stdio, with the same enforcement shape as the
// opencode provider:
//   - the Kory MCP bridge is passed per ACP session (session/new.mcpServers) with a
//     session-scoped grant, never written to disk;
//   - session/request_permission is answered by the agent's permission profile,
//     fail-closed: native mutating kinds are rejected;
//   - a model is selected only when the agent offered it; otherwise the turn fails
//     instead of silently running another model.
//
// The agent is selectable only after a stored probe verdict says ok.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { buildSoftJail, inferenceSandboxPolicy, wrapCommand } from '../../collaboration/sandbox-runner';
import { findExecutableOnPath } from '../../runtime/platform';
import {
  type LifecycleCapabilities,
  type Provider,
  type ProviderContentBlock,
  type ProviderEvent,
  type ProviderLifecycle,
  type ProviderMessage,
  type StreamRequest,
} from '../types';
import { providerLog } from '../../logger';
import { createKoryBridgeGrantLease } from '../bridge-grant';
import { buildKoryCliMcpConfig, koryBridgeUnavailableError, resolveKoryBridgeScript } from '../kory-cli-mcp-config';
import { KORY_HARNESS_NOTE } from '../cli-bridges';
import { recordedToolName, recordedToolOutput } from '../recorded-tool';
import { safeProviderDiagnostic, safeProviderFailureMessage } from '../provider-diagnostics';
import { isKoryBridgeMetaExec } from '../opencode-cli';
import { AcpClient } from './client';
import { buildAcpChildEnv } from './env';
import { loadAcpAgentEnv } from './agent-store';
import type { AcpPromptBlock, AcpSessionEvent, AcpStdioMcpServer } from './protocol';

const ACP_STREAM_TIMEOUT_MS = 300_000;
/** The only model id an agent without a model catalog exposes. */
export const ACP_DEFAULT_MODEL_ID = 'default';

export type AcpEnvLoader = () => Record<string, string>;

export class AcpAgentProvider implements Provider {
  readonly imageInputTransport = 'none' as const;
  readonly name: ProviderConfig['name'];
  readonly supportsFreshConversation = true;
  readonly lifecycle: ProviderLifecycle = {
    capabilities: (): LifecycleCapabilities => ({
      version: 1,
      interrupt: true,
      resume: false,
      resumeAfterRestart: false,
      steerInFlight: false,
      rollback: true,
      fork: false,
      terminalStatusQuality: 'strong',
    }),
    resumeHandle: () => null,
  };

  constructor(
    readonly config: ProviderConfig,
    private readonly loadEnv: AcpEnvLoader = () => loadAcpAgentEnv(config.acpAgent?.id ?? ''),
  ) {
    this.name = config.name;
  }

  isAvailable(): boolean {
    const agent = this.config.acpAgent;
    if (this.config.disabled || !agent) return false;
    if (!agent.probe?.ok) return false;
    return findExecutableOnPath(agent.command) !== null || agent.command.includes('/');
  }

  listModels(): ModelDef[] {
    const agent = this.config.acpAgent;
    if (!agent?.probe?.ok) return [];
    const ids = agent.probe.models.length > 0 ? agent.probe.models : [ACP_DEFAULT_MODEL_ID];
    return ids.map((id) => ({
      id,
      name: id === ACP_DEFAULT_MODEL_ID ? `${agent.label} (agent default)` : id,
      provider: this.name,
      apiModelId: id,
      contextWindow: 0,
      maxOutputTokens: 0,
      supportsAttachments: false,
      supportsStreaming: true,
    }));
  }

  isModelCatalogAuthoritative(): boolean {
    return !!this.config.acpAgent?.probe?.ok;
  }

  getModelDiscoveryError(): string | undefined {
    const probe = this.config.acpAgent?.probe;
    return probe && !probe.ok ? probe.error : undefined;
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const agent = this.config.acpAgent;
    if (!agent) {
      yield { type: 'error', error: `${this.name}: agent is not registered` };
      return;
    }
    if (!agent.probe?.ok) {
      yield {
        type: 'error',
        error: `${agent.label} has not passed its capability probe. Run the probe, then try again.`,
      };
      return;
    }

    const researchOnly = request.capabilityProfile === 'research-only';
    const nativeToolsDisabled = request.nativeToolsDisabled === true;
    const wireKoryMcp = !researchOnly && !nativeToolsDisabled;
    const includeHarnessNote = wireKoryMcp && !!request.sessionId;
    const prompt = buildPrompt(request.systemPrompt, request.messages, includeHarnessNote);
    if (!prompt.trim()) {
      yield { type: 'error', error: `${agent.label}: empty prompt` };
      return;
    }

    const privateWorkspace = nativeToolsDisabled || agent.cwdPolicy === 'private';
    const sessionCwd = privateWorkspace
      ? mkdtempSync(join(tmpdir(), 'kory-acp-private-'))
      : request.workingDirectory?.trim() || process.cwd();
    const cleanupPrivate = () => {
      if (privateWorkspace) rmSync(sessionCwd, { recursive: true, force: true });
    };

    // ── Kory MCP bridge (session-scoped grant, passed per ACP session) ──────
    const bridgeGrantLease =
      wireKoryMcp && request.sessionId
        ? createKoryBridgeGrantLease(request.sessionId, request.harnessRole ?? 'manager')
        : undefined;
    let mcpServers: AcpStdioMcpServer[] = [];
    if (wireKoryMcp && request.sessionId) {
      const servers = buildKoryCliMcpConfig(
        {
          provider: this.name,
          role: request.harnessRole ?? 'manager',
          sandbox: request.sandbox,
          workingDirectory: sessionCwd,
          sessionId: request.sessionId,
          systemPrompt: request.systemPrompt ?? '',
          tools: request.tools ?? [],
          bridgeGrantLease,
        },
        this.name,
      );
      mcpServers = (servers ?? []).map((server) => ({
        name: server.name,
        command: server.command,
        args: server.args,
        env: server.env,
      }));
      if (mcpServers.length === 0 && !resolveKoryBridgeScript()) {
        bridgeGrantLease?.cleanup();
        cleanupPrivate();
        yield { type: 'error', error: koryBridgeUnavailableError(this.name) };
        return;
      }
    }

    // ── Environment and sandbox ─────────────────────────────────────────────
    const secretEnv = this.loadEnv();
    let spawnEnv = buildAcpChildEnv(secretEnv);
    let spawnCommand = agent.command;
    let spawnArgs = [...agent.args];
    let jail: ReturnType<typeof buildSoftJail> | null = null;
    if (request.sandbox) {
      jail = buildSoftJail(spawnEnv, [], {}, request.sessionId);
      spawnEnv = { ...jail.env, ...secretEnv };
      const policy = inferenceSandboxPolicy(request.sandbox);
      const wrapped = wrapCommand(agent.command, agent.args, {
        cwd: sessionCwd,
        homeDir: jail.env.HOME as string,
        configDirs: [jail.env.HOME as string, sessionCwd],
        policy,
      });
      spawnCommand = wrapped.command;
      spawnArgs = wrapped.args;
    }

    const permissionProfile =
      researchOnly || nativeToolsDisabled ? 'read-only' : agent.permissionProfile;
    const client = new AcpClient({
      command: spawnCommand,
      args: spawnArgs,
      cwd: sessionCwd,
      env: spawnEnv,
      providerName: this.name,
      label: agent.label,
      permissionProfile,
    });

    const teardown = async () => {
      await client.disconnect().catch(() => undefined);
      bridgeGrantLease?.cleanup();
      jail?.cleanup();
      cleanupPrivate();
    };

    // ── Handshake and session ───────────────────────────────────────────────
    let sessionId: string;
    try {
      const init = await client.connect();
      if (init.protocolVersion !== 1) {
        throw new Error(`agent speaks ACP protocol ${init.protocolVersion}; Kory supports 1`);
      }
      const session = await client.newSession({ cwd: sessionCwd, mcpServers });
      sessionId = session.sessionId;

      const offered = session.configOptions ?? [];
      const modelOption = offered.find((o) => o.id === 'model' || o.category === 'model');
      const requestedModel = request.model?.trim();
      if (requestedModel && requestedModel !== ACP_DEFAULT_MODEL_ID) {
        const allowed = (modelOption?.options ?? []).map((o) => o.value);
        if (!modelOption || !allowed.includes(requestedModel)) {
          throw new Error(`${agent.label} does not offer model "${requestedModel}"`);
        }
        await client.setConfigOption(sessionId, modelOption.id, requestedModel);
      }
      const modeOption = offered.find((o) => o.id === 'mode' || o.category === 'mode');
      if ((researchOnly || nativeToolsDisabled) && modeOption?.options?.some((o) => o.value === 'plan')) {
        await client.setConfigOption(sessionId, modeOption.id, 'plan');
      }
    } catch (err) {
      await teardown();
      const diagnostic = safeProviderDiagnostic(
        this.name,
        'configuration',
        err instanceof Error ? err.message : String(err),
      );
      providerLog.warn(diagnostic, `${agent.label} ACP session negotiation failed`);
      yield { type: 'error', error: safeProviderFailureMessage(this.name, diagnostic) };
      return;
    }

    // ── Turn ────────────────────────────────────────────────────────────────
    const queue: ProviderEvent[] = [];
    let resolveWaiter: (() => void) | null = null;
    const wake = () => {
      resolveWaiter?.();
      resolveWaiter = null;
    };
    const pendingToolCalls = new Map<string, { name: string }>();
    let sawContent = false;
    let sawThinking = false;
    let acpStopReason: string | undefined;
    let promptError: string | undefined;
    let promptDone = false;

    const onSessionEvent = (event: AcpSessionEvent) => {
      switch (event.type) {
        case 'agent_message_chunk':
          sawContent = true;
          queue.push({ type: 'content_delta', content: event.text });
          break;
        case 'agent_thought_chunk':
          sawThinking = true;
          queue.push({ type: 'thinking_delta', thinking: event.text });
          break;
        case 'tool_call':
          pendingToolCalls.set(event.toolCallId, { name: event.name });
          break;
        case 'tool_call_update': {
          const status = event.status ?? '';
          const name = event.name ?? pendingToolCalls.get(event.toolCallId)?.name ?? '';
          if (status !== 'completed' && status !== 'failed') break;
          pendingToolCalls.delete(event.toolCallId);
          // kory__* calls are executed and reported by the Kory bridge itself.
          if (isKoryBridgeMetaExec(event.rawOutput)) break;
          queue.push({
            type: 'tool_executed',
            toolCallId: event.toolCallId,
            toolName: recordedToolName({ name }) ?? name,
            toolInput: safeJson(event.rawInput),
            toolOutput: recordedToolOutput(extractOutput(event)).slice(0, 8_000),
            isError: status === 'failed',
          });
          break;
        }
        case 'usage_update':
          queue.push({
            type: 'usage_update',
            tokensIn: event.used,
            usagePrecision: 'provider-reported',
            estimated: false,
          });
          break;
        default:
          break;
      }
      wake();
    };

    const promptBlocks: AcpPromptBlock[] = [{ type: 'text', text: prompt }];
    const promptPromise = client
      .prompt(sessionId, promptBlocks, onSessionEvent)
      .then((result) => {
        acpStopReason = result.stopReason;
      })
      .catch((err) => {
        promptError = safeProviderFailureMessage(
          this.name,
          safeProviderDiagnostic(this.name, 'stream', err instanceof Error ? err.message : String(err)),
        );
      })
      .finally(() => {
        promptDone = true;
        wake();
      });

    const onAbort = () => {
      client.cancel(sessionId);
      wake();
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });

    const timeout = setTimeout(() => {
      providerLog.warn({ provider: this.name }, `${agent.label} turn timed out — cancelling`);
      client.cancel(sessionId);
      const killer = setTimeout(() => void client.disconnect(), 5_000);
      killer.unref?.();
      wake();
    }, ACP_STREAM_TIMEOUT_MS);
    timeout.unref?.();

    while (true) {
      while (queue.length > 0) {
        if (request.signal?.aborted) break;
        yield queue.shift()!;
      }
      if (request.signal?.aborted) break;
      if (promptDone && queue.length === 0) break;
      await new Promise<void>((resolve) => {
        resolveWaiter = resolve;
        setTimeout(resolve, 100);
      });
    }
    while (queue.length > 0) yield queue.shift()!;

    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', onAbort);
    await promptPromise;
    await teardown();

    if (request.signal?.aborted) return;

    if (promptError) {
      yield { type: 'error', error: promptError };
      return;
    }
    if (!sawContent && !sawThinking) {
      const diagnostic = safeProviderDiagnostic(
        this.name,
        'spawn',
        `Turn ended with stopReason=${acpStopReason ?? 'unknown'} and no content`,
      );
      yield { type: 'error', error: safeProviderFailureMessage(this.name, diagnostic) };
      return;
    }
    yield {
      type: 'complete',
      finishReason: acpStopReason === 'max_tokens' ? 'max_tokens' : 'end_turn',
    };
  }
}

// ─── Prompt construction ─────────────────────────────────────────────────────

function buildPrompt(
  systemPrompt: string | undefined,
  messages: ProviderMessage[],
  includeHarnessNote: boolean,
): string {
  const lines: string[] = [];
  const system = systemPrompt?.trim() ?? '';
  if (includeHarnessNote) {
    lines.push(system ? `${system}\n\n${KORY_HARNESS_NOTE}` : KORY_HARNESS_NOTE, '');
  } else if (system) {
    lines.push(system, '');
  }
  for (const m of messages.filter((msg) => msg.role !== 'system')) {
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
    else if (block.type === 'image') parts.push('[image attachment omitted — ACP agent is text-only here]');
    else if (block.type === 'audio' || block.type === 'video')
      parts.push(`[${block.type} attachment omitted — ACP agent is text-only here]`);
  }
  return parts.join('\n');
}

function extractOutput(event: {
  content?: Array<{ type: string; content?: { type: string; text?: string } }>;
  rawOutput?: unknown;
}): string {
  const parts: string[] = [];
  for (const entry of event.content ?? []) {
    const text = entry.content?.text;
    if (typeof text === 'string' && text) parts.push(text);
  }
  if (parts.length > 0) return parts.join('\n');
  if (event.rawOutput === undefined) return '';
  return typeof event.rawOutput === 'string' ? event.rawOutput : safeJson(event.rawOutput);
}

function safeJson(value: unknown): string {
  if (value === undefined) return '{}';
  try {
    return JSON.stringify(value).slice(0, 32_000);
  } catch {
    return '{}';
  }
}
