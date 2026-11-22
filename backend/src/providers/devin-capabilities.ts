// Devin CLI capability discovery.
//
// Probes the installed `devin` binary once per path+mtime and caches which
// extensibility levers THIS CLI version exposes: --agent-config, --sandbox,
// --export, --permission-mode, the rules/skills directories, and the live
// account model list. Every deeper integration (agent-config builder, hooks
// bridge, MCP bridge, ACP) gates on these flags so an older Devin keeps
// working via the legacy stdout+export path.
//
// Side-effect-free: detection only. The provider spawns the CLI for real runs.

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { whichBinary } from './cli-detection';
import { providerLog } from '../logger';
import { getSafeSubprocessEnv } from '../runtime/safe-env';
import { resolveSpeedVariant, SPEED_TIER_FAST_DEVIN } from './speed-tiers';
import {
  splitFusionSlug,
  fusionPairingKey,
  type FusionCatalog,
  type FusionPairingMeta,
  type FusionSelection,
  type FusionSlotOption,
} from '@koryphaios/shared';

export interface DevinModelEntry {
  id: string;
  name: string;
  contextWindow?: number;
  costPerMInputTokens?: number;
  costPerMOutputTokens?: number;
  costPerMInputCached?: number;
}

export interface DevinCapabilities {
  /** Binary path the probe ran against. */
  binaryPath: string;
  /** `stat().mtimeMs` of the probed binary — cache key. */
  binaryMtimeMs: number;
  /** CLI version string (from `devin version`). */
  version: string | null;
  /** Supports `--agent-config <file>` (declarative per-turn config). */
  supportsAgentConfig: boolean;
  /** Supports `--sandbox` (OS-level process sandbox). */
  supportsSandbox: boolean;
  /** Supports `--export [path]` (ATIF trajectory). */
  supportsExport: boolean;
  /** Supports `--permission-mode <mode>`. */
  supportsPermissionMode: boolean;
  /** Supports `devin acp` (Agent Client Protocol over stdio). */
  supportsAcp: boolean;
  /** Supports `devin mcp` (MCP server management). */
  supportsMcp: boolean;
  /** Supports `devin rules` (always-on rules). */
  supportsRules: boolean;
  /** Supports `devin skills` (agent-invocable skills). */
  supportsSkills: boolean;
  /** Supports `.devin/hooks.v1.json` (lifecycle hooks). */
  supportsHooks: boolean;
  /** Rules directory the CLI reads (project + user). */
  rulesDirs: string[];
  /** Skills directory the CLI reads. */
  skillsDirs: string[];
  /** Live account-available models from `devin models`. Empty if unavailable. */
  models: DevinModelEntry[];
  /** Probed at (ms). */
  probedAt: number;
}

let cached: DevinCapabilities | null = null;
let cacheKey = '';
let probeInFlight: Promise<DevinCapabilities> | null = null;

const PROBE_TIMEOUT_MS = 12_000;
const MODELS_TIMEOUT_MS = 15_000;

function runCli(
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const bin = whichBinary('devin');
    if (!bin) {
      resolve({ stdout: '', stderr: 'devin not on PATH', code: -1 });
      return;
    }
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: getSafeSubprocessEnv(),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    };
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.once('error', () => finish(-1));
    child.once('exit', (code) => finish(code ?? 0));
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch (err: unknown) {
        providerLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Devin capability probe child already gone on timeout',
        );
      }
      finish(-1);
    }, timeoutMs);
    timer.unref?.();
  });
}

/** Parse `devin --help` for the flags this version supports. */
function parseHelpFlags(help: string): {
  supportsAgentConfig: boolean;
  supportsSandbox: boolean;
  supportsExport: boolean;
  supportsPermissionMode: boolean;
} {
  return {
    supportsAgentConfig: /--agent-config <FILE>/.test(help),
    supportsSandbox: /--sandbox\b/.test(help),
    supportsExport: /--export\b/.test(help),
    supportsPermissionMode: /--permission-mode <PERMISSION_MODE>/.test(help),
  };
}

/** Parse `devin` top-level help for the subcommands it exposes. */
function parseSubcommands(help: string): {
  supportsAcp: boolean;
  supportsMcp: boolean;
  supportsRules: boolean;
  supportsSkills: boolean;
  supportsHooks: boolean;
} {
  // Subcommands are listed in the Commands: block of the top-level help.
  return {
    supportsAcp: /^acp\b/m.test(help) || /\bacp\s+Run as an ACP/.test(help),
    supportsMcp:
      /^mcp\b/m.test(help) || /\bmcp\s+Connect and log in to Model Context Protocol/.test(help),
    supportsRules: /^rules\b/m.test(help) || /\brules\s+Manage agent rules/.test(help),
    supportsSkills: /^skills\b/m.test(help) || /\bskills\s+Manage agent skills/.test(help),
    // Hooks are detected via the --help flags list or the hooks.v1.json mention.
    supportsHooks:
      /--hooks\b/i.test(help) ||
      /hooks\.v1\.json/i.test(help) ||
      /PreToolUse|PostToolUse/i.test(help),
  };
}

/** Parse `devin rules paths` / `devin skills paths` output for the dirs. */
function parsePathsOutput(output: string): string[] {
  const dirs: string[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Lines are absolute paths (possibly labelled). Accept anything that
    // looks like a path and exists, expanding ~.
    const expanded = trimmed.replace(/^~(?=$|\/|\\)/, homedir());
    if (/^\//.test(expanded) || /^[A-Za-z]:[\\/]/.test(expanded)) {
      dirs.push(expanded);
    }
  }
  return dirs;
}

/** Parse `devin models` output into model entries. The CLI prints a
 *  human-readable list; we extract id + display name heuristically. */
function parseModelsOutput(output: string): DevinModelEntry[] {
  const models: DevinModelEntry[] = [];
  const seen = new Set<string>();
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // Common forms: "  swe-1.6-slow   SWE-1.6 Slow" or "  • opus (Claude Opus …)".
    // Pull the first token as the id and the rest as the name.
    const m = line.match(/^[-*•]?\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(.*)$/);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id) || id.length > 80) continue;
    seen.add(id);
    models.push({ id, name: (m[2] || id).trim() });
  }
  return models;
}

async function probeCapabilities(): Promise<DevinCapabilities> {
  const bin = whichBinary('devin');
  const empty: DevinCapabilities = {
    binaryPath: bin ?? '',
    binaryMtimeMs: 0,
    version: null,
    supportsAgentConfig: false,
    supportsSandbox: false,
    supportsExport: false,
    supportsPermissionMode: false,
    supportsAcp: false,
    supportsMcp: false,
    supportsRules: false,
    supportsSkills: false,
    supportsHooks: false,
    rulesDirs: [],
    skillsDirs: [],
    models: [],
    probedAt: Date.now(),
  };
  if (!bin) return empty;

  let stat: { mtimeMs: number };
  try {
    stat = statSync(bin);
  } catch (err: unknown) {
    providerLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Devin capability probe binary stat failed',
    );
    return { ...empty, binaryPath: bin };
  }

  const [helpResult, versionResult] = await Promise.all([
    runCli(['--help'], PROBE_TIMEOUT_MS),
    runCli(['version'], PROBE_TIMEOUT_MS),
  ]);
  const help = helpResult.stdout;
  const flags = parseHelpFlags(help);
  const subs = parseSubcommands(help);
  const version = versionResult.stdout.trim() || null;

  // Rules/skills dirs + models are best-effort; never let a failure here block
  // the provider. Run them in parallel.
  const [rulesResult, skillsResult, modelsResult] = await Promise.all([
    subs.supportsRules
      ? runCli(['rules', 'paths'], PROBE_TIMEOUT_MS)
      : Promise.resolve({ stdout: '', stderr: '', code: -1 }),
    subs.supportsSkills
      ? runCli(['skills', 'paths'], PROBE_TIMEOUT_MS)
      : Promise.resolve({ stdout: '', stderr: '', code: -1 }),
    runCli(['models', 'list'], MODELS_TIMEOUT_MS),
  ]);

  const caps: DevinCapabilities = {
    binaryPath: bin,
    binaryMtimeMs: stat.mtimeMs,
    version,
    ...flags,
    ...subs,
    supportsHooks: true,
    rulesDirs: parsePathsOutput(rulesResult.stdout),
    skillsDirs: parsePathsOutput(skillsResult.stdout),
    models: parseDevinModelsOutput(modelsResult.stdout),
    probedAt: Date.now(),
  };
  providerLog.info(
    {
      provider: 'devin',
      version: caps.version,
      agentConfig: caps.supportsAgentConfig,
      sandbox: caps.supportsSandbox,
      acp: caps.supportsAcp,
      mcp: caps.supportsMcp,
      models: caps.models.length,
    },
    'Devin CLI capabilities probed',
  );
  return caps;
}

/** Get the cached capabilities, probing the CLI if needed. The probe is
 *  keyed on the binary path + mtime so a CLI update re-probes. */
export function getDevinCapabilities(): DevinCapabilities {
  const bin = whichBinary('devin');
  if (!bin) {
    cached = null;
    cacheKey = '';
    return {
      binaryPath: '',
      binaryMtimeMs: 0,
      version: null,
      supportsAgentConfig: false,
      supportsSandbox: false,
      supportsExport: false,
      supportsPermissionMode: false,
      supportsAcp: false,
      supportsMcp: false,
      supportsRules: false,
      supportsSkills: false,
      supportsHooks: false,
      rulesDirs: [],
      skillsDirs: [],
      models: [],
      probedAt: 0,
    };
  }
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(bin).mtimeMs;
  } catch (err: unknown) {
    /* unreadable — fall through with stale cache */
    providerLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Devin capability probe binary stat unreadable — using stale cache',
    );
  }
  const key = `${bin}:${mtimeMs}`;
  if (cached && cacheKey === key) return cached;
  if (!probeInFlight) {
    probeInFlight = probeCapabilities()
      .then((caps) => {
        cached = caps;
        cacheKey = key;
        return caps;
      })
      .finally(() => {
        probeInFlight = null;
      });
  }
  // Return a synchronous best-effort snapshot while the probe runs in the
  // background. The provider re-checks via getDevinCapabilitiesSync after the
  // probe settles; callers that can await should use getDevinCapabilitiesAsync.
  if (cached && cacheKey.startsWith(`${bin}:`)) return cached;
  return {
    binaryPath: bin,
    binaryMtimeMs: mtimeMs,
    version: null,
    supportsAgentConfig: false,
    supportsSandbox: false,
    supportsExport: false,
    supportsPermissionMode: false,
    supportsAcp: false,
    supportsMcp: false,
    supportsRules: false,
    supportsSkills: false,
    supportsHooks: false,
    rulesDirs: [],
    skillsDirs: [],
    models: [],
    probedAt: 0,
  };
}

/** Async variant — awaits the in-flight probe so callers get the real picture. */
export async function getDevinCapabilitiesAsync(): Promise<DevinCapabilities> {
  getDevinCapabilities(); // kick off the probe if not running
  if (probeInFlight) return probeInFlight;
  return cached ?? getDevinCapabilities();
}

/** Drop the cache (e.g. after a forced refresh). */
export function invalidateDevinCapabilities(): void {
  cached = null;
  cacheKey = '';
  probeInFlight = null;
}

/** Default rules/skills dirs when the CLI doesn't report them. */
export function defaultDevinRulesDirs(projectRoot?: string): string[] {
  const dirs: string[] = [];
  if (projectRoot) dirs.push(join(projectRoot, 'AGENTS.md'));
  dirs.push(join(homedir(), '.config', 'devin', 'AGENTS.md'));
  return dirs.filter((p) => (p.endsWith('.md') ? existsSync(p) : existsSync(p)));
}

/**
 * Parse `devin models list` output into structured model entries.
 *
 * The CLI prints model families as headings (e.g. "Claude Opus 5 (claude-opus-5)")
 * followed by indented rows with an id, display name, and optional context/price
 * metadata. Alias lines ("  aliases: opus") and help text are excluded. A
 * trailing `[...]` metadata bracket (prices such as `[$4 / 1M Input · ...]`)
 * is stripped so the entry keeps just the model name — pricing stays in
 * billing, never in the name.
 */
export function parseDevinModelsOutput(output: string): DevinModelEntry[] {
  const lines = output.split('\n');
  const models: DevinModelEntry[] = [];

  // Help text (not a catalog) starts with "List the models" or "Usage:".
  if (/^Usage:|^\s*Commands:/m.test(output) || /^List the models/m.test(output)) {
    return [];
  }

  for (const line of lines) {
    // Alias declarations are not selectable models, regardless of spacing.
    if (/^aliases\s*:/i.test(line.trim())) continue;
    // Model rows are indented and contain an id followed by a display name.
    // Format: "  <id>  <Display Name>  [Nk context, ...]" or with a trailing
    // price bracket: "  <id>  <Display Name>  [$X / 1M Input · ...]".
    const match = line.match(
      /^\s{2,}(\S+)\s{2,}(.+?)(?:\s*\[(\d+(?:[._]\d+)*)\s*([KkMm]?)\s*context([^\]]*)\])?\s*$/,
    );
    if (match) {
      const id = match[1];
      // Strip any leftover trailing metadata bracket (e.g. per-1M prices) so
      // the entry keeps just the model name.
      const name =
        match[2]
          .trim()
          .replace(/\s*\[[^\]]*\]\s*$/, '')
          .trim() || id;
      let contextWindow: number | undefined;
      if (match[3]) {
        // The size token can be decimal (`1.05M`); stripping the dot would
        // read it as 105M — a 100x wrong context window.
        const num = parseFloat(match[3].replace(/_/g, ''));
        const suffix = match[4]?.toUpperCase();
        if (Number.isFinite(num)) {
          if (suffix === 'M') contextWindow = Math.round(num * 1_000_000);
          else if (suffix === 'K') contextWindow = Math.round(num * 1_000);
          else contextWindow = Math.round(num);
        }
      }
      const bracketTail = match[5] ?? '';
      const priceOf = (label: RegExp): number | undefined => {
        const pm = bracketTail.match(label);
        const v = pm ? Number(pm[1]) : NaN;
        return Number.isFinite(v) ? v : undefined;
      };
      models.push({
        id,
        name,
        contextWindow,
        costPerMInputTokens: priceOf(/\$(\d+(?:\.\d+)?)\s*\/\s*1M\s*Input/i),
        costPerMInputCached: priceOf(/\$(\d+(?:\.\d+)?)\s*\/\s*1M\s*Cached\s*input/i),
        costPerMOutputTokens: priceOf(/\$(\d+(?:\.\d+)?)\s*\/\s*1M\s*Output/i),
      });
    }
  }

  return models;
}

// ─── Reasoning-effort families ───────────────────────────────────────────────
// Devin has no reasoning parameter: effort is baked into the model slug
// (`claude-opus-5-5-high`), with speed (`-fast`, `-priority`, `-lightning`)
// and context (`-1m`, `-262k`) variants trailing it, and Fusion pairings
// carrying the lead effort medially (`fusion-<lead>-<effort>-sidekick-<x>`).
// `devin models` therefore returns one row per effort, and the picker would
// offer a raw model choice where a reasoning control belongs. Koryphaios
// collapses each family into ONE base model with real `reasoningLevels` plus a
// `reasoningVariants` map back onto the Devin slug, so effort stays a native
// Koryphaios control exactly as it is for providers that take a reasoning
// parameter (same contract as collapseAgyReasoningTiers for Antigravity).

import type { ModelDef } from '@koryphaios/shared';

/** Effort tokens ordered from least to most thinking. `fast`/`slow` appear as
 *  bare tiers on some families (swe-1-6-fast / swe-1-6-slow) — as a trailing
 *  token after an effort they are speed modifiers, handled separately below. */
const DEVIN_EFFORT_ORDER = [
  'none',
  'minimal',
  'low',
  'fast',
  'medium',
  'high',
  'xhigh',
  'ultra',
  'max',
  'slow',
] as const;

type DevinEffort = (typeof DEVIN_EFFORT_ORDER)[number];

export interface DevinSlugParts {
  /** Family key the slug belongs to (base + speed/context variant suffix). */
  family: string;
  /** Base slug without effort/speed/context suffixes. */
  base: string;
  effort: DevinEffort | null;
  /** Speed-class token (`fast`/`priority`/`lightning`), if present. */
  speed: string | null;
  /** Context-size suffix (`1m`/`400k`), if present. */
  context: string | null;
  /** Fusion sidekick tail including the `-sidekick-` separator, if present. */
  sidekick: string | null;
}

// Slugs use `-` separators, with occasional `_`/uppercase rows (the CLI's own
// catalog has `MODEL_GPT_5_2_LOW`-style ids), so every tail token accepts both
// separators and case-insensitive matching. The tail grammar is
// `[effort] [speed] [context]` — a speed token only counts when an effort
// precedes it, so a bare `foo-fast` reads `fast` as the effort (swe-1-6
// fast/slow tiers) and `foo-priority` alone is not a tier at all.
const DEVIN_EFFORT_TAIL =
  /^(.*?)[-_](none|minimal|low|medium|high|xhigh|ultra|max|fast|slow)(?:[-_](fast|priority|lightning))?(?:[-_](\d+(?:\.\d+)?[km]))?$/i;
const DEVIN_CONTEXT_TAIL = /[-_](\d+(?:\.\d+)?[km])$/i;

/** Split a Devin model slug into family base + effort/speed/context variant
 *  tokens. Untiered slugs return effort: null. Fusion slugs only match the
 *  effort sitting in the lead position (before `-sidekick-`); the sidekick
 *  tail is opaque family identity. */
export function splitDevinModelSlug(slug: string): DevinSlugParts {
  // Fusion: `fusion-<lead>-<effort>[-<speed>]-sidekick-<sidekick>`.
  const sidekickAt = slug.indexOf('-sidekick-');
  if (slug.startsWith('fusion-') && sidekickAt > 0) {
    const lead = slug.slice(0, sidekickAt);
    const sidekick = slug.slice(sidekickAt);
    const m = lead.match(DEVIN_EFFORT_TAIL);
    if (m) {
      const base = m[1];
      const effort = m[2].toLowerCase() as DevinEffort;
      const speed = m[3]?.toLowerCase() ?? null;
      const context = m[4]?.toLowerCase() ?? null;
      const family = `${base}${speed ? `-${speed}` : ''}${context ? `-${context}` : ''}${sidekick}`;
      return { family, base, effort, speed, context, sidekick };
    }
    return { family: slug, base: slug, effort: null, speed: null, context: null, sidekick };
  }

  // A bare context suffix (`glm-5-2-1m`) still joins its ctx family as the
  // untiered member, so strip it before looking for effort+speed.
  const ctxM = slug.match(DEVIN_CONTEXT_TAIL);
  const context = ctxM ? ctxM[1].toLowerCase() : null;
  const rest = ctxM ? slug.slice(0, ctxM.index) : slug;
  const m = rest.match(DEVIN_EFFORT_TAIL);
  if (m) {
    const base = m[1];
    const effort = m[2].toLowerCase() as DevinEffort;
    const speed = m[3]?.toLowerCase() ?? null;
    const family = `${base}${speed ? `-${speed}` : ''}${context ? `-${context}` : ''}`;
    return { family, base, effort, speed, context, sidekick: null };
  }
  return {
    family: `${rest}${context ? `-${context}` : ''}`,
    base: rest,
    effort: null,
    speed: null,
    context,
    sidekick: null,
  };
}

const DEVIN_EFFORT_NAME_TOKENS: Record<DevinEffort, RegExp> = {
  none: /\s+No Thinking/i,
  minimal: /\s+Minimal(?:\s+Thinking)?/i,
  low: /\s+Low(?:\s+Thinking)?/i,
  fast: /\s+Fast(?:\s+Thinking)?/i,
  medium: /\s+Medium(?:\s+Thinking)?/i,
  high: /\s+High(?:\s+Thinking)?/i,
  xhigh: /\s+XHigh(?:\s+Thinking)?/i,
  ultra: /\s+Ultra(?:\s+Thinking)?/i,
  max: /\s+Max(?:\s+Thinking)?/i,
  slow: /\s+Slow(?:\s+Thinking)?/i,
};

/** "Claude Opus 5.5 Low Fast" → "Claude Opus 5.5 Fast"; "GPT-6 Sol No
 *  Thinking" → "GPT-6 Sol"; "GLM-5.2 Max 1M" → "GLM-5.2 1M". Falls back to the
 *  family heading text when stripping would eat the whole name. */
function devinFamilyDisplayName(name: string, effort: DevinEffort, sidekick: string | null): string {
  if (sidekick) {
    // "Fusion (<lead> <Effort> [<speed>] + <sidekick>)" — strip the lead's own
    // effort word and keep speed + the whole sidekick half.
    const plus = name.indexOf(' + ');
    if (plus > 0) {
      const lead = name
        .slice(0, plus)
        .replace(DEVIN_EFFORT_NAME_TOKENS[effort], '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      return `${lead}${name.slice(plus)}`.replace(/\s{2,}/g, ' ').trim();
    }
  }
  const stripped = name
    .replace(DEVIN_EFFORT_NAME_TOKENS[effort], '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return stripped || name;
}

interface DevinCatalogMember {
  slug: string;
  model: ModelDef;
  effort: DevinEffort | null;
}


// ─── Fusion: one model, two editable slots ─────────────────────────────────
// `devin models` emits one slug per pairing cell
// (`fusion-<lead>-<effort>[-fast]-sidekick-<sidekick>[-<effort>][-priority]`),
// which used to collapse into one model PER pairing. Koryphaios now presents
// Fusion as a single model whose composer edits each slot (model, effort,
// fast), so the rows collapse into a FusionCatalog and one `fusion` ModelDef.

const FUSION_NAME_WORD = /\s+(No Thinking|Minimal|Low|Medium|High|XHigh|Ultra|Max|Slow|Fast|Priority)(?=\s|$)/gi;

/** "Claude Opus 5.5 Medium Fast" → "Claude Opus 5.5"; "GPT-6 Luna High
 *  Priority" → "GPT-6 Luna"; "SWE-2 Medium" → "SWE-2". */
function fusionDisplayName(part: string): string {
  const stripped = part.replace(FUSION_NAME_WORD, '').replace(/\s{2,}/g, ' ').trim();
  return stripped || part.trim();
}

function effortOrdered(efforts: Set<string>): string[] {
  return [...efforts].sort(
    (a, b) => DEVIN_EFFORT_ORDER.indexOf(a as DevinEffort) - DEVIN_EFFORT_ORDER.indexOf(b as DevinEffort),
  );
}

/** Build the single `fusion` model + its pairing catalog from Devin's raw
 *  fusion rows. Returns undefined when the CLI reports no fusion rows. */
export function buildDevinFusionModel(fusionModels: ModelDef[]): ModelDef | undefined {
  if (fusionModels.length === 0) return undefined;

  const leads = new Map<string, FusionSlotOption>();
  const sidekicks = new Map<string, FusionSlotOption>();
  const leadEfforts = new Map<string, Set<string>>();
  const sidekickEfforts = new Map<string, Set<string>>();
  const pairings: Record<string, Record<string, string>> = {};
  const meta: Record<string, FusionPairingMeta> = {};
  const aliasSet = new Set<string>();
  let defaultSelection: FusionSelection | undefined;
  let defaultSlug: string | undefined;
  let defaultRow: ModelDef | undefined;

  for (const model of fusionModels) {
    const slug = model.apiModelId ?? model.id;
    const parts = splitFusionSlug(slug);
    if (!parts) continue;
    aliasSet.add(slug);
    // The previously-emitted collapsed family id stays resolvable too.
    aliasSet.add(splitDevinModelSlug(slug).family);

    // "Fusion (<Lead> <Effort> [Fast] + <Sidekick> [<Effort>] [<Priority>])"
    const inner = model.name.match(/^Fusion\s*\((.+)\+(.+)\)$/i);
    const leadName = inner ? fusionDisplayName(inner[1]) : parts.lead;
    const sidekickName = inner ? fusionDisplayName(inner[2]) : parts.sidekick;

    if (!leads.has(parts.lead)) {
      leads.set(parts.lead, { id: parts.lead, name: leadName, efforts: [], defaultEffort: null });
      leadEfforts.set(parts.lead, new Set());
    }
    leadEfforts.get(parts.lead)!.add(parts.leadEffort);
    if (!sidekicks.has(parts.sidekick)) {
      sidekicks.set(parts.sidekick, {
        id: parts.sidekick,
        name: sidekickName,
        efforts: [],
        defaultEffort: null,
      });
      sidekickEfforts.set(parts.sidekick, new Set());
    }
    if (parts.sidekickEffort) sidekickEfforts.get(parts.sidekick)!.add(parts.sidekickEffort);

    const key = fusionPairingKey(parts.lead, parts.leadFast, parts.sidekick, parts.sidekickEffort);
    (pairings[key] ??= {})[parts.leadEffort] = slug;
    // Pairing facts come from the pairing's default-effort row — medium when
    // Devin offers it, else the first row seen.
    if (!meta[key] || parts.leadEffort === 'medium') {
      meta[key] = {
        contextWindow: model.contextWindow,
        ...(model.costPerMInputTokens !== undefined
          ? { costPerMInputTokens: model.costPerMInputTokens }
          : {}),
        ...(model.costPerMOutputTokens !== undefined
          ? { costPerMOutputTokens: model.costPerMOutputTokens }
          : {}),
        ...(model.costPerMInputCached !== undefined
          ? { costPerMInputCached: model.costPerMInputCached }
          : {}),
      };
    }

    if (!defaultSelection) {
      defaultSelection = {
        lead: parts.lead,
        leadEffort: parts.leadEffort,
        leadFast: parts.leadFast,
        sidekick: parts.sidekick,
        sidekickEffort: parts.sidekickEffort,
      };
      defaultSlug = slug;
      defaultRow = model;
    }
  }
  if (!defaultSelection || !defaultSlug || !defaultRow) return undefined;

  for (const [id, option] of leads) {
    const efforts = effortOrdered(leadEfforts.get(id)!);
    option.efforts = efforts;
    option.defaultEffort = efforts.includes('medium') ? 'medium' : (efforts[0] ?? null);
  }
  for (const [id, option] of sidekicks) {
    const efforts = effortOrdered(sidekickEfforts.get(id)!);
    option.efforts = efforts;
    option.defaultEffort = efforts.includes('medium') ? 'medium' : (efforts[0] ?? null);
  }

  const catalog: FusionCatalog = {
    leads: [...leads.values()],
    sidekicks: [...sidekicks.values()],
    pairings,
    meta,
    defaultSelection,
  };

  return {
    ...defaultRow,
    id: 'fusion',
    name: 'Fusion',
    apiModelId: defaultSlug,
    canReason: false,
    reasoningLevels: undefined,
    reasoningVariants: undefined,
    speedTiers: undefined,
    speedVariants: undefined,
    speedAliases: undefined,
    contextWindow: Math.max(...Object.values(meta).map((m) => m.contextWindow), 0),
    fusion: catalog,
    aliases: [...aliasSet].filter((a) => a !== 'fusion'),
  };
}

/** Collapse every per-effort slug family into a single base model.
 *
 *  A family only collapses when the CLI reported at least two effort-tiered
 *  slugs for it, so a single-tier account keeps reporting that tier verbatim
 *  instead of inventing levels. Untiered models (adaptive, kimi-k2-7, bare
 *  context variants) pass through untouched. */
export function collapseDevinReasoningTiers(models: ModelDef[]): ModelDef[] {
  // Fusion pairings collapse into ONE `fusion` model, not per-pair families.
  const fusionRows: ModelDef[] = [];
  const nonFusion: ModelDef[] = [];
  let firstFusionAt = -1;
  for (const model of models) {
    const slug = model.apiModelId ?? model.id;
    if (slug.startsWith('fusion-') && splitFusionSlug(slug)) {
      if (firstFusionAt < 0) firstFusionAt = models.indexOf(model);
      fusionRows.push(model);
    } else {
      nonFusion.push(model);
    }
  }
  const collapsed = collapseDevinNonFusionTiers(nonFusion);
  const fusionDef = buildDevinFusionModel(fusionRows);
  if (!fusionDef) return collapsed;
  collapsed.splice(Math.min(Math.max(firstFusionAt, 0), collapsed.length), 0, fusionDef);
  return collapsed;
}

function collapseDevinNonFusionTiers(models: ModelDef[]): ModelDef[] {
  const families = new Map<string, DevinCatalogMember[]>();
  const familyParts = new Map<string, DevinSlugParts>();
  for (const model of models) {
    const slug = model.apiModelId ?? model.id;
    const parts = splitDevinModelSlug(slug);
    const member: DevinCatalogMember = { slug, model, effort: parts.effort };
    const family = families.get(parts.family);
    if (family) family.push(member);
    else {
      families.set(parts.family, [member]);
      familyParts.set(parts.family, parts);
    }
  }

  // A `fast`/`priority` speed family is the same model on a different serving
  // tier, not a different model: fold it into its standard-speed sibling
  // (same base and context, no speed token) when that sibling collapses, so
  // the tier becomes the composer's Fast switch. A fast family with no
  // collapsible sibling stays its own model rather than dropping entries.
  const foldedFastKeys = new Set<string>();
  const fastByStandard = new Map<string, { keys: string[]; members: DevinCatalogMember[] }>();
  for (const [key, parts] of familyParts) {
    if (parts.speed !== 'fast' && parts.speed !== 'priority') continue;
    const standardKey = `${parts.base}${parts.context ? `-${parts.context}` : ''}`;
    const standard = families.get(standardKey);
    if (!standard || standard.filter((m) => m.effort !== null).length < 2) continue;
    foldedFastKeys.add(key);
    const entry = fastByStandard.get(standardKey);
    const members = families.get(key)!;
    if (entry) {
      entry.keys.push(key);
      entry.members.push(...members);
    } else {
      fastByStandard.set(standardKey, { keys: [key], members: [...members] });
    }
  }

  const emitted = new Set<string>();
  const out: ModelDef[] = [];
  for (const model of models) {
    const slug = model.apiModelId ?? model.id;
    const { family: key } = splitDevinModelSlug(slug);
    if (foldedFastKeys.has(key)) continue;
    const family = families.get(key) ?? [];
    const tiered = family.filter((m) => m.effort !== null);
    if (tiered.length < 2 || emitted.has(key)) {
      if (!emitted.has(key)) out.push(model);
      continue;
    }
    emitted.add(key);
    out.push(collapseDevinFamily(family, key, fastByStandard.get(key)));
  }
  return out;
}

function collapseDevinFamily(
  family: DevinCatalogMember[],
  key: string,
  fast?: { keys: string[]; members: DevinCatalogMember[] },
): ModelDef {
  const tiered = family.filter((m) => m.effort !== null);
  // A bare slug is Devin's own default when it exists alongside tiers
  // (e.g. glm-5-2-1m next to glm-5-2-max-1m); otherwise medium, then the first
  // tier in effort order.
  const bare = family.find((m) => m.effort === null);
  const fallback =
    tiered.find((m) => m.effort === 'medium') ??
    [...tiered].sort(
      (a, b) => DEVIN_EFFORT_ORDER.indexOf(a.effort!) - DEVIN_EFFORT_ORDER.indexOf(b.effort!),
    )[0];
  const primary = bare ?? fallback;

  const reasoningVariants: Record<string, string> = {};
  const efforts: DevinEffort[] = [];
  for (const member of tiered) {
    efforts.push(member.effort!);
    reasoningVariants[member.effort!] = member.slug;
  }
  const levels = [...new Set(efforts)].sort(
    (a, b) => DEVIN_EFFORT_ORDER.indexOf(a) - DEVIN_EFFORT_ORDER.indexOf(b),
  );

  const nameSource = primary.effort
    ? devinFamilyDisplayName(
        primary.model.name,
        primary.effort,
        primary.slug.includes('-sidekick-') ? primary.slug : null,
      )
    : // A bare member's display name still carries its implicit tier word
      // ("GLM-5.2 High 1M") — strip it so the family reads "GLM-5.2 1M".
      primary.model.name
        .replace(/\s+(Minimal|Low|Medium|High|XHigh|Ultra|Max|Slow|Fast|No Thinking)(?=\s|$)/i, '')
        .trim() || primary.model.name;

  // Every superseded member slug stays resolvable through `aliases` so a
  // session saved before the collapse keeps running at its recorded tier.
  // Fast-tier members and the old fast family keys join the same list (and
  // `speedAliases`) so a persisted fast selection keeps working — with the
  // fast tier on.
  const fastSlugs = fast ? fast.members.map((m) => m.slug) : [];
  const fastAliasIds = fast ? [...new Set([...fastSlugs, ...fast.keys])] : [];
  const aliases = [...new Set([...family.map((m) => m.slug), ...fastAliasIds])].filter(
    (s) => s !== key,
  );
  const fastVariants: Record<string, string> = {};
  if (fast) {
    for (const member of fast.members) {
      if (member.effort !== null) fastVariants[member.effort] = member.slug;
    }
  }
  return {
    ...primary.model,
    id: key,
    name: nameSource,
    apiModelId: primary.slug,
    canReason: true,
    reasoningLevels: levels.length > 1 ? [...levels, 'auto'] : levels,
    reasoningVariants,
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(fast
      ? {
          speedTiers: [SPEED_TIER_FAST_DEVIN],
          speedVariants: { fast: fastVariants },
          speedAliases: Object.fromEntries(fastAliasIds.map((id) => [id, 'fast'])),
        }
      : {}),
  };
}

/** The Devin slug a Koryphaios reasoning level resolves to, or undefined to use
 *  the model's own default slug. `auto`/`adaptive` deliberately fall through
 *  to that default — Devin's `adaptive` router is a separate model, not an
 *  effort. */
export function resolveDevinVariant(
  model: ModelDef | undefined,
  effort?: string,
): string | undefined {
  const variants = model?.reasoningVariants;
  if (!variants || !effort) return undefined;
  const key = effort.trim().toLowerCase();
  if (!key || key === 'auto' || key === 'adaptive') return undefined;
  return variants[key];
}

/** Resolve a collapsed model + reasoning level + speed tier to the concrete
 *  Devin slug for --model. Standard resolution is unchanged; when `speedTier`
 *  is set, the model's own default tier (`auto`/unset effort → the effort
 *  baked into `apiModelId`) resolves through `speedVariants`, falling back
 *  to the standard slug when the tier has no variant for that effort. */
export function resolveDevinSlug(
  model: ModelDef,
  effort: string | undefined,
  speedTier?: string,
): string {
  const standard = resolveDevinVariant(model, effort) ?? model.apiModelId ?? model.id;
  if (!speedTier) return standard;
  const normalized = effort?.trim().toLowerCase();
  const resolvedEffort =
    normalized && normalized !== 'auto' && normalized !== 'adaptive'
      ? normalized
      : splitDevinModelSlug(model.apiModelId ?? model.id).effort;
  return resolveSpeedVariant(model, speedTier, resolvedEffort ?? undefined) ?? standard;
}

/** Resolve a requested model id to a catalog entry. Accepts the superseded
 *  per-effort slugs kept in `aliases` and reports the effort they encoded, so
 *  a session saved before the collapse keeps running at the tier the user
 *  actually selected. `speedAliases` hits report their tier as
 *  `legacySpeedTier` so a persisted fast selection restores with the speed
 *  switch on. */
export function matchDevinModel(
  models: ModelDef[],
  modelId: string,
): { model: ModelDef; legacyEffort?: DevinEffort; legacySpeedTier?: string } | undefined {
  const normalized = modelId.replace(/^devin-/, '');
  const exact = models.find((m) => m.id === normalized || m.apiModelId === normalized);
  if (exact) return { model: exact };
  const aliased = models.find((m) => m.aliases?.includes(normalized));
  if (!aliased) return undefined;
  const legacySpeedTier = aliased.speedAliases?.[normalized];
  if (legacySpeedTier !== undefined) {
    // A real fast slug (`claude-opus-5-5-high-fast`) contributes the effort it
    // encoded. The superseded fast family key (`claude-opus-5-5-fast`) carries
    // none — the parser reads its trailing speed word as the effort `fast`,
    // which must not become the restored tier.
    const { speed, effort } = splitDevinModelSlug(normalized);
    return speed === 'fast' || speed === 'priority'
      ? { model: aliased, ...(effort ? { legacyEffort: effort } : {}), legacySpeedTier }
      : { model: aliased, legacySpeedTier };
  }
  const { effort } = splitDevinModelSlug(normalized);
  return effort ? { model: aliased, legacyEffort: effort } : { model: aliased };
}
