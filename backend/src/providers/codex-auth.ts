import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { whichBinary } from './cli-detection';
import { getManagedCodexAppServer, type CodexAppServerModel } from './codex-app-server';
import {
  readCodexModelsCacheFromProfile,
  enrichCodexModelsWithCliCache,
} from './codex-models-cache';
import type { Provider, ProviderEvent, ProviderMessage, StreamRequest } from './types';
import { providerLog } from '../logger';
import { getCliBridge, getKoryphaiosCodexHome, serializeCodexMcpProfile } from './cli-bridges';
import { koryBridgeUnavailableError, resolveKoryBridgeScript } from './kory-cli-mcp-config';
import {
  appendPrivateDiagnostic,
  safeProviderDiagnostic,
  safeProviderFailureMessage,
} from './provider-diagnostics';
import {
  assertPrivateValuesAbsentFromArgv,
  spawnWithPrivateArtifactCleanup,
  writePrivatePromptToStdin,
} from './private-cli-transport';
import { appendBoundedProviderFrames } from './bounded-provider-stream';
import { buildProviderCliEnv } from './cli-environment';
import { createCliAttachmentScope, type CliAttachmentScope } from './cli-attachments';
import {
  buildCodexPrompt,
  codexImageArgs,
  codexJsonEvents,
  codexReasoningArgs,
  codexSpeedTierArgs,
  codexTransientFailureMessage,
  isTransientCodexFailure,
} from './codex-cli';
import { SPEED_TIER_FAST_CODEX } from './speed-tiers';
import { createKoryBridgeGrantLease } from './bridge-grant';
import { writeManagedCliFile } from './managed-cli-storage';

const CODEX_TIMEOUT_MS = 300_000;
/** A non-secret Koryphaios configuration marker; the app-server owns OAuth tokens. */
export const CODEX_MANAGED_AUTH_MARKER = 'codex-managed-chatgpt';

export function buildCodexAuthPrompt(
  systemPrompt: string | undefined,
  messages: ProviderMessage[],
  attachments: Pick<CliAttachmentScope, 'renderContent'>,
  tools?: StreamRequest['tools'],
  harnessRole?: StreamRequest['harnessRole'],
): string {
  // Parity with the CLI-backed `codex` provider: the same harness note and
  // <KORY_TOOL_CALL> envelope protocol so Kory control-plane tools work here.
  return buildCodexPrompt(systemPrompt, messages, tools, harnessRole, attachments);
}

function modelDefinition(model: CodexAppServerModel): ModelDef | null {
  const id = typeof model?.model === 'string' ? model.model : model?.id;
  if (typeof id !== 'string' || !id.trim()) return null;
  const reasoningLevels = Array.isArray(model?.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
        .map((entry) => entry?.reasoningEffort)
        .filter((level: unknown): level is string => typeof level === 'string' && level.length > 0)
    : [];
  const supportsFastTier = Array.isArray(model?.supportedServiceTiers)
    ? model.supportedServiceTiers.includes('fast')
    : /^gpt-5\.(4|5|6)(?:[-.]|$)/.test(id.toLowerCase()) &&
      !/(?:^|-)mini(?:$|-)|codex-spark/.test(id.toLowerCase());
  return {
    id,
    apiModelId: id,
    name:
      typeof model?.displayName === 'string' && model.displayName.trim() ? model.displayName : id,
    provider: 'codex-auth',
    contextWindow: 0,
    contextVerified: false,
    maxOutputTokens: 0,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: reasoningLevels.length > 0,
    reasoningLevels,
    supportsFastMode: supportsFastTier,
    ...(supportsFastTier ? { speedTiers: [SPEED_TIER_FAST_CODEX] } : {}),
    supportsAttachments: model?.inputModalities?.includes?.('image') === true,
    supportsStreaming: true,
    tier: model?.isDefault ? 'flagship' : undefined,
  };
}

/** ChatGPT-managed Codex provider. The official app-server owns OAuth and tokens. */
export class CodexAuthProvider implements Provider {
  readonly imageInputTransport = 'native' as const;
  readonly name = 'codex-auth' as const;
  private models: ModelDef[] = [];
  private account: Awaited<
    ReturnType<ReturnType<typeof getManagedCodexAppServer>['account']>
  > | null = null;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    return !this.config.disabled && this.account?.account?.type === 'chatgpt';
  }

  listModels(): ModelDef[] {
    return this.models;
  }

  async refreshModels(): Promise<void> {
    if (this.config.disabled) return;
    const server = getManagedCodexAppServer();
    this.account = await server.account(false);
    if (this.account.account?.type !== 'chatgpt') {
      this.models = [];
      return;
    }
    const discovered = (await server.listModels())
      .map(modelDefinition)
      .filter((model): model is ModelDef => !!model);
    // The Codex app-server's `model/list` JSON-RPC response omits the context
    // window on purpose; the running CLI's own on-disk cache
    // (`<CODEX_HOME>/models_cache.json`) is the authoritative source. Read it
    // synchronously and stamp the real context limit + max-output tokens onto
    // each model — the same enrichment the CLI-backed `codex` provider uses.
    const cliCache = readCodexModelsCacheFromProfile(getKoryphaiosCodexHome());
    this.models = enrichCodexModelsWithCliCache(discovered, cliCache);
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    try {
      await this.refreshModels();
    } catch (error) {
      const diagnostic = safeProviderDiagnostic(this.name, 'configuration', error);
      providerLog.warn(diagnostic, 'Could not read Codex authentication status');
      yield { type: 'error', error: safeProviderFailureMessage(this.name, diagnostic) };
      return;
    }
    if (!this.isAvailable()) {
      yield {
        type: 'error',
        error: 'OpenAI Codex is not signed in with ChatGPT. Connect it from Settings.',
      };
      return;
    }
    const binary = whichBinary('codex');
    if (!binary) {
      yield { type: 'error', error: 'Codex CLI (codex) was not found on PATH.' };
      return;
    }
    const hasTools = (request.tools?.length ?? 0) > 0;
    const attachmentScope = createCliAttachmentScope();
    const privatePrompt = buildCodexAuthPrompt(
      request.systemPrompt,
      request.messages,
      attachmentScope,
      request.tools,
      request.harnessRole,
    );

    // ── Wire rules (AGENTS.md) into the isolated codex home ────────────────
    // Same control-plane wiring as the CLI-backed `codex` provider: the Kory
    // MCP bridge is the tool transport, native stays sandboxed read-only.
    const codexBridge = getCliBridge('codex');
    const bridgeGrantLease =
      hasTools && request.sessionId
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
    if (hasTools)
      try {
        const ruleFiles = codexBridge?.buildRules(bridgeCtx);
        if (ruleFiles) {
          for (const rule of ruleFiles) {
            writeManagedCliFile(rule.path, rule.content);
          }
        }
      } catch (wiringErr) {
        providerLog.warn(
          { err: wiringErr, provider: this.name },
          'Failed to write rules file for Codex auth',
        );
      }

    const codexHome = getKoryphaiosCodexHome();

    // ── Mount the kory MCP server through a per-turn profile ────────────────
    // `codex --profile kory` layers <codexHome>/kory.config.toml on top of the
    // base config. Without tools there is nothing to expose, so keep
    // third-party servers out entirely via mcp_servers={}.
    let mcpProfile = false;
    if (hasTools) {
      try {
        const mcpConfigs = codexBridge?.buildMcpConfig(bridgeCtx);
        if (
          bridgeCtx.sessionId &&
          (!mcpConfigs || mcpConfigs.length === 0) &&
          !resolveKoryBridgeScript()
        ) {
          yield { type: 'error', error: koryBridgeUnavailableError('codex') };
          return;
        }
        if (mcpConfigs && mcpConfigs.length > 0) {
          writeManagedCliFile(
            join(codexHome, 'kory.config.toml'),
            serializeCodexMcpProfile(mcpConfigs),
          );
          mcpProfile = true;
        }
      } catch (mcpErr) {
        providerLog.warn(
          { err: mcpErr, provider: this.name },
          'Failed to write kory MCP profile for Codex auth; continuing with envelope only',
        );
      }
    }

    const args = [
      '--ask-for-approval',
      'never',
      // MCP and the empty-servers override are mutually exclusive: the kory
      // profile carries the real server list, otherwise keep third-party
      // servers (and their credentials) out of Koryphaios turns entirely.
      ...(mcpProfile ? [] : ['--config', 'mcp_servers={}']),
      'exec',
      '--json',
      // --profile is exec-scoped: it must come after `exec`.
      ...(mcpProfile ? ['--profile', 'kory'] : []),
      '--ephemeral',
      '--skip-git-repo-check',
      '--color',
      'never',
      '--sandbox',
      'read-only',
      '--model',
      request.model,
      ...codexSpeedTierArgs(request.speedTier),
      ...codexReasoningArgs(request.reasoningLevel),
      ...codexImageArgs(attachmentScope),
      '-',
    ];
    assertPrivateValuesAbsentFromArgv(args, [privatePrompt, request.systemPrompt]);
    const child = spawnWithPrivateArtifactCleanup(
      () =>
        spawn(binary, args, {
          cwd: request.workingDirectory?.trim() || process.cwd(),
          stdio: ['pipe', 'pipe', 'pipe'],
          env: buildProviderCliEnv('codex', {
            CODEX_HOME: codexHome,
            HOME: codexHome,
            USERPROFILE: codexHome,
          }),
        }),
      [...attachmentScope.artifacts],
      () => {
        bridgeGrantLease?.cleanup();
      },
    );
    bridgeGrantLease?.bindToChild(child);
    writePrivatePromptToStdin(child, privatePrompt);
    let stderr = '';
    let buffer = '';
    let completed = false;
    let streamFrameFailure: unknown;
    const events: ProviderEvent[] = [];
    let resolveWaiter: (() => void) | null = null;
    let exited = false;
    let exitCode = 0;
    const wake = () => {
      resolveWaiter?.();
      resolveWaiter = null;
    };
    const allowedToolNames = (request.tools ?? []).map((tool) => tool.name);
    const consume = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const translated = codexJsonEvents(event, allowedToolNames);
        events.push(...translated.events);
        if (translated.completed) completed = true;
        wake();
      } catch (err: unknown) {
        providerLog.debug(
          safeProviderDiagnostic(this.name, 'stdout', err),
          'Codex auth: JSONL partial/diagnostic line skipped',
        );
      }
    };
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendPrivateDiagnostic(stderr, chunk);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (streamFrameFailure) return;
      try {
        const bounded = appendBoundedProviderFrames(buffer, chunk.toString());
        buffer = bounded.remainder;
        for (const line of bounded.frames) consume(line);
      } catch (error) {
        streamFrameFailure = error;
        child.kill('SIGTERM');
        wake();
      }
    });
    const onAbort = () => child.kill('SIGTERM');
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => child.kill('SIGTERM'), CODEX_TIMEOUT_MS);
    timeout.unref?.();
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

    // The managed-auth path uses the same Codex JSONL protocol as the CLI
    // provider. Stream the safe reasoning summary and answer as frames arrive
    // rather than retroactively flushing them after process exit.
    while (!exited || events.length > 0) {
      if (events.length > 0) {
        yield events.shift()!;
        continue;
      }
      await new Promise<void>((resolve) => {
        if (events.length > 0 || exited) {
          resolve();
          return;
        }
        resolveWaiter = resolve;
        if (events.length > 0 || exited) wake();
      });
    }
    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', onAbort);
    if (streamFrameFailure) {
      const diagnostic = safeProviderDiagnostic(this.name, 'stdout', streamFrameFailure);
      providerLog.warn(diagnostic, 'OpenAI Codex stream exceeded the structural limit');
      yield { type: 'error', error: safeProviderFailureMessage(this.name, diagnostic) };
      return;
    }
    consume(buffer);
    while (events.length) yield events.shift()!;
    if (request.signal?.aborted) return;
    if (exitCode !== 0) {
      const diagnostic = safeProviderDiagnostic(this.name, 'stderr', stderr, { exitCode });
      providerLog.warn(diagnostic, 'OpenAI Codex CLI request failed');
      if (isTransientCodexFailure(stderr)) {
        // Same binary, same transient ChatGPT-side blips as the CLI-backed
        // provider: honest banner, raw stderr stays in server logs only.
        yield { type: 'error', error: codexTransientFailureMessage() };
        return;
      }
      yield { type: 'error', error: safeProviderFailureMessage(this.name, diagnostic) };
      return;
    }
    if (!completed)
      providerLog.warn({ provider: this.name }, 'Codex auth turn exited without turn.completed');
    yield { type: 'complete', finishReason: 'end_turn' };
  }
}
