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
import { readFileSync, realpathSync, statSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { whichBinary } from './cli-detection';
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

/** Map a UI reasoning level to a MAX_THINKING_TOKENS budget for the claude CLI.
 *  Legacy fallback for CLI versions without `--effort`, plus the 'none'/numeric
 *  cases the effort flag can't express. Returns null for absent/unknown levels. */
function reasoningLevelToThinkingTokens(level: string | undefined): string | null {
  if (!level) return null;
  const l = level.toLowerCase().trim();
  if (l === 'none' || l === 'off' || l === '0') return '0';
  if (l === 'minimal' || l === 'low') return '4096';
  if (l === 'medium' || l === 'on' || l === 'default') return '16384';
  if (l === 'high') return '32768';
  if (l === 'xhigh' || l === 'max') return '63999';
  // Numeric budget passthrough (e.g. '8192').
  if (/^\d+$/.test(l)) return l;
  return null;
}

// ── Dynamic reasoning-effort discovery ──────────────────────────────────────

// Modern claude CLIs expose `--effort <level>` and document the accepted values
// in their own help text ("Effort level for the current session (low, medium,
// high, xhigh, max)"). Parse them from the installed binary so the reasoning
// picker reflects exactly what THIS CLI version accepts — never a hardcoded
// list that goes stale when the CLI adds/renames tiers.
let effortLevelsPromise: Promise<string[] | null> | null = null;
let cachedEffortLevels: string[] | null = null;

function detectEffortLevels(): Promise<string[] | null> {
  if (!effortLevelsPromise) {
    effortLevelsPromise = new Promise((resolve) => {
      const child = spawn('claude', ['--help'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        const m = out.match(/--effort <level>[\s\S]{0,200}?\(([a-z][a-z, ]+)\)/);
        cachedEffortLevels = m
          ? m[1].split(',').map((s) => s.trim()).filter(Boolean)
          : null;
        if (!cachedEffortLevels) {
          providerLog.debug(
            { provider: 'claude' },
            'claude CLI does not advertise --effort; falling back to MAX_THINKING_TOKENS',
          );
        }
        resolve(cachedEffortLevels);
      };
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
      });
      child.once('exit', finish);
      child.once('error', finish);
      setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        finish();
      }, 10_000);
    });
  }
  return effortLevelsPromise;
}

/** Map a UI reasoning level onto one of the CLI's advertised --effort values.
 *  Returns null when the level has no effort equivalent (caller falls back to
 *  the MAX_THINKING_TOKENS env var). */
function mapToEffort(level: string, levels: string[] | null): string | null {
  if (!levels?.length) return null;
  const l = level.toLowerCase().trim();
  if (levels.includes(l)) return l;
  const synonyms: Record<string, string> = { minimal: 'low', default: 'medium', on: 'medium' };
  const mapped = synonyms[l];
  return mapped && levels.includes(mapped) ? mapped : null;
}

// ── Per-model capability catalog, extracted from the CLI's own binary ───────

// The claude binary embeds its real model catalog: entries like
//   {id:"claude-haiku-4-5",family:"haiku",display_name:"Haiku 4.5",...,
//    capabilities:["effort","max_effort","xhigh_effort","adaptive_thinking",...],
//    default_effort:"high",...}
// The `effort` capability gates the low/medium/high tiers; `xhigh_effort` and
// `max_effort` add their tiers. Haiku 4.5 has NO effort capability at all — the
// CLI accepts --effort for it without a warning but ignores it, so probing flag
// acceptance is NOT sufficient. This catalog is the same data the CLI's own
// /model picker uses, so parsing it is the only accurate per-model source.
interface CliCatalogEntry {
  id: string;
  displayName: string;
  capabilities: string[];
  defaultEffort?: string;
  /** Documented context window from the catalog's context:{window:N} field. */
  contextWindow?: number;
}

let cachedCatalog: Map<string, CliCatalogEntry> | null = null;
let cachedCatalogKey = '';

/** Locate the actual claude executable (the big bundled binary, not a shim). */
function findClaudeBinaries(): string[] {
  const found = whichBinary('claude');
  if (!found) return [];
  const candidates: string[] = [];
  try {
    const real = realpathSync(found);
    candidates.push(real);
    // npm installs resolve to <pkg>/bin/claude.exe (a small copied-over native
    // binary) with the real platform binary in a sibling platform package —
    // scan those too in case the bin stub is a JS wrapper.
    const pkgRoot = dirname(dirname(real));
    const platformDir = join(pkgRoot, 'node_modules', '@anthropic-ai');
    if (existsSync(platformDir)) {
      for (const entry of readdirSync(platformDir)) {
        if (!entry.startsWith('claude-code-')) continue;
        const bin = join(platformDir, entry, 'claude');
        if (existsSync(bin)) candidates.push(bin);
      }
    }
  } catch {
    candidates.push(found);
  }
  return candidates;
}

function parseCatalogFromBuffer(buf: Buffer): Map<string, CliCatalogEntry> {
  const catalog = new Map<string, CliCatalogEntry>();
  const marker = Buffer.from('{id:"claude-');
  let pos = 0;
  for (;;) {
    pos = buf.indexOf(marker, pos);
    if (pos === -1) break;
    // Entries are well under 1.6KB of minified JS; cut at the next entry start.
    const chunk = buf.subarray(pos, pos + 1600).toString('latin1');
    pos += marker.length;
    const next = chunk.indexOf('{id:"claude-', 12);
    const entry = next > 0 ? chunk.slice(0, next) : chunk;
    const head = entry.match(/^\{id:"(claude-[a-z0-9.-]+)",family:"[a-z]+",display_name:"([^"]+)"/);
    if (!head) continue;
    const caps = entry.match(/capabilities:\[([^\]]*)\]/);
    const de = entry.match(/default_effort:"([a-z]+)"/);
    const ctx = entry.match(/context:\{window:(\d+)/);
    const capabilities = caps
      ? caps[1].split(',').map((c) => c.trim().replace(/^"|"$/g, '')).filter(Boolean)
      : [];
    if (!catalog.has(head[1])) {
      catalog.set(head[1], {
        id: head[1],
        displayName: head[2],
        capabilities,
        defaultEffort: de?.[1],
        ...(ctx ? { contextWindow: Number(ctx[1]) } : {}),
      });
    }
  }
  return catalog;
}

/** Parse the model catalog out of the installed CLI binary. Cached per
 *  binary path+mtime so a CLI update transparently re-extracts. */
function getCliModelCatalog(): Map<string, CliCatalogEntry> | null {
  for (const path of findClaudeBinaries()) {
    try {
      const stat = statSync(path);
      if (stat.size < 1_000_000) continue; // shims/wrappers can't hold the catalog
      const key = `${path}:${stat.mtimeMs}:${stat.size}`;
      if (cachedCatalog && cachedCatalogKey === key) return cachedCatalog;
      const catalog = parseCatalogFromBuffer(readFileSync(path));
      if (catalog.size > 0) {
        cachedCatalog = catalog;
        cachedCatalogKey = key;
        providerLog.info(
          { provider: 'claude', models: catalog.size, binary: path },
          'Extracted model catalog from claude CLI binary',
        );
        return catalog;
      }
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/** Convert a catalog entry's capability flags to selectable effort tiers.
 *  Empty array = the model has no effort control (e.g. Haiku 4.5). */
function capabilitiesToLevels(caps: string[]): string[] {
  if (!caps.includes('effort')) return [];
  const levels = ['low', 'medium', 'high'];
  if (caps.includes('xhigh_effort')) levels.push('xhigh');
  if (caps.includes('max_effort')) levels.push('max');
  return levels;
}

/** Look up the catalog entry for a real model ID (handles date suffixes like
 *  claude-haiku-4-5-20251001 and the [1m] long-context marker). */
function catalogEntryFor(
  realId: string | undefined,
  catalog: Map<string, CliCatalogEntry> | null,
): CliCatalogEntry | null {
  if (!realId || !catalog) return null;
  const bare = realId.replace(/\[1m\]$/i, '');
  const exact = catalog.get(bare);
  if (exact) return exact;
  // Longest catalog id that prefixes the real id (strips -YYYYMMDD suffixes).
  let best: CliCatalogEntry | null = null;
  for (const entry of catalog.values()) {
    if (bare.startsWith(entry.id) && (!best || entry.id.length > best.id.length)) best = entry;
  }
  return best;
}

// ── Dynamic alias → real model ID discovery ────────────────────────────────

// Module-level cache shared across all provider instances.
let cachedModels: ModelDef[] | null = null;
let cachedModelsAt = 0;
let refreshInProgress = false;

/**
 * Probe a single claude alias (e.g. 'opus') by spawning a headless run and
 * reading the `init` system event's `model` field — the CLI resolves the alias
 * to the real model ID before any inference starts, so killing the child on
 * init costs ZERO tokens (the assistant-message path remains as a fallback for
 * older CLIs whose init event lacked `model`).
 */
async function probeAlias(alias: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      'claude',
      ['-p', '.', '--output-format', 'stream-json', '--verbose', '--model', alias],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env },
      },
    );

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
          if (d.type === 'system' && d.subtype === 'init' && typeof d.model === 'string') {
            done(d.model);
            return;
          }
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
 *  claude-opus-4-8           → "Claude Opus 4.8"
 *  claude-haiku-4-5-20251001 → "Claude Haiku 4.5"
 *  claude-fable-5            → "Claude Fable 5"
 *  claude-fable-5[1m]        → "Claude Fable 5 (1M)"
 */
function realIdToName(id: string): string {
  const oneM = /\[1m\]$/i.test(id);
  const bare = id.replace(/\[1m\]$/i, '');
  const suffix = oneM ? ' (1M)' : '';
  // family + two-part version, optional date suffix
  const m = bare.match(/^claude-([a-z]+)-(\d+)-(\d+)/);
  if (m) {
    const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    return `Claude ${family} ${m[2]}.${m[3]}${suffix}`;
  }
  // family + single version (e.g. claude-fable-5)
  const s = bare.match(/^claude-([a-z]+)-(\d+)$/);
  if (s) {
    const family = s[1].charAt(0).toUpperCase() + s[1].slice(1);
    return `Claude ${family} ${s[2]}${suffix}`;
  }
  return id;
}

/** Server-driven extra models from the CLI's own on-disk cache (~/.claude.json
 *  `additionalModelOptionsCache`) — this is where the CLI stores models pushed
 *  to it beyond the built-in aliases, e.g. `claude-fable-5[1m]` (1M context).
 *  Reading it means new models appear here the moment the CLI learns about
 *  them, with no Koryphaios release needed. */
function readCliExtraModels(): ModelDef[] {
  try {
    const raw = readFileSync(join(homedir(), '.claude.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      additionalModelOptionsCache?: Array<{ value?: unknown; label?: unknown }>;
    };
    const opts = parsed.additionalModelOptionsCache;
    if (!Array.isArray(opts)) return [];
    return opts
      .filter((o): o is { value: string } => typeof o?.value === 'string' && o.value.startsWith('claude-'))
      .map((o) => {
        const value = o.value;
        const oneM = /\[1m\]$/i.test(value);
        return {
          id: `claude-code-${value.replace(/[^a-z0-9]+/gi, '-').replace(/-+$/, '')}`,
          name: realIdToName(value),
          provider: 'claude' as const,
          // The raw cache value (including any [1m] suffix) is exactly what the
          // CLI's own model picker passes to --model.
          apiModelId: value,
          realModelId: value.replace(/\[1m\]$/i, ''),
          contextWindow: oneM ? 1_000_000 : 200_000,
          contextVerified: oneM,
          maxOutputTokens: 32_000,
          costPerMInputTokens: 0,
          costPerMOutputTokens: 0,
          canReason: true,
          supportsAttachments: true,
          supportsStreaming: true,
          tier: 'flagship' as const,
        };
      });
  } catch {
    return [];
  }
}

function refreshModelsInBackground(): void {
  if (refreshInProgress) return;
  refreshInProgress = true;

  const aliases = ClaudeCodeModels.map((m) => m.apiModelId!);

  Promise.all([Promise.all(aliases.map((alias) => probeAlias(alias))), detectEffortLevels()])
    .then(([results, effortLevels]) => {
      const base: ModelDef[] = ClaudeCodeModels.map((def, i) => {
        const realId = results[i];
        if (!realId) return def;
        // The probe confirmed which real Anthropic model the alias resolves to —
        // inherit that model's documented context window, output limit, and
        // reasoning capability instead of the wrapper's hardcoded guesses.
        const real = resolveModel(realId);
        const realTrusted = !!real && !real.isGeneric && real.provider === 'anthropic';
        return {
          ...def,
          realModelId: realId,
          name: realIdToName(realId),
          ...(realTrusted && real.contextWindow > 0
            ? { contextWindow: real.contextWindow, contextVerified: true }
            : {}),
          ...(realTrusted && real.maxOutputTokens > 0
            ? { maxOutputTokens: real.maxOutputTokens }
            : {}),
          ...(realTrusted && real.canReason !== undefined ? { canReason: real.canReason } : {}),
        };
      });
      // Server-driven extras from the CLI's own cache (skip any that duplicate a
      // model an alias already resolved to).
      const extras = readCliExtraModels().filter(
        (x) => !base.some((b) => b.realModelId === x.apiModelId),
      );
      // Per-model reasoning tiers from the catalog embedded in the CLI binary —
      // the CLI silently ACCEPTS --effort for models that don't support it
      // (e.g. Haiku 4.5), so the catalog's capability flags are the only
      // accurate source. [] = the picker shows no effort control.
      const catalog = getCliModelCatalog();
      const models: ModelDef[] = [...base, ...extras].map((m) => {
        const entry = catalogEntryFor(m.realModelId ?? m.apiModelId, catalog);
        if (entry) {
          const levels = capabilitiesToLevels(entry.capabilities).filter(
            (l) => !effortLevels || effortLevels.includes(l),
          );
          // Context window from the CLI's own catalog is live-verified truth.
          // [1m]-suffixed variants keep their 1M window from readCliExtraModels.
          const oneM = /\[1m\]$/i.test(m.apiModelId ?? '');
          const ctx =
            !oneM && entry.contextWindow && entry.contextWindow > 0
              ? { contextWindow: entry.contextWindow, contextVerified: true }
              : {};
          return { ...m, reasoningLevels: levels, ...ctx };
        }
        // No catalog (binary not readable): fall back to the CLI's global
        // --effort enum rather than nothing.
        return effortLevels?.length ? { ...m, reasoningLevels: effortLevels } : m;
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

// Hard-block the CLI's native delegation/orchestration tools. Sub-agents are
// Koryphaios's job (manager → workers → critic); if the CLI spawned its own
// Task/Agent sub-agents they'd bypass routing, the critic gate, and the UI.
// (--allowedTools only pre-approves — it does not block unlisted tools.)
const DISALLOWED_TOOLS = ['Task', 'Agent'].join(',');

// Appended to every system prompt so the model routes delegation through
// Koryphaios instead of trying its (blocked) native sub-agent tools.
const HARNESS_SYSTEM_NOTE =
  'You are running inside the Koryphaios orchestrator. Never spawn sub-agents or delegate ' +
  'with native Task/Agent tools (they are disabled); if work should be parallelized or ' +
  'delegated, say so in your response and Koryphaios will dispatch its own worker agents.';

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
    if (cachedModels && Date.now() - cachedModelsAt < MODELS_CACHE_TTL_MS) {
      return cachedModels;
    }
    refreshModelsInBackground();
    if (cachedModels) return cachedModels;
    // Static fallback until the first refresh lands — apply per-model levels
    // from the binary catalog if it's already been extracted (never the global
    // effort enum: it would show a picker for models like Haiku that have none).
    const fallback = getModelsForProvider('claude');
    if (!cachedCatalog) return fallback;
    return fallback.map((m) => {
      const entry = catalogEntryFor(m.realModelId ?? m.apiModelId, cachedCatalog);
      if (!entry) return m;
      const ctx =
        entry.contextWindow && entry.contextWindow > 0
          ? { contextWindow: entry.contextWindow, contextVerified: true }
          : {};
      return { ...m, reasoningLevels: capabilitiesToLevels(entry.capabilities), ...ctx };
    });
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
      '--disallowedTools',
      DISALLOWED_TOOLS,
    ];
    args.push(
      '--append-system-prompt',
      request.systemPrompt?.trim()
        ? `${request.systemPrompt}\n\n${HARNESS_SYSTEM_NOTE}`
        : HARNESS_SYSTEM_NOTE,
    );

    // Run in the project directory so the CLI edits the real files (falls back to cwd).
    const cwd = request.workingDirectory?.trim() || process.cwd();
    // Reasoning: prefer the CLI's native --effort flag, clamped to the levels
    // THIS model supports (from the binary catalog — the CLI silently accepts
    // --effort on models that ignore it, so acceptance can't be trusted). Fall
    // back to the MAX_THINKING_TOKENS env var for levels the flag can't express
    // ('none', numeric budgets) or for older CLIs without --effort.
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (request.reasoningLevel) {
      const cliLevels = await detectEffortLevels();
      const modelDef = this.listModels().find(
        (m) => m.id === request.model || m.apiModelId === request.model,
      );
      const allowed = Array.isArray(modelDef?.reasoningLevels)
        ? modelDef.reasoningLevels.filter((l) => !cliLevels || cliLevels.includes(l))
        : cliLevels;
      const effort = mapToEffort(request.reasoningLevel, allowed ?? null);
      if (effort) {
        args.push('--effort', effort);
      } else {
        const thinkingBudget = reasoningLevelToThinkingTokens(request.reasoningLevel);
        if (thinkingBudget !== null) env.MAX_THINKING_TOKENS = thinkingBudget;
      }
    }
    const child = spawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
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
            // Cached prompt tokens (read + written) still occupy the context
            // window — without them the context bar reads near-zero.
            tokensCache: (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
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
            tokensCache:
              (envelope.usage.cache_read_input_tokens ?? 0) +
              (envelope.usage.cache_creation_input_tokens ?? 0),
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
