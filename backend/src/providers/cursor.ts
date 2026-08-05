// Cursor CLI provider — runs the official `cursor-agent` harness.
//
// Like claude-code: no API key needed, the locally logged-in CLI authenticates
// itself (Cursor subscription). Headless `-p --output-format stream-json
// --stream-partial-output` gives real streaming: thinking deltas WITH full
// text, tool_call started/completed with args + results, assistant text
// deltas, and a final result line with exact usage (input/output/cache).

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { whichBinary } from './cli-detection';
import { detectCursorCLILogin } from './auth-utils';
import { providerLog } from '../logger';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildSoftJail, wrapCommand } from '../collaboration/sandbox-runner';
import {
  type Provider,
  type ProviderEvent,
  type ProviderMessage,
  type StreamRequest,
} from './types';
import { getCliBridge, getKoryphaiosCursorHome } from './cli-bridges';

const CURSOR_STREAM_TIMEOUT_MS = 300_000;
const MODELS_CACHE_TTL_MS = 5 * 60_000;
const MODELS_LIST_PATTERNS: Array<RegExp> = [
  /\*?\s*([a-z0-9._\/+\+=-]+)\s+[-–—]\s+(.+?)(?:\s+\((?:current|active|default)\))?\s*$/i,
  /\s*[\u2022\-\*]?\s*([a-z0-9._\/+\+=-]+)\s*(?:\(?(?:current|active|default)\)?)\s*$/i,
  /^([a-z0-9._\/+\+=-]+)$/i,
];
const CURSOR_MODEL_COMMANDS: string[][] = [['--list-models'], ['models']];

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '').trim();
}

function parseCursorModelJsonChunk(value: unknown, models: ModelDef[]): void {
  if (Array.isArray(value)) {
    for (const entry of value as unknown[]) {
      parseCursorModelJsonChunk(entry, models);
    }
    return;
  }

  if (typeof value === 'string') {
    const id = value.trim();
    if (id) models.push(buildModelFromId(id, id));
    return;
  }

  if (!value || typeof value !== 'object') return;
  const raw = value as Record<string, unknown>;

  if (Array.isArray(raw.models)) {
    for (const item of raw.models as unknown[]) {
      if (typeof item === 'string') {
        models.push(buildModelFromId(item, item));
      } else if (item && typeof item === 'object') {
        const nested = item as { id?: unknown; name?: unknown };
        const id = String((nested.id as unknown) || '').trim();
        const name = String((nested.name as unknown) || id).trim();
        if (id) models.push(buildModelFromId(id, name || id));
      }
    }
    return;
  }

  const id = String(
    (raw.id as unknown) || (raw.name as unknown) || (raw.model as unknown) || '',
  ).trim();
  if (!id) return;
  models.push(buildModelFromId(id, String((raw.name as unknown) ?? id)));
}

const HARNESS_SYSTEM_NOTE =
  'You are running inside the Koryphaios orchestrator. Never spawn subagents or delegate to ' +
  'other agents yourself; if work should be parallelized or delegated, say so in your response ' +
  'and Koryphaios will dispatch its own worker agents.';

function buildPrompt(systemPrompt: string | undefined, messages: ProviderMessage[]): string {
  const lines: string[] = [];
  const sys = systemPrompt?.trim();
  // Use the CursorCliBridge's harness note for consistency (Phase 1).
  const cursorBridge = getCliBridge('cursor');
  const bridgeConfig = cursorBridge?.buildAgentConfig({
    provider: 'cursor',
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

interface CursorStreamLine {
  type?: string;
  subtype?: string;
  timestamp_ms?: number;
  text?: string;
  is_error?: boolean;
  result?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
  call_id?: string;
  tool_call?: Record<string, { args?: Record<string, unknown>; result?: unknown }>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

export function parseCursorModelList(output: string): ModelDef[] {
  const models: ModelDef[] = [];
  if (/No models available for this account/i.test(output)) return [];
  const lines = output.replace(/\r\n/g, '\n').split('\n').map((line) => line.trim());

  try {
    const jsonValue = JSON.parse(output);
    parseCursorModelJsonChunk(jsonValue, models);
  } catch {
    /* not json */
  }

  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const parsed = stripAnsi(line);
    if (!parsed || /no\s+models\s+available/i.test(parsed)) continue;
    if (/^[A-Za-z][A-Za-z0-9 _-]+:\s*$/i.test(parsed)) continue;
    if (/^available\s+models?:?\s*$/i.test(parsed)) continue;

    const jsonLine = parsed.replace(/^.*?(\{[\s\S]*\}|\[[\s\S]*\]).*$/, '$1');
    if (jsonLine !== parsed || /^\s*[\[{]/.test(parsed)) {
      try {
        parseCursorModelJsonChunk(JSON.parse(jsonLine), models);
        if (models.length > 0) continue;
      } catch {
        /* not json */
      }
    }

    if (/^default\s+model:/i.test(parsed)) {
      const match = parsed.match(/^default\s+model:\s*(.+?)\s*$/i);
      if (match?.[1]) {
        models.push(buildModelFromId(match[1], match[1]));
        continue;
      }
    }

    let match: RegExpMatchArray | null = null;
    const table = parsed
      .split('|')
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk && !/^[-=]+$/.test(chunk));
    const fallbackCandidates = table.length > 1 ? [table[0], parsed] : [parsed];

    for (const candidate of [
      ...fallbackCandidates,
      parsed.replace(/^\s*\d+[.)]\s*/, ''),
      parsed.replace(/^\s*[\u2022\-\*]\s*/, ''),
    ]) {
      if (match) break;
      if (!candidate) continue;
      for (const re of MODELS_LIST_PATTERNS) {
        match = re.exec(candidate);
        if (match) break;
      }
    }

    if (!match) continue;

    const modelId = String(match[1] || '').trim();
    const modelName = String(match[2] || modelId).trim();
    if (modelId) models.push(buildModelFromId(modelId, modelName || modelId));
  }

  if (models.length > 0) return dedupeById(models);

  return [];
}

function buildModelFromId(modelId: string, displayName?: string): ModelDef {
  const trimmed = modelId.trim();
  const humanName = (displayName || trimmed).replace(/\s+\((?:current|active|default)\)\s*$/i, '').trim();
  const fallbackName = humanName || trimmed;

  return {
    id: `cursor-${trimmed}`,
    name: fallbackName,
    provider: 'cursor',
    apiModelId: trimmed,
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    supportsStreaming: true,
    supportsAttachments: false,
  } as ModelDef;
}

function dedupeById(models: ModelDef[]): ModelDef[] {
  const seen = new Set<string>();
  const out: ModelDef[] = [];
  for (const model of models) {
    const key = model.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(model);
  }
  return out;
}

export class CursorProvider implements Provider {
  readonly name = 'cursor' as const;
  private cachedModels: ModelDef[] | null = null;
  private modelsFetchedAt = 0;
  private modelsInFlight = false;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    return !this.config.disabled && !!whichBinary('cursor-agent') && detectCursorCLILogin();
  }

  listModels(): ModelDef[] {
    if (!this.cachedModels || Date.now() - this.modelsFetchedAt > MODELS_CACHE_TTL_MS) {
      this.refreshModels();
    }
    return this.cachedModels ?? [];
  }

  refreshModels(forceRefresh = false): void {
    if (forceRefresh) {
      this.cachedModels = null;
      this.modelsFetchedAt = 0;
      this.modelsInFlight = false;
    }
    if (this.modelsInFlight) return;

    const runCandidate = (index: number): void => {
      if (index >= CURSOR_MODEL_COMMANDS.length) {
        this.modelsInFlight = false;
        return;
      }

      const args = CURSOR_MODEL_COMMANDS[index];
      const child = spawn('cursor-agent', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let out = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString()));
      child.stderr.on('data', (c: Buffer) => (out += c.toString()));

      const finish = () => {
        const models = parseCursorModelList(out);
        if (models.length > 0) {
          this.cachedModels = models;
          this.modelsFetchedAt = Date.now();
          this.modelsInFlight = false;
          providerLog.debug(
            { provider: 'cursor', count: models.length, command: args.join(' ') },
            'Cursor model list refreshed',
          );
          return;
        }
        runCandidate(index + 1);
      };

      child.once('error', finish);
      child.once('exit', finish);
      setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* gone */
        }
      }, 20_000).unref?.();
    };

    this.modelsInFlight = true;
    runCandidate(0);
  }

  private resolveCliModel(modelId: string | undefined): string | undefined {
    if (!modelId) return undefined;
    const def = this.listModels().find((m) => m.id === modelId || m.apiModelId === modelId);
    if (def?.apiModelId) return def.apiModelId;
    return modelId.replace(/^cursor-/, '');
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const bin = whichBinary('cursor-agent');
    if (!bin) {
      yield { type: 'error', error: 'Cursor CLI (cursor-agent) not found on PATH.' };
      return;
    }
    if (!detectCursorCLILogin()) {
      yield {
        type: 'error',
        error: 'Cursor CLI is not logged in — run "cursor-agent login" (no API key needed).',
      };
      return;
    }

    const prompt = buildPrompt(request.systemPrompt, request.messages);
    if (!prompt.trim()) {
      yield { type: 'error', error: 'Cursor: empty prompt' };
      return;
    }

    // ── Wire kory MCP server + rules into the isolated cursor home ─────────
    // Cursor reads MCP servers from its config and .cursorrules as always-on
    // rules. Writing these before each turn ensures the CLI discovers the
    // kory__ tool catalog and Kory's session rules on startup.
    const cursorBridge = getCliBridge('cursor');
    const bridgeCtx = {
      provider: 'cursor' as const,
      role: request.harnessRole ?? 'manager',
      sandbox: request.sandbox,
      workingDirectory: request.workingDirectory?.trim() || process.cwd(),
      sessionId: request.sessionId,
      systemPrompt: request.systemPrompt ?? '',
      tools: request.tools ?? [],
    };
    const cursorHome = getKoryphaiosCursorHome();
    try {
      // MCP: write the kory server config so the CLI gets kory__ tools.
      const mcpConfigs = cursorBridge?.buildMcpConfig(bridgeCtx);
      if (mcpConfigs && mcpConfigs.length > 0) {
        const mcpConfigPath = join(cursorHome, 'mcp.json');
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
        writeFileSync(mcpConfigPath, JSON.stringify(existing, null, 2));
      }
      // Rules: write .cursorrules with the Kory session rules.
      const ruleFiles = cursorBridge?.buildRules(bridgeCtx);
      if (ruleFiles) {
        for (const rule of ruleFiles) {
          mkdirSync(cursorHome, { recursive: true });
          writeFileSync(rule.path, rule.content);
        }
      }
    } catch (wiringErr) {
      providerLog.warn({ err: wiringErr, provider: 'cursor' }, 'Failed to wire kory MCP/rules for Cursor');
    }

    const args = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--trust',
      ...(request.harnessRole === 'critic'
        ? ['--mode', 'ask', '--sandbox', 'enabled']
        : ['--force']),
    ];
    const cliModel = this.resolveCliModel(request.model);
    if (cliModel && cliModel !== 'auto') args.push('--model', cliModel);

    const cwd = request.workingDirectory?.trim() || process.cwd();
    const jail = request.sandbox ? buildSoftJail(process.env, [join(homedir(), '.cursor')]) : null;
    const wrapped = request.sandbox
      ? wrapCommand(bin, args, { cwd, policy: request.sandbox })
      : { command: bin, args };
    // Point the CLI at the isolated home so it discovers the kory MCP server
    // and .cursorrules we just wrote.
    const cursorEnv = { ...(jail?.env ?? { ...process.env }) };
    cursorEnv.CURSOR_CONFIG_DIR = cursorHome;
    const child = spawn(wrapped.command, wrapped.args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cursorEnv,
    });

    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* gone */
      }
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    child.once('close', () => jail?.cleanup());
    const timeout = setTimeout(() => {
      providerLog.warn({ provider: 'cursor' }, 'Cursor harness timed out — killing CLI');
      onAbort();
    }, CURSOR_STREAM_TIMEOUT_MS);
    timeout.unref?.();

    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));

    const decoder = new TextDecoder();
    let buffer = '';
    let sawContent = false;
    let emittedComplete = false;

    try {
      for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
        if (request.signal?.aborted) break;
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;
          let row: CursorStreamLine;
          try {
            row = JSON.parse(line) as CursorStreamLine;
          } catch {
            continue;
          }
          for (const event of this.mapLine(row)) {
            if (event.type === 'content_delta' || event.type === 'thinking_delta')
              sawContent = true;
            if (event.type === 'complete') emittedComplete = true;
            yield event;
          }
        }
      }
    } catch (err) {
      const aborted =
        request.signal?.aborted || (err instanceof Error && err.name === 'AbortError');
      if (!aborted) {
        yield {
          type: 'error',
          error: `Cursor harness error: ${err instanceof Error ? err.message : String(err)}`,
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
      const hint = stderr.trim() || `cursor-agent exited with status ${exitCode}`;
      const loginHint = /not.*logged in|unauthorized|login|authenticate/i.test(hint)
        ? ' — run "cursor-agent login".'
        : '';
      yield { type: 'error', error: `Cursor: ${hint.slice(0, 300)}${loginHint}` };
      return;
    }
    if (!emittedComplete) yield { type: 'complete', finishReason: 'end_turn' };
  }

  private *mapLine(row: CursorStreamLine): Generator<ProviderEvent> {
    switch (row.type) {
      case 'thinking': {
        // Real reasoning TEXT (unlike Claude Code's redacted stream).
        if (row.subtype === 'delta' && row.text) {
          yield { type: 'thinking_delta', thinking: row.text };
        }
        return;
      }
      case 'assistant': {
        // Delta lines carry timestamp_ms; the CLI also emits one final
        // accumulated duplicate WITHOUT it — skip that to avoid double text.
        if (row.timestamp_ms === undefined) return;
        for (const block of row.message?.content ?? []) {
          if (block.type === 'text' && block.text) {
            yield { type: 'content_delta', content: block.text };
          }
        }
        return;
      }
      case 'tool_call': {
        if (row.subtype !== 'completed' || !row.tool_call) return;
        const [kind, payload] = Object.entries(row.tool_call)[0] ?? ['tool', {}];
        const name = kind.replace(/ToolCall$/, '');
        let output = '';
        try {
          output = JSON.stringify(payload?.result ?? '').slice(0, 8_000);
        } catch {
          /* unstringifiable */
        }
        yield {
          type: 'tool_executed',
          toolName: name,
          toolInput: JSON.stringify(payload?.args ?? {}),
          toolOutput: output,
        };
        return;
      }
      case 'result': {
        if (row.usage) {
          yield {
            type: 'usage_update',
            // inputTokens already INCLUDES cached tokens (cacheReadTokens is a
            // detail breakdown) — emitting tokensCache would double count.
            tokensIn: row.usage.inputTokens ?? 0,
            tokensOut: row.usage.outputTokens ?? 0,
          };
        }
        if (row.is_error) {
          yield { type: 'error', error: row.result || 'Cursor request failed' };
          return;
        }
        yield { type: 'complete', finishReason: 'end_turn' };
        return;
      }
      default:
        return;
    }
  }
}
