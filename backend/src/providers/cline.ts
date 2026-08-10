// Cline CLI provider — runs the official `cline` CLI harness.
//
// CLI-ONLY: Cline has its OWN provider/auth store (~/.cline/data/secrets.json,
// set once via `cline auth --provider … --apikey …`). Koryphaios never holds a
// Cline key — it shells out to the logged-in binary. Headless
// `cline -p <prompt> --act --yolo --json` emits newline-delimited JSON events
// (say/ask/tool/completion) which we translate to ProviderEvents.

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { spawn } from 'node:child_process';
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

const CLINE_STREAM_TIMEOUT_MS = 300_000;
const MODELS_CACHE_TTL_MS = 5 * 60_000;

const HARNESS_SYSTEM_NOTE =
  'You are running inside the Koryphaios orchestrator. Never spawn subagents or delegate to ' +
  'other agents yourself; if work should be parallelized or delegated, say so in your response ' +
  'and Koryphaios will dispatch its own worker agents.';

function buildPrompt(systemPrompt: string | undefined, messages: ProviderMessage[]): string {
  const lines: string[] = [];
  const sys = systemPrompt?.trim();
  // Use the ClineCliBridge's harness note for consistency (Phase 1).
  const clineBridge = getCliBridge('cline');
  const bridgeConfig = clineBridge?.buildAgentConfig({
    provider: 'cline',
    role: 'manager',
    sandbox: undefined,
    workingDirectory: process.cwd(),
    systemPrompt: systemPrompt ?? '',
    tools: [],
  });
  const harnessNote = bridgeConfig?.systemInstructions?.[1] ?? HARNESS_SYSTEM_NOTE;
  lines.push(sys ? `${sys}\n\n${harnessNote}` : harnessNote, '');
  for (const m of messages) {
    const content =
      typeof m.content === 'string'
        ? m.content
        : m.content
            .map((b) =>
              b.type === 'text' ? b.text : b.type === 'image' ? '[image attachment]' : '',
            )
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

function readJsonFile<T = unknown>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch (err: unknown) {
    providerLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Cline JSON file read failed');
    return null;
  }
}

function looksLikeClineModelId(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length < 2 || trimmed.length > 200) return false;
  if (/\s/.test(trimmed)) return false;
  if (trimmed === 'default') return false;
  if (!/^[^\n\r]+$/.test(trimmed)) return false;
  // Common Cline models are short identifiers, not arbitrary long secrets.
  return trimmed.length >= 2 && /^[A-Za-z0-9._/:+-]+$/.test(trimmed);
}

function isClineModelKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized === 'model' ||
    normalized === 'modelid' ||
    normalized === 'model_id' ||
    normalized === 'cline_model' ||
    normalized === 'actmodel' ||
    normalized.includes('modelid') ||
    normalized.includes('model_id') ||
    normalized.includes('clinemodel') ||
    normalized.includes('cline-model') ||
    normalized.includes('model')
  );
}

function collectConfiguredClineModels(
  source: unknown,
  path: string[] = [],
  models: Set<string> = new Set<string>(),
): Set<string> {
  if (!source || typeof source !== 'object') return models;

  if (Array.isArray(source)) {
    for (const item of source) {
      collectConfiguredClineModels(item, path, models);
    }
    return models;
  }

  const record = source as Record<string, unknown>;
  const includesClinePath = path.some((segment) => /cline/i.test(segment));

  for (const [key, value] of Object.entries(record)) {
    const normalized = key.toLowerCase();
    const nextPath = [...path, key];
    if (typeof value === 'string') {
      if (isClineModelKey(normalized) || (includesClinePath && normalized.includes('id'))) {
        const modelId = value.trim();
        if (looksLikeClineModelId(modelId)) {
          models.add(modelId);
        }
      }
      continue;
    }
    collectConfiguredClineModels(value, nextPath, models);
  }
  return models;
}

function readConfiguredClineModels(): ModelDef[] {
  const clineData = join(homedir(), '.cline', 'data');
  const sources = [
    join(clineData, 'settings', 'providers.json'),
    join(clineData, 'globalState.json'),
  ];

  const modelIds = new Set<string>();
  for (const sourcePath of sources) {
    if (!existsSync(sourcePath)) continue;
    const payload = readJsonFile(sourcePath);
    if (!payload || typeof payload !== 'object') continue;
    for (const modelId of collectConfiguredClineModels(payload)) {
      modelIds.add(modelId);
    }
  }

  return [...modelIds].map((modelId) => ({
    id: `cline-${modelId}`,
    name: modelId,
    provider: 'cline',
    apiModelId: modelId,
    contextWindow: 0,
    maxOutputTokens: 0,
    supportsStreaming: true,
    supportsAttachments: false,
  } as ModelDef));
}

interface ClineEvent {
  type?: string; // 'say' | 'ask' | 'task_started' | 'error' | 'completion' | …
  say?: string; // 'text' | 'reasoning' | 'tool' | 'command' | 'api_req_started' | 'completion_result'
  ask?: string;
  text?: string;
}

export class ClineProvider implements Provider {
  readonly name = 'cline' as const;
  private cachedModels: ModelDef[] | null = null;
  private modelsFetchedAt = 0;
  private modelsInFlight = false;

  constructor(readonly config: ProviderConfig) {}

  private static MODEL_LINE_PATTERNS = [
    /^\s*([a-z0-9._\/=:+-]+)\s+-\s+(.+?)\s*(?:\((?:current|active|default)\))?\s*$/i,
    /^\s*([a-z0-9._\/=:+-]+)\s*$/i,
    /^\s*\*?\s*([a-z0-9._\/=:+-]+)\s*$/i,
  ];

  private parseModelOutput(output: string): ModelDef[] {
    const models: ModelDef[] = [];
    const lines = output.replace(/\r\n/g, '\n').split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let match: RegExpMatchArray | null = null;
      let modelId = '';
      let modelName = '';

      for (const pattern of ClineProvider.MODEL_LINE_PATTERNS) {
        const m = pattern.exec(trimmed);
        if (!m) continue;

        match = m;
        modelId = m[1]?.trim() ?? '';
        modelName = (m[2] || m[1] || '').trim();
        break;
      }

      if (!match || !modelId) continue;

      const normalized = modelName.replace(/\s+\(current\)\s*$/i, '').trim();
      models.push({
        id: `cline-${modelId}`,
        name: normalized || modelId,
        provider: 'cline',
        apiModelId: modelId,
        contextWindow: 0,
        maxOutputTokens: 0,
        supportsStreaming: true,
        supportsAttachments: false,
      } as ModelDef);
    }

    const deduped = new Map<string, ModelDef>();
    for (const model of models) {
      deduped.set(model.id, model);
    }
    return [...deduped.values()];
  }

  refreshModels(forceRefresh = false): void {
    if (!forceRefresh && this.modelsFetchedAt > 0 && !this.modelsInFlight && this.cachedModels?.length) {
      return;
    }
    if (this.modelsInFlight) return;
    this.modelsInFlight = true;

    const finalize = (models: ModelDef[]): void => {
      this.cachedModels = models;
      this.modelsFetchedAt = Date.now();
      this.modelsInFlight = false;
      if (models.length) {
        providerLog.debug({ provider: 'cline', count: models.length }, 'Cline model list refreshed');
      }
    };

    const fallbackFromConfig = (): void => {
      const configured = readConfiguredClineModels();
      finalize(configured);
    };

    const candidates: string[][] = [['--list-models'], ['models'], ['list-models'], ['-l']];
    const runCandidate = (index: number): void => {
      if (index >= candidates.length) {
        fallbackFromConfig();
        return;
      }

      const args = candidates[index] ?? ['--list-models'];
      let out = '';

      const child = spawn('cline', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (c: Buffer) => (out += c.toString()));
      child.once('error', () => {
        runCandidate(index + 1);
      });
      child.once('exit', () => {
        const models = this.parseModelOutput(out);
        if (models.length > 0) {
          finalize(models);
          return;
        }
        runCandidate(index + 1);
      });
      setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch (err: unknown) {
          providerLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Cline model probe child already gone on timeout');
        }
      }, 12_000).unref?.();
    };

    runCandidate(0);
  }

  isAvailable(): boolean {
    return !this.config.disabled && !!whichBinary('cline') && detectClineCLILogin();
  }

  listModels(): ModelDef[] {
    if (!this.cachedModels || Date.now() - this.modelsFetchedAt > MODELS_CACHE_TTL_MS) {
      this.refreshModels();
    }
    return this.cachedModels ?? [];
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

    // ── Wire kory MCP server + rules into the isolated cline home ──────────
    // Cline reads MCP servers from cline_mcp_settings.json and .clinerules as
    // always-on rules. Writing these before each turn ensures the CLI
    // discovers the kory__ tool catalog and Kory's session rules on startup.
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
    const bridgeGrantDirectory =
      !researchOnly && bridgeCtx.sessionId
        ? bridgeGrantLease!.grant([
            'mcp:catalog',
            'mcp:execute',
          ]).directory
        : null;
    ensureManagedCliDirectory(clineHome);
    if (!researchOnly) try {
      // MCP: write cline_mcp_settings.json with the kory server.
      const mcpConfigs = clineBridge?.buildMcpConfig(bridgeCtx);
      if (mcpConfigs && mcpConfigs.length > 0) {
        const mcpConfigPath = join(clineHome, 'cline_mcp_settings.json');
        if (existsSync(mcpConfigPath)) healManagedCliFile(mcpConfigPath);
        const existing = existsSync(mcpConfigPath)
          ? JSON.parse(readFileSync(mcpConfigPath, 'utf-8'))
          : {};
        existing.mcpServers = existing.mcpServers ?? {};
        for (const srv of mcpConfigs) {
          existing.mcpServers[srv.name] = {
            command: srv.command,
            args: srv.args,
            env: srv.env,
          };
        }
        writeManagedCliFile(mcpConfigPath, JSON.stringify(existing, null, 2));
      }
      // Rules: write .clinerules with the Kory session rules.
      const ruleFiles = clineBridge?.buildRules(bridgeCtx);
      if (ruleFiles) {
        for (const rule of ruleFiles) {
          writeManagedCliFile(rule.path, rule.content);
        }
      }
    } catch (wiringErr) {
      providerLog.warn(
        safeProviderDiagnostic('cline', 'configuration', wiringErr),
        'Failed to wire kory MCP/rules for Cline',
      );
    }

    const researchRoot = researchOnly ? mkdtempSync(join(tmpdir(), 'kory-web-research-cline-')) : null;
    const cwd = researchRoot ?? (request.workingDirectory?.trim() || process.cwd());
    const args = [
      '--plan',
      '--auto-approve',
      'true',
      '--json',
      '--cwd', cwd,
      '--config', clineHome,
      '--data-dir', join(clineHome, 'data'),
      '--hooks-dir', join(clineHome, 'hooks'),
    ];
    if (request.reasoningLevel && request.reasoningLevel !== 'auto') {
      const lvl = request.reasoningLevel.toLowerCase();
      const modelDef = this.listModels().find(
        (model) => model.id === request.model || model.apiModelId === request.model,
      );
      if (modelDef?.reasoningLevels?.includes(lvl)) {
        args.push('--reasoning-effort', lvl);
      }
    }
    const cliModel = request.model?.replace(/^cline-/, '');
    if (cliModel && cliModel !== 'default') args.push('--model', cliModel);

    const jail = request.sandbox ? buildSoftJail(process.env, [join(homedir(), '.cline')]) : null;
    const wrapped = request.sandbox
      ? wrapCommand(bin, args, {
          cwd,
          configDirs: [clineHome, ...(bridgeGrantDirectory ? [bridgeGrantDirectory] : [])],
          policy: request.sandbox,
        })
      : { command: bin, args };
    assertPrivateValuesAbsentFromArgv(wrapped.args, [prompt, request.systemPrompt]);
    // Point the CLI at the isolated home so it discovers the kory MCP server
    // and .clinerules we just wrote.
    const clineEnv = { ...(jail?.env ?? { ...process.env }) };
    clineEnv.CLINE_HOME = clineHome;
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
        providerLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Cline CLI child already gone on abort');
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
    child.stderr.on('data', (c: Buffer) => (stderr = appendPrivateDiagnostic(stderr, c)));

    const decoder = new TextDecoder();
    let buffer = '';
    let sawContent = false;
    let lastText = '';

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
          let ev: ClineEvent;
          try {
            ev = JSON.parse(line) as ClineEvent;
          } catch {
            providerLog.debug(
              safeProviderDiagnostic('cline', 'stdout', line),
              'Cline skipping non-JSON stream line',
            );
            continue;
          }
          for (const out of this.mapEvent(
            ev,
            () => lastText,
            (t) => (lastText = t),
          )) {
            if (out.type === 'content_delta' || out.type === 'thinking_delta') sawContent = true;
            yield out;
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
        yield {
          type: 'error',
          error: safeProviderFailureMessage('cline', diagnostic),
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
      const diagnostic = safeProviderDiagnostic('cline', 'stdout', ev.text);
      providerLog.warn(diagnostic, 'Cline CLI reported a request failure');
      yield { type: 'error', error: safeProviderFailureMessage('cline', diagnostic) };
      return;
    }
  }
}
