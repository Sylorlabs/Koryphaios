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

export interface DevinModelEntry {
  id: string;
  name: string;
  contextWindow?: number;
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
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
      } catch {
        /* gone */
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

/** Parse `devin models list` output into model entries.
 *
 * The CLI groups entries under unindented family headings. Only indented rows
 * are selectable model IDs; accepting every line accidentally turned family
 * names, aliases, and even `devin models` help text into fake models.
 */
export function parseDevinModelsOutput(output: string): DevinModelEntry[] {
  // `devin models` (without `list`) prints command help whose indented
  // subcommands resemble model rows. The list command identifies its catalog
  // explicitly; fail closed if that marker is absent.
  if (!/^Available models \(\d+ families\)\s*$/mi.test(output)) return [];
  const models: DevinModelEntry[] = [];
  const seen = new Set<string>();
  for (const raw of output.split('\n')) {
    // Entries are indented. Headings such as "Claude Opus 5 (...)" are not.
    if (!/^\s+\S/.test(raw)) continue;
    const line = raw.trim();
    if (!line || /^aliases:\s*/i.test(line)) continue;
    // Rows look like: "gpt-5-6-sol-medium  GPT-5.6 Sol Medium [1M context]".
    // The CLI also exposes stable uppercase enum IDs for older model families.
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s{2,}(.+?)(?:\s{2,}\[(.*)\])?\s*$/);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id) || id.length > 80) continue;
    seen.add(id);
    const context = m[3]?.match(/([\d.]+)\s*([kKmM])?\s+context/i);
    const amount = context ? Number(context[1]) : undefined;
    const multiplier = context?.[2]?.toLowerCase() === 'm' ? 1_000_000 : context?.[2]?.toLowerCase() === 'k' ? 1_000 : 1;
    models.push({
      id,
      name: (m[2] || id).trim(),
      ...(amount && Number.isFinite(amount) ? { contextWindow: Math.round(amount * multiplier) } : {}),
    });
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
  } catch {
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
    subs.supportsRules ? runCli(['rules', 'paths'], PROBE_TIMEOUT_MS) : Promise.resolve({ stdout: '', stderr: '', code: -1 }),
    subs.supportsSkills ? runCli(['skills', 'paths'], PROBE_TIMEOUT_MS) : Promise.resolve({ stdout: '', stderr: '', code: -1 }),
    runCli(['models', 'list'], MODELS_TIMEOUT_MS),
  ]);

  const caps: DevinCapabilities = {
    binaryPath: bin,
    binaryMtimeMs: stat.mtimeMs,
    version,
    ...flags,
    ...subs,
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
  } catch {
    /* unreadable — fall through with stale cache */
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
 * metadata. Alias lines ("  aliases: opus") and help text are excluded.
 */
export function parseDevinModelsOutput(output: string): DevinModelEntry[] {
  const lines = output.split('\n');
  const models: DevinModelEntry[] = [];

  // Help text (not a catalog) starts with "List the models" or "Usage:".
  if (/^Usage:|^\s*Commands:/m.test(output) || /^List the models/m.test(output)) {
    return [];
  }

  for (const line of lines) {
    // Model rows are indented and contain an id followed by a display name.
    // Format: "  <id>  <Display Name>  [Nk context, ...]"
    const match = line.match(
      /^\s{2,}(\S+)\s{2,}(.+?)(?:\s*\[(\d+(?:[._]\d+)*)\s*([KkMm]?)\s*context[^\]]*\])?\s*$/,
    );
    if (match) {
      const id = match[1];
      const name = match[2].trim();
      let contextWindow: number | undefined;
      if (match[3]) {
        const num = parseInt(match[3].replace(/[._]/g, ''), 10);
        const suffix = match[4]?.toUpperCase();
        if (suffix === 'M') contextWindow = num * 1_000_000;
        else if (suffix === 'K') contextWindow = num * 1_000;
        else contextWindow = num;
      }
      models.push({ id, name, contextWindow });
    }
  }

  return models;
}
