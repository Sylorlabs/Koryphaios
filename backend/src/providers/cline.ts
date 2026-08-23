// Cline CLI provider — runs the official `cline` CLI harness.
//
// CLI-ONLY: Cline owns its provider authentication and model configuration.
// Koryphaios never stores a Cline key. The child reads Cline's real provider
// settings while databases, sessions, teams, hooks, and MCP configuration are
// redirected to a private Koryphaios-managed runtime directory.
//
// Cline has shipped two JSON stream generations in the wild:
//   1. legacy top-level say/ask records
//   2. current { type: "agent_event", event: ... } envelopes
// Both are accepted here. An exit code of zero with no recognized frames is a
// protocol error, never a successful empty response.

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { whichBinary } from './cli-detection';
import { detectClineCLILogin } from './auth-utils';
import { providerLog } from '../logger';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSoftJail, wrapCommand } from '../collaboration/sandbox-runner';
import {
  type Provider,
  type ProviderEvent,
  type ProviderMessage,
  type StreamRequest,
} from './types';
import { getCliBridge, getKoryphaiosClineHome } from './cli-bridges';
import { createKoryBridgeGrantLease } from './bridge-grant';
import {
  assertPrivateValuesAbsentFromArgv,
  spawnWithPrivateArtifactCleanup,
  writePrivatePromptToStdin,
} from './private-cli-transport';
import {
  appendPrivateDiagnostic,
  safeProviderDiagnostic,
  safeProviderFailureMessage,
} from './provider-diagnostics';
import {
  ensureManagedCliDirectory,
  healManagedCliFile,
  writeManagedCliFile,
} from './managed-cli-storage';
import { appendBoundedProviderFrames } from './bounded-provider-stream';
import { buildProviderCliEnv } from './cli-environment';

const CLINE_STREAM_TIMEOUT_MS = 300_000;
const MODELS_CACHE_TTL_MS = 5 * 60_000;
const CLINE_HELP_CACHE_TTL_MS = 5 * 60_000;

const HARNESS_SYSTEM_NOTE =
  'You are running inside the Koryphaios orchestrator. Koryphaios owns tool ' +
  'authorization and orchestration. Prefer the role-scoped tools from the kory MCP server. ' +
  'Never spawn Cline teams or subagents; if work should be delegated, say so and ' +
  'Koryphaios will dispatch its own workers.';

interface ClineCliContract {
  inspectedAt: number;
  version?: string;
  help: string;
  supportsJson: boolean;
  supportsPlan: boolean;
  supportsAutoApprove: boolean;
  supportsYolo: boolean;
  supportsCwd: boolean;
  supportsConfig: boolean;
  supportsDataDir: boolean;
  supportsHooksDir: boolean;
  supportsThinking: boolean;
  supportsReasoningEffort: boolean;
  supportsModel: boolean;
}

interface ClineLegacyEvent {
  type?: string;
  say?: string;
  ask?: string;
  text?: string;
  message?: string;
}

interface ClineAgentEvent {
  type?: string;
  contentType?: string;
  text?: string;
  reasoning?: string;
  redacted?: boolean;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  recoverable?: boolean;
  message?: string;
  displayRole?: string;
  reason?: string;
  usage?: unknown;
  inputTokens?: number;
  outputTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
}

interface ClineWireEvent extends ClineLegacyEvent {
  event?: ClineAgentEvent;
}

interface MappedClineEvent {
  recognized: boolean;
  completed: boolean;
  events: ProviderEvent[];
}

function buildPrompt(systemPrompt: string | undefined, messages: ProviderMessage[]): string {
  const lines: string[] = [];
  const sys = systemPrompt?.trim();
  lines.push(sys ? `${sys}\n\n${HARNESS_SYSTEM_NOTE}` : HARNESS_SYSTEM_NOTE, '');
  for (const message of messages) {
    const content =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .map((block) =>
              block.type === 'text'
                ? block.text
                : block.type === 'image'
                  ? '[image attachment]'
                  : '',
            )
            .filter(Boolean)
            .join('\n');
    if (!content.trim()) continue;
    if (message.role === 'user') lines.push(`User: ${content}`);
    else if (message.role === 'assistant') lines.push(`Assistant: ${content}`);
    else if (message.role === 'tool') lines.push(`Tool result: ${content.slice(0, 8_000)}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

function readJsonFile<T = unknown>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch (err: unknown) {
    providerLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Cline JSON file read failed',
    );
    return null;
  }
}

function looksLikeClineModelId(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length < 2 || trimmed.length > 200) return false;
  if (/\s/.test(trimmed) || trimmed === 'default') return false;
  return /^[A-Za-z0-9._/:+-]+$/.test(trimmed);
}

function isClineModelKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized === 'model' ||
    normalized === 'modelid' ||
    normalized === 'model_id' ||
    normalized === 'clinemodel' ||
    normalized === 'cline_model' ||
    normalized === 'actmodel' ||
    normalized === 'planmodel' ||
    normalized.endsWith('modelid') ||
    normalized.endsWith('model_id')
  );
}

function collectConfiguredClineModels(
  source: unknown,
  models: Set<string> = new Set<string>(),
): Set<string> {
  if (!source || typeof source !== 'object') return models;
  if (Array.isArray(source)) {
    for (const item of source) collectConfiguredClineModels(item, models);
    return models;
  }

  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (typeof value === 'string' && isClineModelKey(key) && looksLikeClineModelId(value)) {
      models.add(value.trim());
      continue;
    }
    collectConfiguredClineModels(value, models);
  }
  return models;
}

function modelDefinition(modelId: string, displayName = modelId): ModelDef {
  return {
    id: `cline-${modelId}`,
    name: displayName,
    provider: 'cline',
    apiModelId: modelId,
    contextWindow: 0,
    maxOutputTokens: 0,
    supportsStreaming: true,
    supportsAttachments: false,
    reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
  } as ModelDef;
}

function readConfiguredClineModels(): ModelDef[] {
  const clineData = join(homedir(), '.cline', 'data');
  const sources = [
    join(clineData, 'settings', 'providers.json'),
    join(clineData, 'settings', 'global-settings.json'),
    join(clineData, 'globalState.json'),
    join(clineData, 'secrets.json'),
  ];

  const modelIds = new Set<string>();
  for (const sourcePath of sources) {
    if (!existsSync(sourcePath)) continue;
    const payload = readJsonFile(sourcePath);
    if (!payload || typeof payload !== 'object') continue;
    collectConfiguredClineModels(payload, modelIds);
  }

  const configured = [...modelIds].map((modelId) => modelDefinition(modelId));
  // Cline can resolve its own saved/default model even when it does not expose
  // a stable machine-readable catalog. This is a harness route, not a claim
  // that a model literally named "default" exists upstream.
  return configured.length ? configured : [modelDefinition('default', 'Cline configured model')];
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function boundedOutput(value: unknown): string {
  return outputText(value).slice(0, 8_000);
}

function numberFrom(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function usageEvent(value: unknown): ProviderEvent | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const tokensIn = numberFrom(record, [
    'inputTokens',
    'input_tokens',
    'promptTokens',
    'prompt_tokens',
  ]);
  const tokensOut = numberFrom(record, [
    'outputTokens',
    'output_tokens',
    'completionTokens',
    'completion_tokens',
  ]);
  if (tokensIn === undefined && tokensOut === undefined) return null;
  return { type: 'usage_update', tokensIn: tokensIn ?? 0, tokensOut: tokensOut ?? 0 };
}

function normalizeThinkingLevel(value: string | undefined): string | null {
  if (!value || value === 'auto') return null;
  const normalized = value.toLowerCase();
  if (normalized === 'minimal') return 'low';
  if (['none', 'low', 'medium', 'high', 'xhigh'].includes(normalized)) return normalized;
  return null;
}

function shouldUsePlanMode(request: StreamRequest, researchOnly: boolean): boolean {
  if (researchOnly || request.harnessRole === 'critic' || request.permissionMode === 'plan') {
    return true;
  }
  // A mutating Cline turn must either be confined by the host or explicitly
  // authorized as YOLO. Otherwise fail safe into Cline Plan mode.
  return !request.sandbox && request.permissionMode !== 'yolo';
}

export class ClineProvider implements Provider {
  readonly name = 'cline' as const;
  private cachedModels: ModelDef[] | null = null;
  private modelsFetchedAt = 0;
  private cliContract: ClineCliContract | null = null;

  constructor(readonly config: ProviderConfig) {}

  private inspectCli(bin: string): ClineCliContract {
    if (this.cliContract && Date.now() - this.cliContract.inspectedAt < CLINE_HELP_CACHE_TTL_MS) {
      return this.cliContract;
    }

    const env = buildProviderCliEnv('cline');
    const versionResult = spawnSync(bin, ['--version'], {
      encoding: 'utf8',
      timeout: 8_000,
      env,
      windowsHide: true,
    });
    const helpResult = spawnSync(bin, ['--help'], {
      encoding: 'utf8',
      timeout: 8_000,
      env,
      windowsHide: true,
    });
    const help = `${helpResult.stdout ?? ''}\n${helpResult.stderr ?? ''}`;
    const has = (flag: string) => help.includes(flag);
    this.cliContract = {
      inspectedAt: Date.now(),
      version: `${versionResult.stdout ?? ''}`.trim() || undefined,
      help,
      supportsJson: has('--json'),
      supportsPlan: has('--plan'),
      supportsAutoApprove: has('--auto-approve'),
      supportsYolo: has('--yolo'),
      supportsCwd: has('--cwd'),
      supportsConfig: has('--config'),
      supportsDataDir: has('--data-dir'),
      supportsHooksDir: has('--hooks-dir'),
      supportsThinking: has('--thinking'),
      supportsReasoningEffort: has('--reasoning-effort'),
      supportsModel: has('--model'),
    };
    return this.cliContract;
  }

  refreshModels(forceRefresh = false): void {
    if (
      !forceRefresh &&
      this.cachedModels &&
      Date.now() - this.modelsFetchedAt < MODELS_CACHE_TTL_MS
    ) {
      return;
    }
    this.cachedModels = readConfiguredClineModels();
    this.modelsFetchedAt = Date.now();
  }

  isAvailable(): boolean {
    return !this.config.disabled && !!whichBinary('cline') && detectClineCLILogin();
  }

  listModels(): ModelDef[] {
    if (!this.cachedModels || Date.now() - this.modelsFetchedAt > MODELS_CACHE_TTL_MS) {
      this.refreshModels();
    }
    return this.cachedModels ?? [modelDefinition('default', 'Cline configured model')];
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const researchOnly = request.capabilityProfile === 'research-only';
    const bin = whichBinary('cline');
    if (!bin) {
      yield { type: 'error', error: 'Cline CLI (cline) not found on PATH.' };
      return;
    }
    if (!detectClineCLILogin()) {
      yield {
        type: 'error',
        error: 'Cline CLI is not configured — run "cline auth" in a terminal, then reconnect.',
      };
      return;
    }

    const contract = this.inspectCli(bin);
    if (!contract.supportsJson) {
      yield {
        type: 'error',
        error: `Installed Cline CLI${contract.version ? ` ${contract.version}` : ''} does not expose the required --json protocol. Update Cline, then reconnect.`,
      };
      return;
    }
    if (!contract.supportsConfig) {
      yield {
        type: 'error',
        error: `Installed Cline CLI${contract.version ? ` ${contract.version}` : ''} does not expose --config, so Koryphaios cannot use the CLI-owned account without exposing the user's full home directory. Update Cline, then reconnect.`,
      };
      return;
    }

    const planMode = shouldUsePlanMode(request, researchOnly);
    if (planMode && !contract.supportsPlan) {
      yield {
        type: 'error',
        error: `Installed Cline CLI${contract.version ? ` ${contract.version}` : ''} cannot enforce the required Plan mode. Update Cline or choose a different provider.`,
      };
      return;
    }
    if (!contract.supportsAutoApprove && (planMode || !contract.supportsYolo)) {
      yield {
        type: 'error',
        error: `Installed Cline CLI${contract.version ? ` ${contract.version}` : ''} does not expose the headless approval controls required by Koryphaios. Update Cline, then reconnect.`,
      };
      return;
    }

    const prompt = buildPrompt(request.systemPrompt, request.messages);
    if (!prompt.trim()) {
      yield { type: 'error', error: 'Cline: empty prompt' };
      return;
    }

    const clineBridge = getCliBridge('cline');
    const bridgeGrantLease =
      !researchOnly && request.sessionId
        ? createKoryBridgeGrantLease(request.sessionId, request.harnessRole ?? 'manager')
        : undefined;
    const bridgeCtx = {
      provider: 'cline' as const,
      role: request.harnessRole ?? 'manager',
      sandbox: request.sandbox,
      workingDirectory: request.workingDirectory?.trim() || process.cwd(),
      sessionId: request.sessionId,
      systemPrompt: request.systemPrompt ?? '',
      tools: request.tools ?? [],
      bridgeGrantLease,
    };

    const clineHome = researchOnly
      ? join(getKoryphaiosClineHome(), 'research-only')
      : getKoryphaiosClineHome();
    const clineConfigDir = join(homedir(), '.cline');
    const clineSettingsDir = join(clineConfigDir, 'data', 'settings');
    const clineDataDir = join(clineHome, 'data');
    const clineDbDir = join(clineDataDir, 'db');
    const clineSessionDir = join(clineDataDir, 'sessions');
    const clineTeamDir = join(clineDataDir, 'teams');
    const clineLogDir = join(clineDataDir, 'logs');
    const clineHooksDir = join(clineHome, 'hooks');
    const mcpConfigPath = join(clineDataDir, 'settings', 'cline_mcp_settings.json');
    const bridgeGrantDirectory =
      !researchOnly && bridgeCtx.sessionId
        ? bridgeGrantLease!.grant(['mcp:catalog', 'mcp:execute']).directory
        : null;

    for (const directory of [
      clineHome,
      clineDataDir,
      clineDbDir,
      clineSessionDir,
      clineTeamDir,
      clineLogDir,
      clineHooksDir,
    ]) {
      ensureManagedCliDirectory(directory);
    }

    if (!researchOnly) {
      try {
        const mcpConfigs = clineBridge?.buildMcpConfig(bridgeCtx);
        if (mcpConfigs?.length) {
          if (existsSync(mcpConfigPath)) healManagedCliFile(mcpConfigPath);
          const existing = existsSync(mcpConfigPath)
            ? (JSON.parse(readFileSync(mcpConfigPath, 'utf-8')) as Record<string, unknown>)
            : {};
          const mcpServers =
            existing.mcpServers && typeof existing.mcpServers === 'object'
              ? (existing.mcpServers as Record<string, unknown>)
              : {};
          for (const server of mcpConfigs) {
            mcpServers[server.name] = {
              command: server.command,
              args: server.args,
              env: server.env,
              disabled: false,
            };
          }
          writeManagedCliFile(mcpConfigPath, JSON.stringify({ ...existing, mcpServers }, null, 2));
        }
      } catch (wiringErr) {
        bridgeGrantLease?.cleanup();
        const diagnostic = safeProviderDiagnostic('cline', 'configuration', wiringErr);
        providerLog.error(diagnostic, 'Failed to wire Kory MCP for Cline');
        yield {
          type: 'error',
          error: safeProviderFailureMessage('cline', diagnostic),
        };
        return;
      }
    }

    const researchRoot = researchOnly
      ? mkdtempSync(join(tmpdir(), 'kory-web-research-cline-'))
      : null;
    const cwd = researchRoot ?? (request.workingDirectory?.trim() || process.cwd());
    const args: string[] = [];
    if (planMode) args.push('--plan');
    if (contract.supportsAutoApprove) args.push('--auto-approve', 'true');
    else args.push('--yolo');
    args.push('--json');
    if (contract.supportsCwd) args.push('--cwd', cwd);
    args.push('--config', clineConfigDir);
    if (contract.supportsHooksDir) args.push('--hooks-dir', clineHooksDir);

    const thinkingLevel = normalizeThinkingLevel(request.reasoningLevel);
    if (thinkingLevel) {
      if (contract.supportsThinking) args.push('--thinking', thinkingLevel);
      else if (contract.supportsReasoningEffort) {
        args.push('--reasoning-effort', thinkingLevel);
      }
    }
    const cliModel = request.model?.replace(/^cline-/, '');
    if (contract.supportsModel && cliModel && cliModel !== 'default') {
      args.push('--model', cliModel);
    }

    const baseEnv = buildProviderCliEnv('cline', {
      CLINE_HOME: clineConfigDir,
      CLINE_PROVIDER_SETTINGS_PATH: join(clineSettingsDir, 'providers.json'),
      CLINE_GLOBAL_SETTINGS_PATH: join(clineSettingsDir, 'global-settings.json'),
      CLINE_MCP_SETTINGS_PATH: researchOnly ? undefined : mcpConfigPath,
      CLINE_DB_DATA_DIR: clineDbDir,
      CLINE_SESSION_DATA_DIR: clineSessionDir,
      CLINE_TEAM_DATA_DIR: clineTeamDir,
      CLINE_HOOKS_DIR: clineHooksDir,
      CLINE_HOOKS_LOG_PATH: join(clineLogDir, 'hooks.jsonl'),
      CLINE_SESSION_BACKEND_MODE: 'local',
      // A modern Cline --data-dir sets CLINE_PROVIDER_SETTINGS_PATH to the
      // isolated directory. Delete ambient sandbox/data overrides so the
      // explicit CLI-owned provider settings path above remains authoritative.
      CLINE_DATA_DIR: undefined,
      CLINE_SANDBOX: undefined,
      CLINE_SANDBOX_DATA_DIR: undefined,
      HOME: clineHome,
      USERPROFILE: clineHome,
    });
    const jail = request.sandbox ? buildSoftJail(baseEnv, [clineHome, clineConfigDir]) : null;
    const wrapped = request.sandbox
      ? wrapCommand(bin, args, {
          cwd,
          configDirs: [
            clineHome,
            clineConfigDir,
            ...(bridgeGrantDirectory ? [bridgeGrantDirectory] : []),
          ],
          policy: request.sandbox,
        })
      : { command: bin, args };
    assertPrivateValuesAbsentFromArgv(wrapped.args, [prompt, request.systemPrompt]);
    const clineEnv = { ...(jail?.env ?? baseEnv) };
    const child = spawnWithPrivateArtifactCleanup(
      () =>
        spawn(wrapped.command, wrapped.args, {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: clineEnv,
        }),
      [],
      () => bridgeGrantLease?.cleanup(),
    );
    bridgeGrantLease?.bindToChild(child);
    writePrivatePromptToStdin(child, prompt);

    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch (err: unknown) {
        providerLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Cline CLI child already gone on abort',
        );
      }
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    child.once('close', () => {
      jail?.cleanup();
      if (researchRoot) rmSync(researchRoot, { recursive: true, force: true });
    });
    const timeout = setTimeout(() => {
      providerLog.warn({ provider: 'cline' }, 'Cline harness timed out — killing CLI');
      onAbort();
    }, CLINE_STREAM_TIMEOUT_MS);
    timeout.unref?.();

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendPrivateDiagnostic(stderr, chunk);
    });

    const decoder = new TextDecoder();
    let buffer = '';
    let sawContent = false;
    let sawRecognizedFrame = false;
    let sawComplete = false;
    let lastLegacyText = '';

    try {
      for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
        if (request.signal?.aborted) break;
        const bounded = appendBoundedProviderFrames(
          buffer,
          decoder.decode(chunk, { stream: true }),
        );
        buffer = bounded.remainder;
        for (const raw of bounded.frames) {
          const line = raw.trim();
          if (!line) continue;
          let event: ClineWireEvent;
          try {
            event = JSON.parse(line) as ClineWireEvent;
          } catch {
            providerLog.debug(
              safeProviderDiagnostic('cline', 'stdout', line),
              'Cline skipping non-JSON stream line',
            );
            continue;
          }
          const mapped = this.mapEvent(event, lastLegacyText);
          if (mapped.recognized) sawRecognizedFrame = true;
          if (mapped.completed) sawComplete = true;
          for (const output of mapped.events) {
            if (output.type === 'content_delta' && output.content) {
              sawContent = true;
              lastLegacyText += event.type === 'say' ? output.content : '';
            } else if (output.type === 'thinking_delta') {
              sawContent = true;
            }
            yield output;
          }
        }
      }
    } catch (err) {
      const aborted =
        request.signal?.aborted || (err instanceof Error && err.name === 'AbortError');
      if (!aborted) {
        onAbort();
        const diagnostic = safeProviderDiagnostic('cline', 'stream', err);
        providerLog.error(diagnostic, 'Cline harness stream failed');
        yield { type: 'error', error: safeProviderFailureMessage('cline', diagnostic) };
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

    if (exitCode !== 0) {
      const diagnostic = safeProviderDiagnostic('cline', 'stderr', stderr, { exitCode });
      providerLog.warn(diagnostic, 'Cline CLI exited unsuccessfully');
      yield {
        type: 'error',
        error: safeProviderFailureMessage('cline', diagnostic, {
          authenticationAction: 'Run "cline auth", then reconnect.',
        }),
      };
      return;
    }
    if (!sawRecognizedFrame) {
      yield {
        type: 'error',
        error: `Cline CLI${contract.version ? ` ${contract.version}` : ''} exited without any recognized JSON protocol frames. This Cline version is not compatible with the installed Koryphaios adapter.`,
      };
      return;
    }
    if (!sawContent) {
      providerLog.warn(
        { provider: 'cline', version: contract.version },
        'Cline completed without user-facing content',
      );
    }
    if (!sawComplete) yield { type: 'complete', finishReason: 'end_turn' };
  }

  private mapEvent(event: ClineWireEvent, lastLegacyText: string): MappedClineEvent {
    if (event.type === 'agent_event' && event.event) {
      return this.mapAgentEvent(event.event);
    }
    if (event.type === 'team_event') {
      // Koryphaios owns orchestration; upstream team telemetry is intentionally
      // consumed but not surfaced as a second competing team system.
      return { recognized: true, completed: false, events: [] };
    }
    if (event.type === 'error' && (event.message || event.text)) {
      const text = event.message ?? event.text ?? 'Cline reported an error';
      const diagnostic = safeProviderDiagnostic('cline', 'stdout', text);
      return {
        recognized: true,
        completed: false,
        events: [{ type: 'error', error: safeProviderFailureMessage('cline', diagnostic) }],
      };
    }

    // Legacy protocol: top-level cumulative say/ask records.
    if (event.type === 'say' && event.say === 'text' && typeof event.text === 'string') {
      const delta = event.text.startsWith(lastLegacyText)
        ? event.text.slice(lastLegacyText.length)
        : event.text;
      return {
        recognized: true,
        completed: false,
        events: delta ? [{ type: 'content_delta', content: delta }] : [],
      };
    }
    if (event.type === 'say' && event.say === 'reasoning' && event.text) {
      return {
        recognized: true,
        completed: false,
        events: [{ type: 'thinking_delta', thinking: event.text }],
      };
    }
    if (event.type === 'say' && (event.say === 'tool' || event.say === 'command') && event.text) {
      return {
        recognized: true,
        completed: false,
        events: [
          {
            type: 'tool_executed',
            toolName: event.say === 'command' ? 'bash' : 'tool',
            toolInput: '{}',
            toolOutput: event.text.slice(0, 8_000),
          },
        ],
      };
    }
    if (event.type === 'say' && event.say === 'completion_result') {
      const text = event.text ?? '';
      const delta = text.startsWith(lastLegacyText) ? text.slice(lastLegacyText.length) : text;
      return {
        recognized: true,
        completed: true,
        events: [
          ...(delta ? [{ type: 'content_delta' as const, content: delta }] : []),
          { type: 'complete' as const, finishReason: 'end_turn' as const },
        ],
      };
    }
    if (event.type === 'completion' || event.type === 'done') {
      return {
        recognized: true,
        completed: true,
        events: [{ type: 'complete', finishReason: 'end_turn' }],
      };
    }

    return { recognized: false, completed: false, events: [] };
  }

  private mapAgentEvent(event: ClineAgentEvent): MappedClineEvent {
    if (event.type === 'content_start') {
      if (event.contentType === 'text' && event.text) {
        return {
          recognized: true,
          completed: false,
          events: [{ type: 'content_delta', content: event.text }],
        };
      }
      if (event.contentType === 'reasoning') {
        const thinking = event.reasoning || (event.redacted ? '[redacted]' : '');
        return {
          recognized: true,
          completed: false,
          events: thinking ? [{ type: 'thinking_delta', thinking }] : [],
        };
      }
      if (event.contentType === 'tool') {
        return { recognized: true, completed: false, events: [] };
      }
      return { recognized: true, completed: false, events: [] };
    }

    if (event.type === 'content_end') {
      if (event.contentType !== 'tool') {
        return { recognized: true, completed: false, events: [] };
      }
      return {
        recognized: true,
        completed: false,
        events: [
          {
            type: 'tool_executed',
            toolCallId: event.toolCallId,
            toolName: event.toolName ?? 'tool',
            toolInput: outputText(event.input) || '{}',
            toolOutput: boundedOutput(event.error ?? event.output),
            isError: Boolean(event.error),
          },
        ],
      };
    }

    if (event.type === 'usage') {
      const usage = usageEvent(event.usage ?? event);
      return {
        recognized: true,
        completed: false,
        events: usage ? [usage] : [],
      };
    }

    if (event.type === 'done') {
      const usage = usageEvent(event.usage);
      return {
        recognized: true,
        completed: true,
        events: [...(usage ? [usage] : []), { type: 'complete', finishReason: 'end_turn' }],
      };
    }

    if (event.type === 'error') {
      const text = event.error ?? event.message ?? 'Cline reported an error';
      const diagnostic = safeProviderDiagnostic('cline', 'stdout', text);
      return {
        recognized: true,
        completed: false,
        events: [{ type: 'error', error: safeProviderFailureMessage('cline', diagnostic) }],
      };
    }

    if (
      event.type === 'iteration_start' ||
      event.type === 'iteration_end' ||
      event.type === 'notice'
    ) {
      return { recognized: true, completed: false, events: [] };
    }

    return { recognized: false, completed: false, events: [] };
  }
}
