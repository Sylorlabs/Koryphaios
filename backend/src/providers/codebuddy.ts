// CodeBuddy CLI subscription provider — runs Tencent's official `codebuddy` CLI.
//
// CodeBuddy Code is a Claude Code fork: the CLI owns its own auth (`codebuddy`
// interactive login in CodeBuddyExtension/Data/Public/auth, or CODEBUDDY_API_KEY), so this provider
// never holds the credential. It shells out to the locally installed, logged-in
// `codebuddy` CLI in headless print mode (`-p --output-format stream-json
// --verbose`) and translates the CLI's NDJSON event stream (identical envelope
// shapes to Claude Code: system/init, stream_event, assistant, user, result)
// into Koryphaios ProviderEvents. Koryphaios remains the single owner of tool
// execution and permissions.
//
// The installed CLI's real model catalog ships in product*.json at the package
// root (selected by CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT), so models, context
// windows, and vision/reasoning support are read from the CLI's own product
// files rather than guessed. Effort levels come from the CLI's `--effort` enum
// with the CLI's internal `ultracode` tier included.

import type { ProviderConfig, ModelDef } from '@koryphaios/shared';
import { spawn } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  realpathSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { whichBinary } from './cli-detection';
import { getCliBridge, getKoryphaiosCodeBuddyHome } from './cli-bridges';
import { koryBridgeUnavailableError, resolveKoryBridgeScript } from './kory-cli-mcp-config';
import type { Provider, ProviderEvent, ProviderMessage, StreamRequest, CliCommand } from './types';
import { wrapCommand, inferenceSandboxPolicy } from '../collaboration/sandbox-runner';
import { providerLog } from '../logger';
import { createKoryBridgeGrantLease } from './bridge-grant';
import { createCliAttachmentScope, type CliAttachmentScope } from './cli-attachments';
import {
  assertPrivateValuesAbsentFromArgv,
  createPrivateCliTextArtifact,
  spawnWithPrivateArtifactCleanup,
  writePrivatePromptToStdin,
} from './private-cli-transport';
import {
  appendPrivateDiagnostic,
  safeProviderDiagnostic,
  safeProviderFailureMessage,
} from './provider-diagnostics';
import { healManagedCliFile, writeManagedCliFile } from './managed-cli-storage';
import { appendBoundedProviderFrames } from './bounded-provider-stream';
import { prepareCodeBuddyCliEnvironment } from './codebuddy-environment';
import { productModelCreditLabel, productModelDisplayNames } from './product-model-names';
import {
  resolveProductContextBudget,
  supportedProductContextWindows,
  vendorDefaultContextWindow,
} from './product-context-window';

const CODEBUDDY_STREAM_TIMEOUT_MS = 300_000;
const MODELS_CACHE_TTL_MS = 5 * 60_000;

// ── Reasoning-effort discovery from the installed CLI ───────────────────────
// The CLI's own effort enum (including internal tiers like `ultracode`) is
// discoverable from the shipped JS bundle: fenced arrays such as
//   ["minimal","low","medium","high","xhigh","max","ultracode"]
// The public `--help` text lists the same values for external-facing tiers.
// Nothing here is hardcoded — a CLI update that renames or adds a tier is
// picked up the next time the cache key (pkg root + mtime) changes.

interface EffortDiscoveryResult {
  levels: string[];
  source: 'bundle' | 'help';
}

let cachedEffortEnum: string[] | null = null;
let cachedEffortKey = '';
let effortProbePromise: Promise<string[]> | null = null;

export function __resetCodeBuddyEffortCacheForTesting(): void {
  cachedEffortEnum = null;
  cachedEffortKey = '';
  effortProbePromise = null;
}

/** Locate the real codebuddy package root (the bundled CLI, not a shim). */
function codebuddyPackageRoot(): string | null {
  const bin = whichBinary('codebuddy');
  if (!bin) return null;
  try {
    const real = realpathSync(bin);
    return dirname(dirname(real));
  } catch {
    return null;
  }
}

/** Extract the CLI's effort enum by scanning its own bundle files. */
function discoverEffortEnumFromBundle(pkgRoot: string | null): string[] | null {
  if (!pkgRoot) return null;
  try {
    const stat = statSync(pkgRoot);
    const key = `${pkgRoot}:${stat.mtimeMs}`;
    if (cachedEffortEnum && cachedEffortKey === key) return cachedEffortEnum;
    if (!cachedEffortEnum) {
      const bundleDir = join(pkgRoot, 'dist');
      const files: string[] = [];
      try {
        for (const entry of readdirSync(bundleDir)) {
          if (/codebuddy.*\.m?js$/.test(entry)) files.push(join(bundleDir, entry));
        }
      } catch {
        /* no dist dir */
      }
      let best: string[] | null = null;
      for (const file of files) {
        try {
          const text = readFileSync(file, 'latin1');
          const matches = text.match(/\[\s*"minimal"\s*,\s*"low"[^\]]*\]/g) ?? [];
          for (const m of matches) {
            const levels = (m.match(/"([a-z0-9_-]+)"/g) ?? [])
              .map((q) => q.slice(1, -1))
              .filter(Boolean);
            // Pick the longest (most inclusive) enum — the CLI's full internal set.
            if (!best || levels.length > best.length) best = levels;
          }
        } catch (err: unknown) {
          providerLog.debug(
            { err: err instanceof Error ? err.message : String(err), file },
            'codebuddy: failed to scan bundle file for effort enum',
          );
        }
      }
      cachedEffortEnum = best;
      cachedEffortKey = key;
    }
    return cachedEffortEnum;
  } catch {
    return null;
  }
}

/** Fallback: parse the public `--effort <level>` help text of THIS CLI. */
function detectEffortLevelsFromHelp(): Promise<string[]> | null {
  if (effortProbePromise) return effortProbePromise;
  const bin = whichBinary('codebuddy');
  if (!bin) return null;
  effortProbePromise = new Promise((resolve) => {
    const child = spawn(bin, ['--help'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const m = out.match(/--effort <level>[\s\S]{0,200}?\(([a-z][a-z0-9_,\- ]+)\)/);
      const levels = m
        ? m[1]
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      resolve(levels.length > 0 ? levels : []);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.once('exit', finish);
    child.once('error', finish);
    setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* child already gone */
      }
      finish();
    }, 10_000);
  });
  return effortProbePromise;
}

/** The CLI's live effort enum; empty when unknown (picker shows nothing). */
export async function codeBuddyEffortLevels(): Promise<string[]> {
  const fromBundle = discoverEffortEnumFromBundle(codebuddyPackageRoot());
  if (fromBundle) return fromBundle;
  return (await detectEffortLevelsFromHelp()) ?? [];
}

/** The user's real configuration root; subscription auth is HOME-relative. */
export function codebuddyStateHome(): string {
  return process.env.CODEBUDDY_CONFIG_DIR?.trim() || join(homedir(), '.codebuddy');
}

/** Map a UI reasoning level to a MAX_THINKING_TOKENS budget (legacy fallback
 *  for codebuddy versions that ignore --effort). */
function reasoningLevelToThinkingTokens(level: string | undefined): string | null {
  if (!level) return null;
  const l = level.toLowerCase().trim();
  if (l === 'none' || l === 'off' || l === '0') return '0';
  if (l === 'minimal' || l === 'low') return '4096';
  if (l === 'medium' || l === 'on' || l === 'default') return '16384';
  if (l === 'high') return '32768';
  if (l === 'xhigh' || l === 'max' || l === 'ultracode') return '63999';
  if (/^\d+$/.test(l)) return l;
  return null;
}

// ── Model catalog from the installed CLI's product files ────────────────────

interface ProductModelEntry {
  id?: unknown;
  name?: unknown;
  /** Vendor's own price label (e.g. "x0.00 credits"). */
  credits?: unknown;
  /** Selectable context tiers reported by the CLI, separate from the hard
   *  `maxInputTokens` ceiling. */
  contextWindow?: {
    supportedLengths?: unknown;
    defaultLength?: unknown;
  } | null;
  maxInputTokens?: unknown;
  maxOutputTokens?: unknown;
  supportsToolCall?: unknown;
  supportsImages?: unknown;
  supportsReasoning?: unknown;
  onlyReasoning?: unknown;
  isDefault?: unknown;
  reasoning?: {
    effort?: unknown;
    summary?: unknown;
    supportedEfforts?: unknown;
    thinkingLevelMap?: unknown;
  };
}

interface ProductJson {
  models?: ProductModelEntry[];
}

/** The product env key selects which product*.json the CLI itself uses. */
function productFileNameForEnv(): string {
  const env = process.env.CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT?.trim();
  // The upstream international endpoint (www.codebuddy.ai) is currently banned
  // and its certificate no longer matches, so "external"/unset must not select
  // the international product file (and its unreachable endpoint). Default to
  // the reachable internal endpoint's catalog, exactly like running
  // `CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT=internal codebuddy`.
  if (!env || env === 'external') return 'product.internal.json';
  switch (env) {
    case 'internal':
      return 'product.internal.json';
    case 'selfhosted':
      return 'product.selfhosted.json';
    case 'ioa':
      return 'product.ioa.json';
    case 'cloudhosted':
      return 'product.cloudhosted.json';
    default:
      return 'product.json';
  }
}

function readProductJson(productFile: string): ProductJson | null {
  const bin = whichBinary('codebuddy');
  if (!bin) return null;
  try {
    const real = realpathSync(bin);
    const pkgRoot = dirname(dirname(real));
    for (const dir of [pkgRoot, dirname(real)]) {
      const path = join(dir, productFile);
      if (!existsSync(path)) continue;
      return JSON.parse(readFileSync(path, 'utf-8')) as ProductJson;
    }
  } catch (err: unknown) {
    providerLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'codebuddy: failed to read product model catalog',
    );
  }
  return null;
}

// Filters a raw effort-level list through the levels the installed CLI
// actually accepts (discovered from its bundle -- never hardcoded).
function filterValidCodeBuddyEfforts(levels: unknown[], valid: readonly string[]): string[] {
  const allowed = new Set(valid);
  return Array.isArray(levels)
    ? levels.filter((level): level is string => typeof level === 'string' && allowed.has(level))
    : [];
}

// Per-model reasoning levels, resolved like the CLI's own
// getSupportedThinkingLevels (module 56727 of codebuddy-headless.js):
//   - reasoning.supportedEfforts array when the catalog entry reports one, else
//   - reasoning.thinkingLevelMap: a level is supported when its map value is
//     present and non-null (xhigh/max only when explicitly defined), else
//   - the CLI default thinking set (minimal, low, medium, high); xhigh/max need
//     an explicit map entry. ultracode stays available because it is a real
//     --effort option accepted by the CLI (discovered from its bundle/help).
// Falls back to the CLI-wide discovered enum when the entry reports nothing.
// Never a hardcoded per-model list.
function reasoningLevelsForModel(
  entry: ProductModelEntry,
  fallback: string[],
): string[] | undefined {
  const reasoning = entry.reasoning;
  if (!reasoning || typeof reasoning !== 'object')
    return fallback.length > 0 ? [...fallback] : undefined;
  const levels = filterValidCodeBuddyEfforts(
    Array.isArray(reasoning.supportedEfforts) ? reasoning.supportedEfforts : [],
    fallback,
  );
  if (levels.length > 0) return levels;
  const map = reasoning.thinkingLevelMap;
  if (map && typeof map === 'object') {
    const thinkingMap = map as Record<string, unknown>;
    const derived = fallback.filter((level) => {
      const value = thinkingMap[level];
      return value !== null && value !== undefined;
    });
    if (derived.length > 0) return derived;
  }
  // CLI default when no per-model effort data is reported: xhigh/max excluded,
  // ultracode retained (it is a valid --effort value, not a thinking level).
  return fallback.length > 0
    ? fallback.filter((level) => level !== 'xhigh' && level !== 'max')
    : undefined;
}

export function modelsFromProductJson(raw: ProductJson | null, effortLevels: string[]): ModelDef[] {
  if (!raw || !Array.isArray(raw.models)) return [];
  const usable = raw.models
    .map((entry) => ({
      entry,
      id: typeof entry.id === 'string' ? entry.id.trim() : '',
      name: typeof entry.name === 'string' ? entry.name.trim() : '',
    }))
    .filter(({ id, name }) => !!id && !!name);
  // The installed CLI's product*.json files reuse display names for distinct
  // model ids (product.json ships two "Deepseek-V4.1-Flash" entries at
  // different credit prices; product.internal.json does the same for Hy3).
  // Disambiguate with the CLI's own data so the picker never offers two
  // visually identical rows.
  const displayNames = productModelDisplayNames(
    usable.map(({ id, name, entry }) => ({
      id,
      name,
      credits: typeof entry.credits === 'string' ? entry.credits : undefined,
    })),
  );
  const out: ModelDef[] = [];
  usable.forEach(({ entry, id }, index) => {
    const name = displayNames[index];
    const creditsLabel = productModelCreditLabel(
      typeof entry.credits === 'string' ? entry.credits : undefined,
    );
    const ctx =
      typeof entry.maxInputTokens === 'number' && entry.maxInputTokens > 0
        ? entry.maxInputTokens
        : 0;
    const contextOptions = supportedProductContextWindows(entry);
    const vendorDefault = vendorDefaultContextWindow(entry, contextOptions);
    const canReason = entry.supportsReasoning === true || entry.onlyReasoning === true;
    out.push({
      id: `codebuddy-${id}`,
      name: entry.isDefault === true ? `${name} (default)` : name,
      provider: 'codebuddy',
      apiModelId: id,
      contextWindow: ctx,
      contextVerified: ctx > 0,
      ...(contextOptions.length >= 2 ? { contextWindowOptions: contextOptions } : {}),
      ...(contextOptions.length >= 2 && vendorDefault !== undefined
        ? { contextWindowVendorDefault: vendorDefault }
        : {}),
      maxOutputTokens:
        typeof entry.maxOutputTokens === 'number' && entry.maxOutputTokens > 0
          ? entry.maxOutputTokens
          : 0,
      canReason,
      // Per-model reasoning levels from the CLI's own catalog data
      // (reasoning.supportedEfforts / reasoning.thinkingLevelMap), falling
      // back to the effort enum discovered from the installed CLI bundle.
      // Never a hardcoded per-model list.
      ...(canReason ? { reasoningLevels: reasoningLevelsForModel(entry, effortLevels) } : {}),
      ...(creditsLabel ? { creditsLabel } : {}),
      vision: entry.supportsImages === true,
      functionCall: entry.supportsToolCall === true,
      supportsAttachments: entry.supportsImages === true,
      supportsStreaming: true,
      tier: entry.isDefault === true ? ('flagship' as const) : ('fast' as const),
    });
  });
  return out;
}

// Known built-in codebuddy CLI commands (a Claude Code fork shares most of them).
const CODEBUDDY_BUILTIN_COMMANDS: Record<string, string> = {
  compact: 'Compress conversation history to save context window space',
  clear: 'Clear conversation history and start fresh',
  cost: 'Show token usage and cost for this session',
  help: 'Show available commands and usage help',
  init: 'Initialize codebuddy in this project',
  model: 'Switch AI model for this session',
  permissions: 'View or update tool permissions',
  status: 'Show current session status and configuration',
  login: 'Login to CodeBuddy',
  logout: 'Logout from CodeBuddy',
  resume: 'Resume a previous conversation session',
  mcp: 'Manage MCP server connections',
};

function buildCliCommands(names: string[]): CliCommand[] {
  return names.map((name) => ({
    name,
    description: CODEBUDDY_BUILTIN_COMMANDS[name],
    category: (name in CODEBUDDY_BUILTIN_COMMANDS ? 'builtin' : 'skill') as CliCommand['category'],
  }));
}

// Koryphaios owns ALL tool execution. Native host tools are hard-blocked via
// --disallowedTools (the same deny surface Claude Code exposes) and only the
// kory MCP server plus TodoWrite (planning aid, no side effects) are
// pre-approved. Native subagents and the native question tool stay hidden so
// delegation and questions route through Kory's control plane.
const DISALLOWED_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'Glob',
  'Grep',
  'LS',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'AskUserQuestion',
].join(',');
const ALLOWED_TOOLS = ['TodoWrite'].join(',');
const HARNESS_SYSTEM_NOTE =
  'You are running inside the Koryphaios orchestrator. Never spawn sub-agents or delegate ' +
  'with native Task/Agent tools (they are disabled); if work should be parallelized or ' +
  'delegated, say so in your response and Koryphaios will dispatch its own worker agents.';

/** CodeBuddy accepts file-backed system prompts through this flag. */
export function codeBuddySystemPromptArgs(systemPromptPath: string): string[] {
  return ['--system-prompt-file', systemPromptPath];
}

/**
 * Pass the kory MCP server explicitly, and keep every other MCP source out of
 * a Koryphaios turn. Verified against codebuddy 2.168.2: with these flags the
 * init frame reports the server as `connected` and its tools in the tool list.
 */
export function codeBuddyMcpArgs(configPath: string): string[] {
  return ['--mcp-config', configPath, '--strict-mcp-config'];
}

// ── Stream envelope types (identical shapes to claude-code.ts) ──────────────

interface BuddyStreamEnvelope {
  type: string;
  subtype?: string;
  slash_commands?: string[];
  event?: {
    type: string;
    delta?: { type?: string; text?: string; thinking?: string; estimated_tokens?: number };
    message?: { usage?: BuddyUsage };
  };
  message?: string | { content?: BuddyContentBlock[]; usage?: BuddyUsage };
  is_error?: boolean;
  result?: string;
  stop_reason?: string;
  usage?: BuddyUsage;
  error?: string | { message?: string };
  /** The CLI puts terminal failure details here on the `result` envelope. */
  errors?: Array<string | { message?: string; details?: string }>;
  errors_info?: Array<{ message?: string; details?: string; category?: string }>;
}

interface BuddyContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | Array<{ type?: string; text?: string }>;
}

interface BuddyUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// ── Provider ───────────────────────────────────────────────────────────────

// Module-level cache shared across all provider instances.
let cachedModels: ModelDef[] | null = null;
let cachedModelsAt = 0;
let refreshInProgress = false;
let refreshPromise: Promise<void> | null = null;

export function __resetCodeBuddyModelCacheForTesting(): void {
  cachedModels = null;
  cachedModelsAt = 0;
  refreshInProgress = false;
  refreshPromise = null;
}

function refreshModelsInBackground(): Promise<void> {
  if (refreshInProgress) return refreshPromise ?? Promise.resolve();
  refreshInProgress = true;
  refreshPromise = codeBuddyEffortLevels()
    .then((effortLevels) => {
      const models = modelsFromProductJson(readProductJson(productFileNameForEnv()), effortLevels);
      if (models.length > 0) {
        cachedModels = models;
        cachedModelsAt = Date.now();
      } else {
        // Negative cache: an unreadable product file must not be re-probed on
        // every status render.
        cachedModelsAt = Date.now();
        if (!cachedModels) cachedModels = [];
      }
    })
    .catch((err) => {
      cachedModelsAt = Date.now();
      providerLog.warn(
        safeProviderDiagnostic('codebuddy', 'stdout', err),
        'CodeBuddy model list refresh failed',
      );
    })
    .finally(() => {
      refreshInProgress = false;
      refreshPromise = null;
    });
  return refreshPromise;
}

export class CodeBuddyProvider implements Provider {
  readonly imageInputTransport = 'file' as const;
  readonly name = 'codebuddy' as const;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    if (this.config.disabled) return false;
    // Opt-in marker stored at connect time, a CODEBUDDY_API_KEY in the backend
    // env, or the CLI's own login state on this machine.
    const connected = !!this.config.authToken;
    const envKey = !!process.env.CODEBUDDY_API_KEY?.trim();
    const loggedIn = existsSync(codebuddyStateHome());
    const result = connected || envKey || loggedIn;
    if (result && Date.now() - cachedModelsAt > MODELS_CACHE_TTL_MS) {
      refreshModelsInBackground();
    }
    return result;
  }

  getCliCommands(): CliCommand[] {
    return Object.entries(CODEBUDDY_BUILTIN_COMMANDS).map(([name, description]) => ({
      name,
      description,
      category: 'builtin' as const,
    }));
  }

  listModels(): ModelDef[] {
    if (cachedModels && Date.now() - cachedModelsAt < MODELS_CACHE_TTL_MS) return cachedModels;
    refreshModelsInBackground();
    if (cachedModels && cachedModels.length > 0) return cachedModels;
    return [];
  }

  isModelCatalogAuthoritative(): boolean {
    return cachedModels != null;
  }

  refreshModels(forceRefresh = false): Promise<void> {
    if (!forceRefresh) return refreshModelsInBackground();
    // A refresh already in flight may have populated the cache before the
    // clear below runs. Clearing first and then joining that promise would
    // return an empty catalog that never gets refilled. Let the in-flight
    // refresh settle, then clear and read again so a forced refresh always
    // reflects the catalog currently on disk (same contract as the
    // WorkBuddy Desktop adapter).
    const pending = refreshInProgress ? (refreshPromise ?? Promise.resolve()) : null;
    return (pending ?? Promise.resolve()).then(() => {
      cachedModels = null;
      cachedModelsAt = 0;
      return refreshModelsInBackground();
    });
  }

  private resolveCliModel(modelId: string): string | undefined {
    const model = this.listModels().find((m) => m.id === modelId || m.apiModelId === modelId);
    if (model?.apiModelId) return model.apiModelId;
    return this.listModels()[0]?.apiModelId;
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const researchOnly = request.capabilityProfile === 'research-only';
    const bin = whichBinary('codebuddy');
    if (!bin) {
      yield {
        type: 'error',
        error:
          'CodeBuddy CLI not found on PATH. Install it and complete `codebuddy` login, then reconnect.',
      };
      return;
    }
    const cliModel = this.resolveCliModel(request.model);
    if (!cliModel) {
      yield { type: 'error', error: 'CodeBuddy did not report an available model.' };
      return;
    }
    const attachmentScope = createCliAttachmentScope();
    const prompt = buildPrompt(request.messages, attachmentScope);
    if (!prompt.trim()) {
      attachmentScope.cleanup();
      yield { type: 'error', error: 'CodeBuddy: empty prompt' };
      return;
    }

    let cliEnvironment: ReturnType<typeof prepareCodeBuddyCliEnvironment>;
    let codeBuddyHome: string;
    try {
      const baseHome = getKoryphaiosCodeBuddyHome();
      codeBuddyHome = researchOnly ? join(baseHome, 'research-only') : baseHome;
      cliEnvironment = prepareCodeBuddyCliEnvironment(codeBuddyHome, {
        filesystemIsolation: request.sandbox?.filesystemIsolation,
      });
    } catch (err) {
      attachmentScope.cleanup();
      providerLog.warn(
        safeProviderDiagnostic('codebuddy', 'configuration', err),
        'Could not prepare the private CodeBuddy CLI login',
      );
      yield {
        type: 'error',
        error: 'CodeBuddy could not safely stage its CLI-owned login in the managed home.',
      };
      return;
    }

    // The CLI's own `contextWindow` setting seeds the session's effective
    // context budget (its `seedContextWindow` calls setOverrideContextWindow).
    // Left to itself the CLI uses `contextWindow.defaultLength` (e.g. 300K on
    // a 1M model), which would disagree with the catalog Koryphaios shows.
    // Write the selected tier into the isolated HOME's settings.json so the
    // default is the maximum and the Settings selector really takes effect.
    const selectedModel = this.listModels().find(
      (m) => m.id === request.model || m.apiModelId === request.model,
    );
    const contextBudget = resolveProductContextBudget(
      this.config.contextWindow,
      selectedModel?.contextWindowOptions ?? [],
    );
    if (contextBudget !== undefined) {
      try {
        const settingsPath = join(codeBuddyHome, 'settings.json');
        if (existsSync(settingsPath)) healManagedCliFile(settingsPath);
        const existing = existsSync(settingsPath)
          ? (JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>)
          : {};
        existing.contextWindow = contextBudget;
        writeManagedCliFile(settingsPath, JSON.stringify(existing, null, 2));
      } catch (err) {
        providerLog.debug(
          safeProviderDiagnostic('codebuddy', 'configuration', err),
          'codebuddy: could not stage the selected context window',
        );
      }
    }

    const buddyBridge = getCliBridge('codebuddy');
    const bridgeGrantLease =
      !researchOnly && request.sessionId
        ? createKoryBridgeGrantLease(request.sessionId, request.harnessRole ?? 'manager')
        : undefined;
    const bridgeCtx = {
      provider: 'codebuddy' as const,
      role: request.harnessRole ?? 'manager',
      sandbox: request.sandbox,
      workingDirectory: request.workingDirectory?.trim() || process.cwd(),
      sessionId: request.sessionId,
      systemPrompt: request.systemPrompt ?? '',
      tools: request.tools ?? [],
      bridgeGrantLease,
    };
    const bridgeConfig = buddyBridge?.buildAgentConfig(bridgeCtx);
    const bridgeGrantDirectory =
      !researchOnly && bridgeCtx.sessionId
        ? bridgeGrantLease!.grant(['mcp:catalog', 'mcp:execute']).directory
        : null;

    const sandbox = request.sandbox;
    const disallowed = researchOnly
      ? ['Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Task', 'Agent']
      : DISALLOWED_TOOLS.split(',');
    // Headless `-p` cannot answer a permission prompt, so the kory MCP server
    // is pre-approved. Claude Code's tool allowlist form for a whole MCP
    // server is the bare `mcp__<server>` prefix.
    const allowedTools = researchOnly ? 'WebSearch,WebFetch' : `${ALLOWED_TOOLS},mcp__kory`;

    const researchRoot = researchOnly
      ? mkdtempSync(join(tmpdir(), 'kory-web-research-codebuddy-'))
      : null;
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model',
      cliModel,
      // Kory is the permission authority: bypass the CLI's approval layer
      // (CodeBuddy shares Claude Code's mode enum). --disallowedTools hides
      // native tools and --allowedTools pre-approves the kory set; a
      // residual prompt would hang a headless turn.
      '--permission-mode',
      'bypassPermissions',
      '--allowedTools',
      allowedTools,
      '--disallowedTools',
      disallowed.join(','),
    ];
    if (researchOnly && researchRoot) {
      const emptyMcp = join(researchRoot, 'mcp.json');
      writeFileSync(emptyMcp, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
      args.push('--strict-mcp-config', '--mcp-config', emptyMcp);
      args.push('--tools', 'WebSearch,WebFetch');
    }

    const { env, cleanup: softCleanup } = cliEnvironment;

    // Reasoning effort: pass --effort only when the level is in the CLI's enum.
    let appliedEffort: string | null = null;
    if (request.reasoningLevel) {
      const modelDef = this.listModels().find(
        (m) => m.id === request.model || m.apiModelId === request.model,
      );
      const level = request.reasoningLevel.toLowerCase().trim();
      const live = await codeBuddyEffortLevels();
      const allowed = modelDef?.reasoningLevels ?? live;
      if (modelDef?.canReason && allowed.length > 0 && allowed.includes(level)) {
        args.push('--effort', level);
        appliedEffort = level;
      } else if (live.length > 0 && live.includes(level)) {
        // Unknown model: still pass the level when the CLI's own enum accepts it.
        args.push('--effort', level);
        appliedEffort = level;
      } else {
        // Legacy fallback for CLI versions without --effort support.
        const thinkingBudget = reasoningLevelToThinkingTokens(level);
        if (thinkingBudget !== null) env.MAX_THINKING_TOKENS = thinkingBudget;
      }
    }

    const effortNote = appliedEffort
      ? ` Your reasoning effort for this request is set to "${appliedEffort}".`
      : '';
    const systemPrompt = request.systemPrompt?.trim()
      ? `${request.systemPrompt}\n\n${bridgeConfig?.systemInstructions?.[0] ?? HARNESS_SYSTEM_NOTE}${effortNote}`
      : `${bridgeConfig?.systemInstructions?.[0] ?? HARNESS_SYSTEM_NOTE}${effortNote}`;
    const systemPromptArtifact = createPrivateCliTextArtifact(
      'codebuddy-system-prompt',
      systemPrompt,
    );
    args.push(...codeBuddySystemPromptArgs(systemPromptArtifact.path));

    // The kory MCP server is passed per turn rather than written into the
    // managed home. CodeBuddy is a Claude Code fork whose user-scope MCP file
    // is `$HOME/.codebuddy/.mcp.json` (verified with `codebuddy mcp add
    // --scope user`), not `$HOME/.codebuddy/.codebuddy.json` as this adapter
    // used to write — which is why kory__ tools were never discovered.
    // `--mcp-config` is explicit, and `--strict-mcp-config` keeps the user's
    // other MCP servers out of a Koryphaios turn: Kory owns the tool surface.
    let mcpArtifact: ReturnType<typeof createPrivateCliTextArtifact> | undefined;
    if (!researchOnly) {
      const mcpConfigs = buddyBridge?.buildMcpConfig(bridgeCtx);
      if (
        bridgeCtx.sessionId &&
        (!mcpConfigs || mcpConfigs.length === 0) &&
        !resolveKoryBridgeScript()
      ) {
        yield { type: 'error', error: koryBridgeUnavailableError('codebuddy') };
        return;
      }
      if (mcpConfigs && mcpConfigs.length > 0) {
        try {
          const servers: Record<string, unknown> = {};
          for (const srv of mcpConfigs) {
            servers[srv.name] = {
              command: srv.command,
              args: srv.args,
              env: srv.env,
              type: 'stdio',
            };
          }
          mcpArtifact = createPrivateCliTextArtifact(
            'codebuddy-mcp',
            JSON.stringify({ mcpServers: servers, disabledMcpServers: [] }, null, 2),
          );
          args.push(...codeBuddyMcpArgs(mcpArtifact.path));
        } catch (mcpErr) {
          providerLog.warn(
            safeProviderDiagnostic('codebuddy', 'configuration', mcpErr),
            'Failed to write kory MCP config for CodeBuddy',
          );
        }
      }
    }

    // The environment helper preserves the CLI's auth HOME across the soft jail.
    const cwd = researchRoot ?? (request.workingDirectory?.trim() || process.cwd());
    const { command: spawnBin, args: spawnArgs } = sandbox
      ? wrapCommand(bin, args, {
          cwd,
          homeDir: env.HOME,
          configDirs: [
            ...cliEnvironment.configDirs,
            ...(bridgeGrantDirectory ? [bridgeGrantDirectory] : []),
            systemPromptArtifact.directory,
            ...(mcpArtifact ? [mcpArtifact.directory] : []),
            ...attachmentScope.artifacts.map((a) => a.directory),
          ],
          readonlyConfigDirs: cliEnvironment.readonlyConfigDirs,
          policy: inferenceSandboxPolicy(sandbox),
        })
      : { command: bin, args };

    assertPrivateValuesAbsentFromArgv(spawnArgs, [prompt, systemPrompt, request.systemPrompt]);
    const child = spawnWithPrivateArtifactCleanup(
      () => spawn(spawnBin, spawnArgs, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env }),
      [systemPromptArtifact, ...(mcpArtifact ? [mcpArtifact] : []), ...attachmentScope.artifacts],
      () => bridgeGrantLease?.cleanup(),
    );
    bridgeGrantLease?.bindToChild(child);

    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch (err: unknown) {
        providerLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'codebuddy: harness child already gone on abort',
        );
      }
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const runtimeMs =
      sandbox && sandbox.maxRuntimeSeconds > 0
        ? sandbox.maxRuntimeSeconds * 1000
        : CODEBUDDY_STREAM_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      providerLog.warn({ provider: 'codebuddy' }, 'CodeBuddy harness timed out — killing CLI');
      onAbort();
    }, runtimeMs);
    timeout.unref?.();
    child.once('close', () => {
      softCleanup?.();
      if (researchRoot) rmSync(researchRoot, { recursive: true, force: true });
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendPrivateDiagnostic(stderr, chunk);
    });
    try {
      writePrivatePromptToStdin(child, prompt);
    } catch (err) {
      providerLog.error(
        safeProviderDiagnostic('codebuddy', 'spawn', err),
        'Failed to write prompt to CodeBuddy stdin',
      );
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let emittedComplete = false;
    const pendingTools = new Map<string, { name: string; input: Record<string, unknown> }>();
    let streamErrored = false;
    const streamState = { sawTextDelta: false };

    try {
      for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
        const bounded = appendBoundedProviderFrames(
          buffer,
          decoder.decode(chunk, { stream: true }),
        );
        buffer = bounded.remainder;
        for (const line of bounded.frames) {
          const raw = line.trim();
          if (!raw) continue;
          let envelope: BuddyStreamEnvelope;
          try {
            envelope = JSON.parse(raw) as BuddyStreamEnvelope;
          } catch {
            providerLog.debug(
              safeProviderDiagnostic('codebuddy', 'stdout', raw),
              'codebuddy: skipping non-JSON stream line',
            );
            continue;
          }
          for (const event of mapEnvelope(envelope, pendingTools, streamState)) {
            if (event.type === 'complete') emittedComplete = true;
            if (event.type === 'error') streamErrored = true;
            yield event;
          }
        }
      }
    } catch (err: unknown) {
      if (!(err instanceof Error && err.name === 'AbortError')) {
        onAbort();
        const diagnostic = safeProviderDiagnostic('codebuddy', 'stream', err);
        providerLog.error(diagnostic, 'CodeBuddy harness stream failed');
        yield { type: 'error', error: safeProviderFailureMessage('codebuddy', diagnostic) };
      }
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', onAbort);
      softCleanup?.();
      if (researchRoot) rmSync(researchRoot, { recursive: true, force: true });
      return;
    }

    const exitCode: number = await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(child.exitCode);
      child.once('exit', (code) => resolve(code ?? 0));
    });
    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', onAbort);
    softCleanup?.();
    if (researchRoot) rmSync(researchRoot, { recursive: true, force: true });
    if (request.signal?.aborted) return;

    // A result.is_error can arrive after assistant text with process exit 0.
    // Never synthesize successful completion after that terminal error.
    if (streamErrored) return;
    if (exitCode !== 0) {
      const diagnostic = safeProviderDiagnostic('codebuddy', 'stderr', stderr, { exitCode });
      providerLog.warn(diagnostic, 'CodeBuddy CLI exited unsuccessfully');
      yield {
        type: 'error',
        error: safeProviderFailureMessage('codebuddy', diagnostic, {
          authenticationAction: 'Check the interactive `codebuddy` login, then reconnect.',
        }),
      };
      return;
    }
    if (!emittedComplete) {
      yield { type: 'error', error: 'CodeBuddy CLI ended without a successful result.' };
    }
  }
}

function* mapEnvelope(
  envelope: BuddyStreamEnvelope,
  pendingTools: Map<string, { name: string; input: Record<string, unknown> }>,
  streamState: { sawTextDelta: boolean },
): Generator<ProviderEvent> {
  switch (envelope.type) {
    case 'stream_event': {
      const event = envelope.event;
      if (!event) return;
      if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta?.type === 'text_delta' && delta.text) {
          streamState.sawTextDelta = true;
          yield { type: 'content_delta', content: delta.text };
        } else if (delta?.type === 'thinking_delta') {
          const est = delta.estimated_tokens;
          if (delta.thinking || typeof est === 'number') {
            yield {
              type: 'thinking_delta',
              thinking: delta.thinking ?? '',
              ...(typeof est === 'number' ? { thinkingTokens: est } : {}),
            };
          }
        }
      } else if (event.type === 'message_start' && event.message?.usage) {
        const u = event.message.usage;
        yield {
          type: 'usage_update',
          tokensIn: u.input_tokens,
          tokensOut: u.output_tokens,
          tokensCache: (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          tokensCacheRead: u.cache_read_input_tokens,
          tokensCacheWrite: u.cache_creation_input_tokens,
        };
      }
      return;
    }
    case 'assistant': {
      const msg = envelope.message;
      if (!msg || typeof msg === 'string' || !Array.isArray(msg.content)) return;
      // Without --include-partial-messages the final text arrives only here;
      // with it, the text was already streamed via content_delta.
      if (!streamState.sawTextDelta) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            yield { type: 'content_delta', content: block.text };
          }
        }
      }
      for (const block of msg.content) {
        if (block.type !== 'tool_use' || !block.name) continue;
        const input = (block.input ?? {}) as Record<string, unknown>;
        yield* mapToolUse(block.id ?? '', block.name, input, pendingTools);
      }
      return;
    }
    case 'user': {
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
    case 'result': {
      if (envelope.usage) {
        yield {
          type: 'usage_update',
          tokensIn: envelope.usage.input_tokens,
          tokensOut: envelope.usage.output_tokens,
          tokensCache:
            (envelope.usage.cache_read_input_tokens ?? 0) +
            (envelope.usage.cache_creation_input_tokens ?? 0),
          tokensCacheRead: envelope.usage.cache_read_input_tokens,
          tokensCacheWrite: envelope.usage.cache_creation_input_tokens,
        };
      }
      if (envelope.is_error) {
        yield { type: 'error', error: extractError(envelope) };
        return;
      }
      yield {
        type: 'complete',
        finishReason: envelope.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn',
      };
      return;
    }
    case 'error': {
      yield { type: 'error', error: extractError(envelope) };
      return;
    }
    case 'system': {
      if (envelope.subtype === 'init' && Array.isArray(envelope.slash_commands)) {
        yield {
          type: 'cli_commands',
          cliCommands: buildCliCommands(envelope.slash_commands),
        };
      }
      return;
    }
    default:
      return;
  }
}

function* mapToolUse(
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
  if (id) pendingTools.set(id, { name, input });
}

function flattenToolResult(
  content: string | Array<{ type?: string; text?: string }> | undefined,
): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c?.text ?? '').join('');
  return '';
}

/** A CLI auth failure is actionable: the login is CLI-owned, so say what to
 *  run instead of leaving the user with an opaque failure. */
function actionableCodeBuddyError(text: string): string {
  if (/authentication required|please use \/login|sign in to your account/i.test(text)) {
    return (
      `${text} Refresh the CLI login with ` +
      '`CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT=internal codebuddy /login`, ' +
      'then reconnect the CodeBuddy provider.'
    );
  }
  return text;
}

/**
 * Terminal `result` envelopes report the real failure in `errors` /
 * `errors_info`, not in `error` (that field belongs to the `error` envelope
 * type). Reading only `error` collapses every gateway, quota and login
 * failure into "CodeBuddy request failed", which hides the one detail the
 * user needs. Surface the vendor's own diagnostic verbatim.
 */
function extractError(envelope: BuddyStreamEnvelope): string {
  const candidates: unknown[] = [
    envelope.error,
    ...(envelope.errors ?? []),
    ...(envelope.errors_info ?? []),
    envelope.message,
    envelope.is_error ? envelope.result : undefined,
  ];
  for (const candidate of candidates) {
    const text =
      typeof candidate === 'string'
        ? candidate
        : candidate && typeof candidate === 'object'
          ? ((candidate as { details?: unknown }).details ??
            (candidate as { message?: unknown }).message)
          : undefined;
    if (typeof text === 'string' && text.trim()) return actionableCodeBuddyError(text);
  }
  return 'CodeBuddy request failed';
}

/** Serialize the conversation into a single prompt for the CLI's print mode. */
function buildPrompt(messages: ProviderMessage[], attachments: CliAttachmentScope): string {
  const turns = messages.filter((m) => m.role !== 'system');
  if (turns.length === 1 && turns[0].role === 'user') {
    return attachments.renderContent(turns[0].content);
  }
  const lines: string[] = [];
  for (const m of turns) {
    const text = attachments.renderContent(m.content);
    if (!text.trim()) continue;
    const label = m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool result' : 'User';
    lines.push(`${label}: ${text}`);
  }
  return lines.join('\n\n');
}
