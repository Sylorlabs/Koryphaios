import { spawn } from 'node:child_process';
import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { getKoryCodexHome } from './auth-utils';
import { whichBinary } from './cli-detection';
import { getManagedCodexAppServer } from './codex-app-server';
import type { Provider, ProviderContentBlock, ProviderEvent, ProviderMessage, StreamRequest } from './types';
import { providerLog } from '../logger';

const CODEX_TIMEOUT_MS = 300_000;
/** A non-secret Koryphaios configuration marker; the app-server owns OAuth tokens. */
export const CODEX_MANAGED_AUTH_MARKER = 'codex-managed-chatgpt';

function flatten(content: string | ProviderContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

function prompt(systemPrompt: string | undefined, messages: ProviderMessage[]): string {
  return [
    systemPrompt?.trim(),
    'You are running inside Koryphaios. Follow its supplied instructions and finish every turn with a concise user-facing answer.',
    ...messages
      .filter((message) => message.role !== 'system')
      .map((message) => {
        const text = flatten(message.content).trim();
        if (!text) return '';
        const label = message.role === 'assistant' ? 'Assistant' : message.role === 'tool' ? 'Tool result' : 'User';
        return `${label}: ${text}`;
      })
      .filter(Boolean),
  ].filter(Boolean).join('\n\n');
}

function modelDefinition(model: any): ModelDef | null {
  const id = typeof model?.model === 'string' ? model.model : model?.id;
  if (typeof id !== 'string' || !id.trim()) return null;
  const reasoningLevels = Array.isArray(model?.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
      .map((entry: any) => entry?.reasoningEffort)
      .filter((level: unknown): level is string => typeof level === 'string' && level.length > 0)
    : [];
  return {
    id,
    apiModelId: id,
    name: typeof model?.displayName === 'string' && model.displayName.trim() ? model.displayName : id,
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
      : /^gpt-5\.(4|5|6)(?:[-.]|$)/.test(id.toLowerCase())
        && !/(?:^|-)mini(?:$|-)|codex-spark/.test(id.toLowerCase()),
    supportsAttachments: model?.inputModalities?.includes?.('image') === true,
    supportsStreaming: true,
    tier: model?.isDefault ? 'flagship' : undefined,
  };
}

/** ChatGPT-managed Codex provider. The official app-server owns OAuth and tokens. */
export class CodexAuthProvider implements Provider {
  readonly name = 'codex-auth' as const;
  private models: ModelDef[] = [];
  private account: Awaited<ReturnType<ReturnType<typeof getManagedCodexAppServer>['account']>> | null = null;

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
    this.models = (await server.listModels())
      .map(modelDefinition)
      .filter((model): model is ModelDef => !!model);
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    try {
      await this.refreshModels();
    } catch (error) {
      yield { type: 'error', error: error instanceof Error ? error.message : 'Could not read Codex authentication status' };
      return;
    }
    if (!this.isAvailable()) {
      yield { type: 'error', error: 'OpenAI Codex is not signed in with ChatGPT. Connect it from Settings.' };
      return;
    }
    const binary = whichBinary('codex');
    if (!binary) {
      yield { type: 'error', error: 'Codex CLI (codex) was not found on PATH.' };
      return;
    }
    const child = spawn(binary, [
      '--ask-for-approval', 'never', 'exec', '--json', '--ephemeral', '--skip-git-repo-check',
      '--color', 'never', '--sandbox', 'read-only',
      '--model', request.model,
      ...(request.fastMode ? ['--config', 'service_tier="fast"'] : []),
      ...(request.reasoningLevel ? ['--config', `model_reasoning_effort=${JSON.stringify(request.reasoningLevel)}`] : []),
      prompt(request.systemPrompt, request.messages),
    ], {
      cwd: request.workingDirectory?.trim() || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: getKoryCodexHome() },
    });
    let stderr = '';
    let buffer = '';
    let completed = false;
    const events: ProviderEvent[] = [];
    const consume = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as Record<string, any>;
        const item = event.item as Record<string, any> | undefined;
        if (event.type === 'item.completed' && item?.type === 'agent_message' && item.text) {
          events.push({ type: 'content_delta', content: String(item.text) });
        } else if (event.type === 'item.completed' && item?.type === 'reasoning' && item.text) {
          events.push({ type: 'thinking_delta', thinking: String(item.text) });
        } else if (event.type === 'turn.completed') {
          completed = true;
          const usage = event.usage as Record<string, unknown> | undefined;
          if (typeof usage?.input_tokens === 'number' || typeof usage?.output_tokens === 'number') {
            events.push({ type: 'usage_update', tokensIn: usage.input_tokens as number | undefined, tokensOut: usage.output_tokens as number | undefined });
          }
        }
      } catch (err: unknown) { providerLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Codex auth: JSONL partial/diagnostic line skipped'); }
    };
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) consume(line);
    });
    const onAbort = () => child.kill('SIGTERM');
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => child.kill('SIGTERM'), CODEX_TIMEOUT_MS);
    timeout.unref?.();
    const exitCode = await new Promise<number>((resolve) => {
      child.once('error', () => resolve(-1));
      child.once('exit', (code) => resolve(code ?? 0));
    });
    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', onAbort);
    consume(buffer);
    while (events.length) yield events.shift()!;
    if (request.signal?.aborted) return;
    if (exitCode !== 0) {
      yield { type: 'error', error: `OpenAI Codex failed: ${(stderr.trim() || `exit status ${exitCode}`).slice(0, 500)}` };
      return;
    }
    if (!completed) providerLog.warn({ provider: this.name }, 'Codex auth turn exited without turn.completed');
    yield { type: 'complete', finishReason: 'end_turn' };
  }
}
