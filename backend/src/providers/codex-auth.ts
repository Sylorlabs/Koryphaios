import { spawn } from 'node:child_process';
import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { whichBinary } from './cli-detection';
import { getManagedCodexAppServer, type CodexAppServerModel } from './codex-app-server';
import {
  readCodexModelsCacheFromProfile,
  enrichCodexModelsWithCliCache,
} from './codex-models-cache';
import type {
  Provider,
  ProviderEvent,
  ProviderMessage,
  StreamRequest,
} from './types';
import { providerLog } from '../logger';
import { getKoryphaiosCodexHome } from './cli-bridges';
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
import { codexImageArgs, codexReasoningArgs } from './codex-cli';

const CODEX_TIMEOUT_MS = 300_000;
/** A non-secret Koryphaios configuration marker; the app-server owns OAuth tokens. */
export const CODEX_MANAGED_AUTH_MARKER = 'codex-managed-chatgpt';

export function buildCodexAuthPrompt(
  systemPrompt: string | undefined,
  messages: ProviderMessage[],
  attachments: Pick<CliAttachmentScope, 'renderContent'>,
): string {
  return [
    systemPrompt?.trim(),
    'You are running inside Koryphaios. Follow its supplied instructions and finish every turn with a concise user-facing answer.',
    ...messages
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
      .filter(Boolean),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function modelDefinition(model: CodexAppServerModel): ModelDef | null {
  const id = typeof model?.model === 'string' ? model.model : model?.id;
  if (typeof id !== 'string' || !id.trim()) return null;
  const reasoningLevels = Array.isArray(model?.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
        .map((entry) => entry?.reasoningEffort)
        .filter((level: unknown): level is string => typeof level === 'string' && level.length > 0)
    : [];
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
    supportsFastMode: Array.isArray(model?.supportedServiceTiers)
      ? model.supportedServiceTiers.includes('fast')
      : /^gpt-5\.(4|5|6)(?:[-.]|$)/.test(id.toLowerCase()) &&
        !/(?:^|-)mini(?:$|-)|codex-spark/.test(id.toLowerCase()),
    supportsAttachments: model?.inputModalities?.includes?.('image') === true,
    supportsStreaming: true,
    tier: model?.isDefault ? 'flagship' : undefined,
  };
}

/** ChatGPT-managed Codex provider. The official app-server owns OAuth and tokens. */
export class CodexAuthProvider implements Provider {
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
    const attachmentScope = createCliAttachmentScope();
    const privatePrompt = buildCodexAuthPrompt(
      request.systemPrompt,
      request.messages,
      attachmentScope,
    );
    const args = [
      '--ask-for-approval',
      'never',
      'exec',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      '--color',
      'never',
      '--sandbox',
      'read-only',
      '--model',
      request.model,
      ...(request.fastMode ? ['--config', 'service_tier="fast"'] : []),
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
            CODEX_HOME: getKoryphaiosCodexHome(),
            HOME: getKoryphaiosCodexHome(),
            USERPROFILE: getKoryphaiosCodexHome(),
          }),
        }),
      [...attachmentScope.artifacts],
    );
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
    const consume = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const item = event.item as Record<string, unknown> | undefined;
        if (event.type === 'item.completed' && item?.type === 'agent_message' && item.text) {
          events.push({ type: 'content_delta', content: String(item.text) });
        } else if (event.type === 'item.completed' && item?.type === 'reasoning' && item.text) {
          events.push({ type: 'thinking_delta', thinking: String(item.text) });
        } else if (event.type === 'turn.completed') {
          completed = true;
          const usage = event.usage as Record<string, unknown> | undefined;
          if (typeof usage?.input_tokens === 'number' || typeof usage?.output_tokens === 'number') {
            events.push({
              type: 'usage_update',
              tokensIn: usage.input_tokens as number | undefined,
              tokensOut: usage.output_tokens as number | undefined,
              tokensCacheRead:
                typeof usage.cached_input_tokens === 'number'
                  ? usage.cached_input_tokens
                  : undefined,
            });
          }
        }
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
      yield { type: 'error', error: safeProviderFailureMessage(this.name, diagnostic) };
      return;
    }
    if (!completed)
      providerLog.warn({ provider: this.name }, 'Codex auth turn exited without turn.completed');
    yield { type: 'complete', finishReason: 'end_turn' };
  }
}
