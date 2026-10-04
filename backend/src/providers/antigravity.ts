// Antigravity CLI harness provider — runs Google's official `agy` CLI.
//
// Auth: `agy auth` (Google subscription OAuth) or ANTIGRAVITY_API_KEY in environment.
// Koryphaios never holds the credential — it shells out to the locally installed CLI.
//
// Headless interface:
//   agy --input-format stream-json --output-format stream-json --model "<model>"
//       --sandbox --log-file <path>
//
// Tool authority: Koryphaios does NOT use `--mode` for this. agy ignores
// `--mode` in print/stream-json mode ("Print mode: --mode <x> is not supported
// headless"). Each turn instead writes agy's real permission engine — the
// `permissions.{deny,ask,allow}` lists and `toolPermission` in the managed
// home's settings.json — where anything not explicitly allowed is soft-denied
// because headless runs cannot prompt. See antigravity-permissions.ts.
//
// Streaming sources (agy ≥1.0.16 writes only glog server logs to --log-file, so
// the SSE parser below is a legacy fallback for older builds):
//   • trajectory SQLite (conversations/<id>.db, step_type 15, proto …20.3) —
//     the step_payload GROWS IN PLACE while the model streams; we re-read the
//     newest row each 150ms poll and emit the appended thinking suffix live.
//   • brain transcript JSONL — responses + tool runs as steps complete.
//   • stdout — the final answer, streamed as chunks arrive.
//
// Model discovery: `agy models` → one model name per line, refreshed with a 5-min TTL.
// Antigravity exposes Gemini, Claude, and GPT models under a single Google subscription.
// It publishes reasoning effort as separate per-tier slugs; those families are collapsed
// into one base model each and the composer's effort picks the tier at spawn time.

import type { ProviderConfig, ModelDef, ModelQuota } from '@koryphaios/shared';
import { spawn, spawnSync } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import {
  type Provider,
  type ProviderEvent,
  type ProviderMessage,
  type StreamRequest,
} from './types';
import { detectAntigravityCLILogin } from './auth-utils';
import { whichBinary } from './cli-detection';
import { providerLog } from '../logger';
import {
  buildSoftJail,
  inferenceSandboxPolicy,
  wrapCommand,
} from '../collaboration/sandbox-runner';
import { getCliBridge, getKoryphaiosAntigravityHome } from './cli-bridges';
import { buildAntigravityHooks, buildAntigravitySettings } from './antigravity-permissions';
import {
  fetchAntigravityQuota,
  fetchAntigravityQuotaGroups,
  type AntigravityQuotaGroup,
} from './antigravity-quota';
import { createKoryBridgeGrantLease } from './bridge-grant';
import { createCliAttachmentScope, type CliAttachmentScope } from './cli-attachments';
import {
  assertPrivateValuesAbsentFromArgv,
  createPrivateCliTextArtifact,
  spawnWithPrivateArtifactCleanup,
} from './private-cli-transport';
import {
  appendPrivateDiagnostic,
  safeProviderDiagnostic,
  safeProviderFailureMessage,
  providerStreamFailure,
} from './provider-diagnostics';
import {
  ensureManagedCliDirectory,
  healManagedCliFile,
  writeManagedCliFile,
} from './managed-cli-storage';
import { buildProviderCliEnv } from './cli-environment';
import { getSafeSubprocessEnv } from '../runtime/safe-env';
import { applyModelsDevMetadata } from './models-dev';

const AGY_TIMEOUT_MS = 300_000;
const MODELS_CACHE_TTL_MS = 5 * 60_000;
const LOG_POLL_INTERVAL_MS = 150;
/** Budget for the read-only `agy models` discovery probe. It authenticates
 *  (keychain/D-Bus unlock) and then calls Google's account backend, so it needs
 *  the same allowance as `agy --print /usage`. */
const AGY_MODELS_PROBE_TIMEOUT_MS = 8_000;

// ── Session → agy conversation continuity ────────────────────────────────────
// agy supports `--conversation <id>` to resume. Without it every Koryphaios turn
// spawns a brand-new agentic session that re-explores the workspace (dozens of
// tool runs before the answer). We map each Koryphaios session to the agy
// conversation it created on its first turn and resume it afterwards, sending
// only the NEW turn — agy keeps its own history.
interface AntigravityConversationCacheEntry {
  conversationId: string;
  providerConversationRevision: number;
}

const sessionConversations = new Map<string, AntigravityConversationCacheEntry>();

export function canResumeAntigravityConversation(
  cached: AntigravityConversationCacheEntry | undefined,
  providerConversationRevision: number,
  forceFreshConversation = false,
): boolean {
  return (
    !forceFreshConversation &&
    cached !== undefined &&
    cached.providerConversationRevision === providerConversationRevision
  );
}
let cachedPrivatePromptFileSupport: boolean | undefined;

export function antigravityHelpSupportsPrivatePromptFile(help: string): boolean {
  return /(?:^|\s)--(?:prompt-file|input-format|output-format)(?:\s|=|<)/m.test(help);
}

/** Host D-Bus user-bus endpoint for OS-keyring OAuth inside the jail. agy
 *  keeps its Google OAuth tokens in the login keyring (libsecret), not on
 *  disk — without the bus it reports "Please sign in" despite a valid login.
 *  Returns null when no path-based bus exists (abstract-only addresses cannot
 *  be bind-mounted); the turn then fails with agy's own sign-in message. */
function hostUserBusSocket(): {
  socket: string;
  address: string;
  runtimeDir: string;
} | null {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  const address = process.env.DBUS_SESSION_BUS_ADDRESS;
  const fromAddress = address ? /path=([^;,]+)/.exec(address)?.[1] : undefined;
  const socket = fromAddress ?? (runtimeDir ? join(runtimeDir, 'bus') : undefined);
  if (!socket || !runtimeDir || !existsSync(socket)) return null;
  return { socket, address: address ?? `unix:path=${socket}`, runtimeDir };
}

function supportsPrivateTransport(bin: string): boolean {
  if (cachedPrivatePromptFileSupport !== undefined) return cachedPrivatePromptFileSupport;
  try {
    const result = spawnSync(bin, ['--help'], {
      encoding: 'utf8',
      timeout: 4_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: getSafeSubprocessEnv(),
    });
    const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    cachedPrivatePromptFileSupport = antigravityHelpSupportsPrivatePromptFile(combinedOutput);
  } catch {
    cachedPrivatePromptFileSupport = false;
  }
  return cachedPrivatePromptFileSupport;
}

/** Data roots holding agy conversations/transcripts. The child runs with
 *  ANTIGRAVITY_HOME/HOME pointed at the isolated managed home, so Kory-spawned
 *  turns land there — not under the real login home. Scan both (isolated
 *  first) so Kory-created turns are found while the user's own agy usage
 *  stays visible too. */
function agyDataRoots(): string[] {
  const isolated = join(getKoryphaiosAntigravityHome(), '.gemini', 'antigravity-cli');
  const real = join(homedir(), '.gemini', 'antigravity-cli');
  return isolated === real ? [real] : [isolated, real];
}

function agyConvDirs(): string[] {
  return agyDataRoots().map((root) => join(root, 'conversations'));
}

function agyBrainDirs(): string[] {
  return agyDataRoots().map((root) => join(root, 'brain'));
}

/** Resolve a conversation db by id, preferring the isolated managed home. */
function agyConvDb(convId: string): string | null {
  for (const dir of agyConvDirs()) {
    const file = join(dir, `${convId}.db`);
    if (existsSync(file)) return file;
  }
  return null;
}

/** Snapshot conversation ids currently on disk. */
function listConversationIds(): Set<string> {
  const ids = new Set<string>();
  for (const dir of agyConvDirs()) {
    try {
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.db')) ids.add(f.slice(0, -3));
      }
    } catch (err: unknown) {
      providerLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'failed to list agy conversation ids',
      );
    }
  }
  return ids;
}

/** The conversation Koryphaios's agy just created — the NEWEST db that wasn't
 *  in `before`. Picking newest-by-mtime (not "first") avoids grabbing the
 *  user's OWN concurrently-running agy conversation: our just-spawned process
 *  is the one actively writing, so its db is the freshest new one. */
function detectNewConversation(before: Set<string>): string | null {
  let best: string | null = null;
  let bestMtime = -1;
  for (const dir of agyConvDirs()) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.db')) continue;
      const id = f.slice(0, -3);
      if (before.has(id)) continue;
      try {
        const mt = statSync(join(dir, f)).mtimeMs;
        if (mt > bestMtime) {
          bestMtime = mt;
          best = id;
        }
      } catch (err: unknown) {
        providerLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'raced away reading conversation mtime',
        );
        /* raced away */
      }
    }
  }
  return best;
}

// ── Dynamic model cache ────────────────────────────────────────────────────────

let cachedModels: ModelDef[] | null = null;
let cachedModelsAt = 0;
let modelsFetchInProgress = false;
let modelsFetchPromise: Promise<ModelDef[]> | null = null;
/** Live per-group quota from the agy CLI's `/usage` command, keyed by group
 *  name. Refreshed alongside the model list and merged into ModelDef.quota. */
let cachedQuota: Map<string, ModelQuota> | null = null;
/** Full quota group detail (weekly + 5h buckets) for the API endpoint. */
let cachedQuotaGroups: AntigravityQuotaGroup[] | null = null;

/** Environment for the read-only `agy models` discovery probe.
 *
 *  This deliberately does NOT use the Kory-managed isolated HOME that the
 *  agentic turn runs under. agy keeps its Google OAuth token in the OS
 *  credential store (macOS login keychain: service "gemini", account
 *  "antigravity"; libsecret over the D-Bus user bus on Linux). The Security
 *  framework resolves the login keychain from the *user's* home directory, so
 *  a child launched with a replaced HOME finds no keychain and reports
 *  "Please sign in to view available models" — producing a verified provider
 *  with an empty model catalog.
 *
 *  Discovery is a pure read (`agy models` lists the account's model slugs and
 *  writes nothing Koryphaios depends on), so running it under the real, safe
 *  environment is both correct and side-effect free. The credential itself is
 *  never read or copied by Koryphaios: agy reads it, in its own process, from
 *  the keychain it already uses interactively. This mirrors
 *  `fetchAntigravityQuotaGroups` in antigravity-quota.ts and
 *  `probeCliConnection` in cli-detection.ts, which both already probe agy with
 *  the real environment. */
function agyDiscoveryEnv(): NodeJS.ProcessEnv {
  return getSafeSubprocessEnv();
}

function buildAntigravityModels(
  raw: ModelDef[],
  quota: Map<string, ModelQuota> | null,
): ModelDef[] {
  // Collapse first: enrichment then looks up one bare slug per family, which is
  // what models.dev catalogs, and the surviving base model carries the effort
  // levels the collapsed tiers had.
  const collapsed = collapseAgyReasoningTiers(raw);
  const enriched = applyModelsDevMetadata('antigravity', collapsed, [
    'google',
    'anthropic',
    'openai',
  ]);
  const withWindows = enriched.map((m) => {
    if (m.contextWindow && m.contextWindow > 0) return m;
    const apiId = (m.apiModelId ?? m.id).toLowerCase();
    let fallback = 0;
    let out = m.maxOutputTokens;
    if (apiId.startsWith('gemini-')) {
      fallback = 1_048_576;
      out = out || 8192;
    } else if (apiId.startsWith('claude-')) {
      fallback = 200_000;
      out = out || 8192;
    } else if (apiId.startsWith('gpt-')) {
      fallback = 131_072;
      out = out || 16384;
    } else {
      fallback = 200_000;
      out = out || 8192;
    }
    return { ...m, contextWindow: fallback, contextVerified: true, maxOutputTokens: out };
  });
  return mergeQuotaIntoModels(withWindows, quota);
}

/** Refresh the model catalog (and live quota) from the agy CLI.
 *
 *  Returns a promise so `ProviderRegistry.refreshModelCatalogsInternal` awaits
 *  the real fetch instead of returning before the catalog lands — previously
 *  this returned void, so a forced refresh served a still-empty list. */
function refreshModelsInBackground(): Promise<ModelDef[]> {
  if (modelsFetchInProgress) return modelsFetchPromise ?? Promise.resolve(cachedModels ?? []);
  const bin = whichBinary('agy');
  if (!bin) return Promise.resolve(cachedModels ?? []);

  modelsFetchInProgress = true;
  modelsFetchPromise = Promise.all([fetchAgyModels(bin), fetchAntigravityQuotaGroups()])
    .then(([models, groups]) => {
      if (models.length === 0) {
        providerLog.warn(
          { provider: 'antigravity' },
          'agy models returned no models; keeping the previous catalog',
        );
        return cachedModels ?? [];
      }
      cachedQuotaGroups = groups;
      const quotaMap = new Map<string, ModelQuota>();
      if (groups) {
        for (const g of groups) {
          const buckets = g.buckets;
          if (buckets.length === 0) continue;
          const binding = buckets.reduce((min, b) =>
            b.remainingFraction < min.remainingFraction ? b : min,
          );
          quotaMap.set(g.name, {
            remainingFraction: binding.remainingFraction,
            resetTime: binding.resetTime ? Date.parse(binding.resetTime) : 0,
          });
        }
      }
      cachedQuota = quotaMap;
      cachedModels = buildAntigravityModels(models, quotaMap);
      cachedModelsAt = Date.now();
      providerLog.debug(
        { provider: 'antigravity', models: cachedModels.length },
        'Antigravity model catalog refreshed',
      );
      return cachedModels;
    })
    .catch((err) => {
      /* best-effort; an empty list truthfully represents unavailable discovery */
      providerLog.warn({ provider: 'antigravity', err }, 'Antigravity model discovery failed');
      return cachedModels ?? [];
    })
    .finally(() => {
      modelsFetchInProgress = false;
      modelsFetchPromise = null;
    });
  return modelsFetchPromise;
}

/** Merge live quota info into the model list. The quota map is keyed by
 *  group name (e.g. "Gemini Models", "Claude and GPT models") because the
 *  agy CLI reports quota per-group, not per-model. We map each model to its
 *  group based on the CLI model ID prefix. */
function mergeQuotaIntoModels(
  models: ModelDef[],
  quota: Map<string, ModelQuota> | null,
): ModelDef[] {
  if (!quota || quota.size === 0) return models;
  return models.map((m) => {
    const apiId = m.apiModelId ?? m.id;
    // Map model ID to quota group
    let groupName: string | null = null;
    if (/^gemini-/i.test(apiId)) groupName = 'Gemini Models';
    else if (/^(claude-|gpt-)/i.test(apiId)) groupName = 'Claude and GPT models';
    const q = groupName ? quota.get(groupName) : undefined;
    return q ? { ...m, quota: q } : m;
  });
}

function tryFetchAgyModelsSync(): ModelDef[] | null {
  const bin = whichBinary('agy');
  if (!bin) return null;
  try {
    const result = spawnSync(bin, ['models'], {
      encoding: 'utf8',
      // The probe hits Google's account backend to enumerate the subscription's
      // model slugs. Budget it like `agy --print /usage` does; a cold keychain
      // unlock plus the round trip regularly exceeds 4s.
      timeout: AGY_MODELS_PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: agyDiscoveryEnv(),
    });
    const out = (result.stdout ?? '').toString();
    const lines = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    return lines.length === 0 ? [] : lines.map(modelDefFromCliName);
  } catch {
    return null;
  }
}

async function fetchAgyModels(bin: string): Promise<ModelDef[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['models'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: agyDiscoveryEnv(),
    });
    let out = '';
    let settled = false;
    const finish = (value: ModelDef[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish([]);
    }, AGY_MODELS_PROBE_TIMEOUT_MS);
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', () => {
      const lines = out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      resolve(lines.length === 0 ? [] : lines.map(modelDefFromCliName));
    });
  });
}

const AGY_MODEL_ID_PREFIX = 'antigravity-';

/** Koryphaios catalog id for an agy slug (`gemini-3.8-flash` → `antigravity-gemini-3-8-flash`). */
function agyModelId(slug: string): string {
  return `${AGY_MODEL_ID_PREFIX}${slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+$/, '')}`;
}

export function modelDefFromCliName(line: string): ModelDef {
  // agy models outputs "cliName\tdisplayName" pairs, e.g.:
  //   gemini-3.6-flash-high\tGemini 3.6 Flash (High)
  // The CLI expects the first column as --model; the second is the
  // human-readable display name for the UI.
  const [cliName, displayName] = line.split('\t');
  const name = displayName?.trim() || cliName;
  return {
    id: agyModelId(cliName),
    name,
    provider: 'antigravity',
    apiModelId: cliName,
    contextWindow: 0,
    maxOutputTokens: 0,
    // Modern Gemini models are multimodal. Keep that model capability separate
    // from the CLI adapter's unverified image transport.
    ...(/^gemini-[2-9]\d*[.-]/i.test(cliName) ? { vision: true } : {}),
    supportsAttachments: false,
    supportsStreaming: true,
  };
}

// ── Reasoning-effort families ─────────────────────────────────────────────────
// agy has no reasoning parameter. It publishes effort as separate model slugs —
// "Gemini 3.8 Flash (High)", "(Medium)", "(Low)" — so `agy models` returns one
// row per effort and the picker used to offer the user's raw model choice where
// a reasoning control belongs. Koryphaios collapses each family into ONE base
// model ("Gemini 3.8 Flash") with the real effort levels attached, and maps the
// composer's effort back onto the matching agy slug when it spawns the CLI
// (resolveAgyVariant). That makes effort a Koryphaios control here exactly as
// it is for providers that take a reasoning parameter.

/** Effort tokens agy encodes as a slug suffix, ordered from least to most effort. */
const AGY_EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max'] as const;

type AgyEffort = (typeof AGY_EFFORT_ORDER)[number];

function agyEffortOf(slug: string): AgyEffort | null {
  const tail = slug.slice(slug.lastIndexOf('-') + 1).toLowerCase();
  return (AGY_EFFORT_ORDER as readonly string[]).includes(tail) ? (tail as AgyEffort) : null;
}

/** Split "gemini-3.8-flash-high" into its base slug and its effort token. */
export function splitAgyModelSlug(slug: string): { base: string; effort: AgyEffort | null } {
  const effort = agyEffortOf(slug);
  if (!effort) return { base: slug, effort: null };
  return { base: slug.slice(0, slug.length - effort.length - 1), effort };
}

/** "Gemini 3.8 Flash (High)" → "Gemini 3.8 Flash" (unchanged if agy's format shifts). */
function agyBaseDisplayName(name: string): string {
  const stripped = name.replace(
    new RegExp(`\\s*\\((?:${AGY_EFFORT_ORDER.join('|')})\\)\\s*$`, 'i'),
    '',
  );
  return stripped.trim() || name;
}

/** Collapse every per-effort slug family into a single base model.
 *
 *  A family is only collapsed when the CLI reported at least two slugs for it,
 *  so a single-tier account keeps reporting that tier verbatim instead of
 *  inventing levels. Untiered models pass through untouched. */
export function collapseAgyReasoningTiers(models: ModelDef[]): ModelDef[] {
  const families = new Map<string, ModelDef[]>();
  for (const model of models) {
    const { base } = splitAgyModelSlug(model.apiModelId ?? model.id);
    const family = families.get(base);
    if (family) family.push(model);
    else families.set(base, [model]);
  }

  const collapsedBases = new Set<string>();
  const out: ModelDef[] = [];
  for (const model of models) {
    const slug = model.apiModelId ?? model.id;
    const { base } = splitAgyModelSlug(slug);
    const family = families.get(base);
    const tiered = family?.filter((m) => agyEffortOf(m.apiModelId ?? m.id) !== null) ?? [];
    if (!family || tiered.length < 2) {
      out.push(model);
      continue;
    }
    if (collapsedBases.has(base)) continue;
    collapsedBases.add(base);
    out.push(collapseAgyFamily(family, tiered, base));
  }
  return out;
}

function collapseAgyFamily(family: ModelDef[], tiered: ModelDef[], base: string): ModelDef {
  // The bare slug is agy's own default, so it wins when the CLI reports one
  // alongside tiers; otherwise medium is the balanced default Koryphaios has
  // always used as its reasoning default.
  const bare = family.find((m) => agyEffortOf(m.apiModelId ?? m.id) === null);
  const fallback = tiered.find((m) => agyEffortOf(m.apiModelId ?? m.id) === 'medium') ?? tiered[0];
  const primary = bare ?? fallback;

  const reasoningVariants: Record<string, string> = {};
  const efforts: AgyEffort[] = [];
  for (const member of tiered) {
    const effort = agyEffortOf(member.apiModelId ?? member.id);
    if (!effort) continue;
    efforts.push(effort);
    reasoningVariants[effort] = member.apiModelId ?? member.id;
  }
  efforts.sort((a, b) => AGY_EFFORT_ORDER.indexOf(a) - AGY_EFFORT_ORDER.indexOf(b));

  const baseId = agyModelId(base);
  // Both id forms of every superseded member stay resolvable: sessions saved
  // before the collapse hold the catalog id, and anything else may hold the
  // agy slug that id was built from.
  const aliases = [...new Set(family.flatMap((m) => [m.id, m.apiModelId ?? m.id]))].filter(
    (id) => id !== baseId && id !== primary.apiModelId,
  );
  return {
    ...primary,
    id: baseId,
    name: bare ? agyBaseDisplayName(bare.name) : agyBaseDisplayName(primary.name),
    apiModelId: primary.apiModelId,
    canReason: true,
    reasoningLevels: efforts.length > 1 ? [...efforts, 'auto'] : efforts,
    reasoningVariants,
    ...(aliases.length > 0 ? { aliases } : {}),
  };
}

/** The agy slug a reasoning level resolves to, or undefined to use the model's
 *  own default. Auto/adaptive deliberately fall through to that default. */
export function resolveAgyVariant(
  model: ModelDef | undefined,
  effort?: string,
): string | undefined {
  const variants = model?.reasoningVariants;
  if (!variants || !effort) return undefined;
  const key = effort.trim().toLowerCase();
  if (!key || key === 'auto' || key === 'adaptive') return undefined;
  return variants[key];
}

/** Resolve a requested model id to a catalog entry.
 *
 *  Also accepts the superseded per-effort ids kept in `aliases`, and reports the
 *  effort they encoded so a session saved before the collapse keeps running at
 *  the tier the user actually had selected. */
export function matchAgyModel(
  models: ModelDef[],
  modelId: string,
): { model: ModelDef; legacyEffort?: AgyEffort } | undefined {
  const exact = models.find((m) => m.id === modelId || m.apiModelId === modelId);
  if (exact) return { model: exact };
  const alias = models.find((m) => m.aliases?.includes(modelId));
  if (!alias) return undefined;
  const slug = modelId.startsWith(AGY_MODEL_ID_PREFIX)
    ? modelId.slice(AGY_MODEL_ID_PREFIX.length)
    : modelId;
  const { effort } = splitAgyModelSlug(slug);
  return effort ? { model: alias, legacyEffort: effort } : { model: alias };
}

// ── File-edit tool detection ──────────────────────────────────────────────────

// agy tool names that create or overwrite a file entirely.
const AGY_CREATE_TOOLS = new Set(['write_to_file', 'write_file']);
// agy tool names that patch/replace content within an existing file.
const AGY_EDIT_TOOLS = new Set(['replace_file_content', 'multi_replace_file_content', 'edit_file']);

function tryEmitFileEdit(name: string, args: Record<string, unknown>): ProviderEvent | null {
  const isCreate = AGY_CREATE_TOOLS.has(name);
  const isEdit = AGY_EDIT_TOOLS.has(name);
  if (!isCreate && !isEdit) return null;

  // agy uses "path" or "filename" for the file path field.
  const filePath = (args.path ?? args.filename ?? args.file_path) as string | undefined;
  if (!filePath) return null;

  // For full-write tools the content is in "content" or "new_content".
  // For patch tools we concatenate replacement strings so the UI shows something.
  let fileContent: string | undefined;
  if (isCreate) {
    fileContent = (args.content ?? args.new_content ?? '') as string;
  } else {
    // multi_replace_file_content: { replacements: [{old_string, new_string}] }
    const replacements = args.replacements as Array<{ new_string?: string }> | undefined;
    fileContent = replacements
      ? replacements.map((r) => r.new_string ?? '').join('\n')
      : ((args.new_content ?? args.content ?? '') as string);
  }

  return {
    type: 'file_edit',
    filePath,
    fileContent,
    fileOperation: isCreate ? 'create' : 'edit',
  };
}

/** Translate one authoritative `agy --output-format stream-json` line into
 * Koryphaios events. Keeping this parser independent makes fragmented stdout
 * handling testable without launching the user's CLI. */
export function parseAntigravityStreamLine(line: string): ProviderEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  try {
    const envelope = JSON.parse(trimmed) as {
      event?: string;
      step_update?: {
        step_type?: string;
        text_delta?: string;
      };
      result?: {
        status?: string;
        error?: unknown;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_tokens?: number;
        };
        /** Headless turns auto-deny anything needing approval. */
        denied_actions?: Array<{ action?: string; display_name?: string } | string> | null;
      };
    };
    if (envelope.event === 'step_update') {
      const step = envelope.step_update;
      if (step?.step_type === 'agent_response' && step.text_delta) {
        return [{ type: 'content_delta', content: step.text_delta }];
      }
      return [];
    }
    if (envelope.event === 'result') {
      const usage = envelope.result?.usage;
      const events: ProviderEvent[] = [];
      if (usage && (usage.input_tokens != null || usage.output_tokens != null)) {
        events.push({
          type: 'usage_update',
          tokensIn: Number(usage.input_tokens ?? 0),
          tokensOut: Number(usage.output_tokens ?? 0),
          tokensCache: Number(usage.cache_read_tokens ?? 0),
          tokensCacheRead: Number(usage.cache_read_tokens ?? 0),
        });
      }
      // Headless runs cannot prompt, so agy soft-denies anything requiring
      // approval and reports it here. Surfacing it keeps a refusal visible
      // instead of letting the turn simply end with no explanation.
      const denied = envelope.result?.denied_actions;
      if (Array.isArray(denied) && denied.length > 0) {
        const names = denied
          .map((entry) =>
            entry && typeof entry === 'object'
              ? String(
                  (entry as Record<string, unknown>).display_name ??
                    (entry as Record<string, unknown>).action ??
                    'unknown',
                )
              : String(entry),
          )
          .slice(0, 10);
        events.push({
          type: 'error',
          error: `Antigravity denied ${names.join(', ')} — use the kory__ tools instead of native ${names.length === 1 ? 'tool' : 'tools'}.`,
        });
      }
      if (envelope.result?.status && envelope.result.status !== 'SUCCESS') {
        const error = envelope.result.error ?? `Turn ended with status ${envelope.result.status}`;
        // agy renders upstream HTTP failures as prose, e.g. "UNAVAILABLE
        // (code 503)". Recover the status before the bounded display redaction
        // so the registry can retry temporary failures and shrink context.
        const status =
          typeof error === 'string'
            ? /\b(?:code|status|HTTP)\s*[:=]?\s*(\d{3})\b/i.exec(error)?.[1]
            : undefined;
        const failure = providerStreamFailure('antigravity', 'stream', error, {
          ...(status ? { status: Number(status) } : {}),
        });
        if (failure.diagnostic.transient) {
          failure.event.error = safeProviderFailureMessage('antigravity', {
            ...failure.diagnostic,
            category: 'provider_failure',
          });
        }
        events.push(failure.event);
      }
      return events;
    }
  } catch (err: unknown) {
    providerLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'non-JSON line in stream-json mode',
    );
    // A non-JSON line is not response content in stream-json mode. Keep it out
    // of chat; stderr/exit status below provides the actionable failure.
  }
  return [];
}

// ── SSE log parser ─────────────────────────────────────────────────────────────

interface ParsedLogEvents {
  events: ProviderEvent[];
  gotContent: boolean;
}

function parseLogChunk(chunk: string, debug = false): ParsedLogEvents {
  const events: ProviderEvent[] = [];
  let gotContent = false;
  if (debug && chunk.trim())
    providerLog.debug(
      safeProviderDiagnostic('antigravity', 'stdout', chunk),
      '[agy-debug] log chunk received',
    );

  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const jsonStr = trimmed.slice(5).trim();
    if (!jsonStr || jsonStr === '[DONE]') continue;

    try {
      const payload = JSON.parse(jsonStr) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              text?: string;
              thought?: boolean;
              functionCall?: { name?: string; args?: unknown };
            }>;
          };
        }>;
      };

      for (const part of payload.candidates?.[0]?.content?.parts ?? []) {
        if (part.thought === true && part.text) {
          events.push({ type: 'thinking_delta', thinking: part.text });
        } else if (part.text) {
          events.push({ type: 'content_delta', content: part.text });
          gotContent = true;
        } else if (part.functionCall) {
          const name = part.functionCall.name ?? 'tool';
          const args = (part.functionCall.args ?? {}) as Record<string, unknown>;
          const fileEvent = tryEmitFileEdit(name, args);
          if (fileEvent) {
            events.push(fileEvent);
          } else {
            events.push({
              type: 'tool_executed',
              toolName: name,
              toolInput: JSON.stringify(args),
            });
          }
        }
      }
    } catch (err: unknown) {
      providerLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'malformed SSE log line — skip',
      );
      // malformed SSE line — skip
    }
  }

  return { events, gotContent };
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class AntigravityProvider implements Provider {
  readonly imageInputTransport = 'file' as const;
  readonly name = 'antigravity' as const;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    if (this.config.disabled) return false;
    const available = !!this.config.authToken || detectAntigravityCLILogin();
    if (available && Date.now() - cachedModelsAt > MODELS_CACHE_TTL_MS) {
      void refreshModelsInBackground();
    }
    return available;
  }

  listModels(): ModelDef[] {
    if (cachedModels && Date.now() - cachedModelsAt < MODELS_CACHE_TTL_MS) {
      return cachedModels;
    }
    if (cachedModels && cachedModels.length > 0) return cachedModels;
    const sync = tryFetchAgyModelsSync();
    if (sync && sync.length > 0) {
      cachedModels = buildAntigravityModels(sync, cachedQuota);
      cachedModelsAt = Date.now();
      return cachedModels;
    }
    void refreshModelsInBackground();
    return cachedModels ?? [];
  }

  /** Force-refresh the model list and quota from the live sources.
   *  Returns a promise so callers that await a catalog refresh actually wait
   *  for it; the registry only awaits thenables. */
  refreshModels(): Promise<ModelDef[]> {
    cachedModelsAt = 0;
    return refreshModelsInBackground();
  }

  /** Live per-group quota from the agy CLI's `/usage` command, keyed by group
   *  name (e.g. "Gemini Models", "Claude and GPT models"). Returns the cached
   *  quota if fresh, or triggers a background refresh. */
  getQuota(): Map<string, ModelQuota> | null {
    if (cachedQuota && Date.now() - cachedModelsAt < MODELS_CACHE_TTL_MS) {
      return cachedQuota;
    }
    void refreshModelsInBackground();
    return cachedQuota;
  }

  /** Live quota groups with full bucket detail (weekly + 5h limits).
   *  Returns the cached groups if fresh, or triggers a background refresh. */
  getQuotaGroups(): AntigravityQuotaGroup[] | null {
    return cachedQuotaGroups;
  }

  private resolveCliModel(modelId: string, reasoningLevel?: string): string | undefined {
    const models = this.listModels();
    const match = matchAgyModel(models, modelId);
    if (!match) {
      if (models[0]?.apiModelId) return models[0].apiModelId;
      if (modelId) {
        return modelId.startsWith(AGY_MODEL_ID_PREFIX)
          ? modelId.slice(AGY_MODEL_ID_PREFIX.length)
          : modelId;
      }
      return undefined;
    }
    // agy carries effort in the slug, so the composer's reasoning level (or the
    // tier baked into a pre-collapse model id) picks the row here.
    return (
      resolveAgyVariant(match.model, reasoningLevel ?? match.legacyEffort) ?? match.model.apiModelId
    );
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const researchOnly = request.capabilityProfile === 'research-only';
    const bin = whichBinary('agy');
    if (!bin) {
      yield {
        type: 'error',
        error: 'Antigravity CLI not found on PATH. Install it and run "agy auth", then reconnect.',
      };
      return;
    }
    if (!supportsPrivateTransport(bin)) {
      yield {
        type: 'error',
        error:
          'Antigravity is unavailable securely: this agy version lacks private stream input support. Update agy; Koryphaios will not expose prompts in process arguments.',
      };
      return;
    }

    // Resume the agy conversation tied to this Koryphaios session when we have
    // one — then only the NEW turn is sent (agy holds the prior history), which
    // avoids a fresh agentic session re-exploring the workspace every message.
    const providerConversationRevision = request.providerConversationRevision ?? 0;
    const cachedConversation = request.sessionId
      ? sessionConversations.get(request.sessionId)
      : undefined;
    let convId =
      !researchOnly &&
      canResumeAntigravityConversation(
        cachedConversation,
        providerConversationRevision,
        request.forceFreshConversation,
      )
        ? cachedConversation!.conversationId
        : undefined;
    if (
      request.sessionId &&
      cachedConversation &&
      !request.forceFreshConversation &&
      cachedConversation.providerConversationRevision !== providerConversationRevision
    ) {
      sessionConversations.delete(request.sessionId);
    }
    if (convId && !agyConvDb(convId)) {
      // agy pruned it — start a fresh conversation with full history.
      if (request.sessionId) sessionConversations.delete(request.sessionId);
      convId = undefined;
    }
    const convsBefore = convId ? null : listConversationIds();
    const rememberSessionConversation = (conversationId: string): void => {
      if (researchOnly || request.forceFreshConversation || !request.sessionId) return;
      sessionConversations.set(request.sessionId, {
        conversationId,
        providerConversationRevision,
      });
    };

    const attachmentScope = createCliAttachmentScope();
    const prompt = convId
      ? buildTurnPrompt(request.messages, attachmentScope)
      : buildPrompt(request.systemPrompt, request.messages, attachmentScope);
    if (!prompt.trim()) {
      attachmentScope.cleanup();
      yield { type: 'error', error: 'Antigravity: empty prompt' };
      return;
    }

    const cliModel = this.resolveCliModel(request.model, request.reasoningLevel);
    if (!cliModel) {
      attachmentScope.cleanup();
      yield {
        type: 'error',
        error: 'Antigravity did not report an available model for this account.',
      };
      return;
    }
    const promptArtifact = createPrivateCliTextArtifact('antigravity-prompt', prompt);
    const logArtifact = createPrivateCliTextArtifact('antigravity-log', '', 'log');
    const logPath = logArtifact.path;

    // ── Wire kory MCP server, hooks, and rules into the isolated agy home ──
    // Antigravity reads .gemini/config/{mcp_config,hooks}.json and AGENTS.md.
    // Writing these before each turn ensures the CLI discovers the kory__ tool
    // catalog, the PreToolUse enforcement layer, and Kory's session rules.
    const agyBridge = getCliBridge('antigravity');
    const bridgeGrantLease =
      !researchOnly && request.sessionId
        ? createKoryBridgeGrantLease(request.sessionId, request.harnessRole ?? 'manager')
        : undefined;
    const bridgeCtx = {
      provider: 'antigravity' as const,
      role: request.harnessRole ?? 'manager',
      sandbox: request.sandbox,
      workingDirectory: request.workingDirectory?.trim() || process.cwd(),
      sessionId: request.sessionId,
      systemPrompt: request.systemPrompt ?? '',
      tools: request.tools ?? [],
      bridgeGrantLease,
    };
    const agyHome = researchOnly
      ? join(getKoryphaiosAntigravityHome(), 'research-only')
      : getKoryphaiosAntigravityHome();
    const bridgeGrantDirectory =
      !researchOnly && bridgeCtx.sessionId
        ? bridgeGrantLease!.grant(['mcp:catalog', 'mcp:execute']).directory
        : null;
    const researchRoot = researchOnly
      ? mkdtempSync(join(tmpdir(), 'kory-web-research-agy-'))
      : null;
    const cwd = researchRoot ?? request.workingDirectory?.trim();
    ensureManagedCliDirectory(agyHome);
    if (!researchOnly) {
      // ── Enforce Koryphaios's policy inside agy's own permission engine ──
      // agy reads $GEMINI_DIR/antigravity-cli/settings.json, which the managed
      // ANTIGRAVITY_HOME relocates, so this is the real gate: headless turns
      // soft-deny anything not explicitly allowed, with no hook support
      // required. `--mode` is NOT a control (agy ignores it in print mode), and
      // the previous `.claude/hooks.json` was never loaded — that is not an agy
      // customization root and its shape/vocabulary were Claude Code's. Fail
      // closed instead of spawning an agent whose native tools Koryphaios has
      // not actually constrained.
      try {
        const settingsPath = join(agyHome, '.gemini', 'antigravity-cli', 'settings.json');
        const settingsDir = join(agyHome, '.gemini', 'antigravity-cli');
        ensureManagedCliDirectory(settingsDir);
        let existingSettings: Record<string, unknown> = {};
        if (existsSync(settingsPath)) {
          healManagedCliFile(settingsPath);
          try {
            existingSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
          } catch {
            existingSettings = {};
          }
        }
        // Koryphaios owns the permission-bearing keys; unrelated user settings
        // in the staged home (theme, trusted workspaces) are preserved.
        const enforced = buildAntigravitySettings({ workspacePath: cwd });
        writeManagedCliFile(
          settingsPath,
          JSON.stringify({ ...existingSettings, ...enforced }, null, 2),
        );

        // Redirector: name the kory__ equivalent so a refused native call is
        // recovered by the agent instead of retried or abandoned. Global hooks
        // location, so a turn never writes into the user's checkout.
        const hookScript = process.env.KORY_HOOK_BRIDGE_SCRIPT;
        if (!hookScript) {
          throw new Error('KORY_HOOK_BRIDGE_SCRIPT is not configured');
        }
        if (!bridgeGrantDirectory) {
          throw new Error('Antigravity turn has no authenticated bridge grant');
        }
        const hooksDir = join(agyHome, '.gemini', 'config');
        ensureManagedCliDirectory(hooksDir);
        const hooksPath = join(hooksDir, 'hooks.json');
        if (existsSync(hooksPath)) healManagedCliFile(hooksPath);
        writeManagedCliFile(
          hooksPath,
          buildAntigravityHooks({
            hookScript,
            authFile: bridgeGrantLease!.grant(['hook:pre-tool']).path,
          }),
        );
      } catch (enforcementErr) {
        attachmentScope.cleanup();
        promptArtifact.cleanup();
        yield {
          type: 'error',
          error:
            'Antigravity: refusing to start the turn because Koryphaios could not apply its permission policy to the CLI.',
        };
        providerLog.error(
          { err: enforcementErr, provider: 'antigravity' },
          'Antigravity permission enforcement failed closed',
        );
        return;
      }

      try {
        // MCP: agy reads $GEMINI_DIR/config/mcp_config.json. It does NOT read
        // .claude.json (nor .agents/mcp.json), which is why the kory__ catalog
        // never used to appear. `agy mcp list` reports servers from this file.
        const mcpConfigs = agyBridge?.buildMcpConfig(bridgeCtx);
        if (mcpConfigs && mcpConfigs.length > 0) {
          const mcpConfigDir = join(agyHome, '.gemini', 'config');
          ensureManagedCliDirectory(mcpConfigDir);
          const mcpConfigPath = join(mcpConfigDir, 'mcp_config.json');
          if (existsSync(mcpConfigPath)) healManagedCliFile(mcpConfigPath);
          let existing: { mcpServers?: Record<string, unknown> } = {};
          if (existsSync(mcpConfigPath)) {
            try {
              existing = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
            } catch {
              existing = {};
            }
          }
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
        // Rules: write AGENTS.md with the Kory session rules.
        const ruleFiles = agyBridge?.buildRules(bridgeCtx);
        if (ruleFiles) {
          for (const rule of ruleFiles) {
            writeManagedCliFile(rule.path, rule.content);
          }
        }
      } catch (wiringErr) {
        providerLog.warn(
          { err: wiringErr, provider: 'antigravity' },
          'Failed to wire kory MCP/rules for Antigravity',
        );
      }
    }

    // No `--mode` here on purpose. agy logs "Print mode: --mode <x> is not
    // supported headless" and continues in the default mode, so the flag never
    // constrained anything. Plan/read-only posture is enforced by the
    // permission rules written above, which do apply headlessly, and by the
    // session policy applied to kory__ bridge calls.
    const args = [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--model',
      cliModel,
      '--sandbox',
      '--log-file',
      logPath,
      ...(convId ? ['--conversation', convId] : []),
      // agy scopes its workspace via --add-dir (process cwd alone is ignored
      // for tool resolution — verified: it listed $HOME instead of cwd).
      ...(cwd ? ['--add-dir', cwd] : []),
    ];

    // Run in the session's project directory when one is set so the CLI sees
    // the real workspace; fall back to a neutral temp dir otherwise.
    // OS-keyring OAuth: agy's tokens live behind the D-Bus user bus, so the
    // jailed child needs the address, the runtime dir, and the bound socket.
    const userBus = hostUserBusSocket();
    const baseEnv = buildProviderCliEnv('antigravity', {
      HOME: agyHome,
      USERPROFILE: agyHome,
      ANTIGRAVITY_HOME: agyHome,
      // The soft jail replaces HOME. agy resolves auth, permissions, hooks and
      // MCP via GEMINI_DIR, so keep that root on the prepared managed config.
      GEMINI_DIR: join(agyHome, '.gemini'),
      ...(userBus
        ? {
            DBUS_SESSION_BUS_ADDRESS: userBus.address,
            XDG_RUNTIME_DIR: userBus.runtimeDir,
          }
        : {}),
    });
    // The soft jail replaces HOME with an empty temp dir, and agy resolves its
    // GeminiDir from HOME — ANTIGRAVITY_HOME does NOT relocate it. Exposing
    // only `agyHome` here linked it as <jailHome>/antigravity-home, which agy
    // never looks at, so the child found no OAuth token and every turn fell
    // into the browser sign-in flow and failed auth. Link the `.gemini`
    // directory itself, which is what `$HOME/.gemini` must resolve to: that
    // carries the credential, the enforced permission settings, the hooks, and
    // the MCP registration in one shot.
    const jail = request.sandbox ? buildSoftJail(baseEnv, [join(agyHome, '.gemini')]) : null;
    // The isolated home carries symlinks to the real ~/.gemini OAuth material,
    // so the real config dir must be visible read-only inside the jail or the
    // links dangle and agy reports "Please sign in". homeDir keeps bwrap HOME
    // on the isolated home (where .gemini/config/MCP wiring was just written)
    // instead of defaulting to the project directory.
    const realGeminiDir = join(homedir(), '.gemini');
    const wrapped = request.sandbox
      ? wrapCommand(bin, args, {
          cwd: cwd || tmpdir(),
          homeDir: agyHome,
          configDirs: [
            agyHome,
            ...(jail?.env.HOME ? [jail.env.HOME] : []),
            ...(bridgeGrantDirectory ? [bridgeGrantDirectory] : []),
            promptArtifact.directory,
            logArtifact.directory,
            ...attachmentScope.artifacts.map((artifact) => artifact.directory),
          ],
          readonlyConfigDirs: existsSync(realGeminiDir) ? [realGeminiDir] : [],
          sockets: userBus ? [userBus.socket] : [],
          // The CLI child is the inference transport — it must reach the
          // model endpoint. See inferenceSandboxPolicy.
          policy: inferenceSandboxPolicy(request.sandbox),
        })
      : { command: bin, args };
    assertPrivateValuesAbsentFromArgv(wrapped.args, [prompt, request.systemPrompt]);
    // agy's OS-keyring login also depends on HOME. Keep it on the managed
    // home; the soft jail still supplies scrubbed env and private temp/XDG
    // roots, and the OS sandbox confines both writable config trees.
    const agyEnv = { ...(jail?.env ?? baseEnv), HOME: agyHome, USERPROFILE: agyHome };
    const child = spawnWithPrivateArtifactCleanup(
      () =>
        spawn(wrapped.command, wrapped.args, {
          cwd: cwd || tmpdir(),
          stdio: ['pipe', 'pipe', 'pipe'],
          env: agyEnv,
        }),
      [promptArtifact, ...attachmentScope.artifacts],
      () => {
        logArtifact.cleanup();
        bridgeGrantLease?.cleanup();
      },
    );
    bridgeGrantLease?.bindToChild(child);

    // Send the prompt over stream-json stdin transport (zero private tokens in argv)
    const streamInputPayload =
      JSON.stringify({
        event: 'user',
        message: { content: prompt },
      }) + '\n';
    child.stdin.end(streamInputPayload, 'utf8');

    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch (err: unknown) {
        providerLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'child already gone on abort',
        );
        /* already gone */
      }
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    child.once('close', () => {
      jail?.cleanup();
      if (researchRoot) rmSync(researchRoot, { recursive: true, force: true });
    });

    const timeout = setTimeout(() => {
      providerLog.warn({ provider: 'antigravity' }, 'Antigravity harness timed out — killing CLI');
      onAbort();
    }, AGY_TIMEOUT_MS);
    timeout.unref?.();

    let stdout = '';
    let stderr = '';
    // Live stdout queue: agy --print writes progressively — stream each chunk
    // the moment it lands instead of dumping the whole reply at exit.
    let stdoutLineBuffer = '';
    child.stdout.on('data', (c: Buffer) => {
      const text = c.toString();
      stdout += text;
      stdoutLineBuffer += text;
    });
    child.stderr.on('data', (c: Buffer) => (stderr = appendPrivateDiagnostic(stderr, c)));

    const exitPromise = new Promise<number>((resolve) => {
      child.once('error', () => resolve(-1));
      child.once('exit', (code) => resolve(code ?? 0));
    });

    // Tail the log file, parse Gemini SSE JSON, emit real streaming events.
    let logOffset = 0;
    let totalContentEvents = 0;
    let emittedStdout = false;
    let streamError: ProviderEvent | undefined;
    // Primary live source: agy's own brain transcript (responses + tools).
    const transcriptTail = newTranscriptTail(() => stdout, convId);
    // Reasoning source: the trajectory store (proto field 20.3 of model steps).
    const trajectoryTail = newTrajectoryTail(convId);
    // Thinking from the SSE log is the primary reasoning stream; the trajectory
    // db is the fallback — never mix both or reasoning shows twice/erratically.
    let sseThinkingEvents = 0;

    const drainStdout = (final = false): ProviderEvent[] => {
      const events: ProviderEvent[] = [];
      const lines = stdoutLineBuffer.split('\n');
      stdoutLineBuffer = final ? '' : (lines.pop() ?? '');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line.trim()) as { event?: string; conversation_id?: string };
          if (parsed.conversation_id && !convId) {
            convId = parsed.conversation_id;
            rememberSessionConversation(parsed.conversation_id);
            transcriptTail.convId = parsed.conversation_id;
            trajectoryTail.convId = parsed.conversation_id;
          }
        } catch {
          /* ignore non-json */
        }
        events.push(...parseAntigravityStreamLine(line));
      }
      if (final && stdoutLineBuffer.trim()) {
        try {
          const parsed = JSON.parse(stdoutLineBuffer.trim()) as {
            event?: string;
            conversation_id?: string;
          };
          if (parsed.conversation_id && !convId) {
            convId = parsed.conversation_id;
            rememberSessionConversation(parsed.conversation_id);
            transcriptTail.convId = parsed.conversation_id;
            trajectoryTail.convId = parsed.conversation_id;
          }
        } catch {
          /* ignore non-json */
        }
        events.push(...parseAntigravityStreamLine(stdoutLineBuffer));
        stdoutLineBuffer = '';
      }
      return events;
    };

    const rememberConversation = () => {
      if (researchOnly || convId || !convsBefore) return;
      const found = detectNewConversation(convsBefore);
      if (found) {
        convId = found;
        rememberSessionConversation(found);
        // Focus the tailers on the discovered conversation.
        transcriptTail.convId = found;
        trajectoryTail.convId = found;
      }
    };

    const drainLog = (): ProviderEvent[] => {
      try {
        const full = readFileSync(logPath, 'utf-8');
        const newChunk = full.slice(logOffset);
        if (!newChunk) return [];
        logOffset = full.length;
        const { events, gotContent } = parseLogChunk(newChunk);
        if (gotContent) totalContentEvents++;
        sseThinkingEvents += events.filter((e) => e.type === 'thinking_delta').length;
        return events;
      } catch (err: unknown) {
        providerLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'failed to read/drain agy log file',
        );
        return [];
      }
    };

    // Poll while agy runs, yielding events as they arrive.
    while (true) {
      const result = await Promise.race([
        exitPromise.then((code) => ({ done: true as const, code })),
        new Promise<{ done: false }>((res) =>
          setTimeout(() => res({ done: false }), LOG_POLL_INTERVAL_MS),
        ),
      ]);

      rememberConversation();
      const stdoutEvents = drainStdout();
      if (stdoutEvents.length > 0) emittedStdout = true;
      for (const event of stdoutEvents) {
        if (event.type === 'error') {
          streamError ??= event;
          continue;
        }
        if (event.type === 'content_delta') totalContentEvents++;
        yield event;
      }
      for (const event of drainLog()) yield event;
      if (sseThinkingEvents === 0) {
        for (const event of drainTrajectoryThinking(trajectoryTail)) yield event;
      }
      for (const event of drainTranscript(transcriptTail)) {
        if (event.type === 'content_delta') totalContentEvents++;
        yield event;
      }

      if (result.done) {
        const finalStdoutEvents = drainStdout(true);
        if (finalStdoutEvents.length > 0) emittedStdout = true;
        for (const event of finalStdoutEvents) {
          if (event.type === 'error') {
            streamError ??= event;
            continue;
          }
          if (event.type === 'content_delta') totalContentEvents++;
          yield event;
        }
        // Drain any final log/transcript bytes written before shutdown.
        for (const event of drainLog()) yield event;
        // The transcript's final lines can land marginally after exit.
        await new Promise((r) => setTimeout(r, 400));
        rememberConversation();
        if (sseThinkingEvents === 0) {
          for (const event of drainTrajectoryThinking(trajectoryTail)) yield event;
        }
        for (const event of drainTranscript(transcriptTail)) {
          if (event.type === 'content_delta') totalContentEvents++;
          yield event;
        }
        clearTimeout(timeout);
        request.signal?.removeEventListener('abort', onAbort);

        logArtifact.cleanup();

        if (request.signal?.aborted) return;

        if (streamError) {
          yield streamError;
          return;
        }

        if (result.code === -1) {
          yield { type: 'error', error: 'Antigravity: failed to launch the agy CLI process.' };
          return;
        }

        const text = stdout.trim();
        if (result.code !== 0 && totalContentEvents === 0) {
          const failure = providerStreamFailure('antigravity', 'stderr', stderr, {
            exitCode: result.code,
          });
          providerLog.warn(failure.diagnostic, 'Antigravity CLI exited unsuccessfully');
          yield {
            ...failure.event,
            error: safeProviderFailureMessage('antigravity', failure.diagnostic, {
              authenticationAction: 'Run "agy auth", then reconnect.',
            }),
          };
          return;
        }

        // Last resort: nothing streamed at all but stdout has text (shouldn't
        // happen — kept as a safety net).
        if (totalContentEvents === 0 && !emittedStdout && text) {
          yield* chunkText(text);
        }

        yield { type: 'complete', finishReason: 'end_turn' };
        return;
      }
    }
  }
}

function* chunkText(text: string): Generator<ProviderEvent> {
  const CHUNK_SIZE = 8;
  const words = text.split(/(\s+)/);
  let buf = '';
  let wordCount = 0;
  for (const token of words) {
    buf += token;
    if (!/^\s+$/.test(token)) wordCount++;
    if (wordCount >= CHUNK_SIZE) {
      yield { type: 'content_delta', content: buf };
      buf = '';
      wordCount = 0;
    }
  }
  if (buf) yield { type: 'content_delta', content: buf };
}

// ── Live transcript tailer ───────────────────────────────────────────────────
// The agy CLI writes a full JSONL transcript of every run to its local "brain"
// store (~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/
// transcript_full.jsonl): model responses, every tool call with output,
// errors, subagent spawns — appended live as steps complete. Tailing it gives
// Koryphaios the same real-time visibility the Antigravity app has, from the
// CLI's own artifacts (no API access, no auth games).

// ── Trajectory thinking extraction ──────────────────────────────────────────
// The reasoning text ("collapsible thinking" in the Antigravity app) is NOT in
// the JSONL transcript — it lives in the conversation trajectory SQLite, in
// model-response steps (step_type 15), protobuf field path 20.3. We decode the
// proto generically (wire format only, no schema needed) and stream it.

/** Walk protobuf wire format collecting [fieldPath, string] pairs. */
function protoStrings(buf: Uint8Array, prefix = ''): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let i = 0;
  const readVarint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      if (i >= buf.length) throw new Error('eof');
      const b = buf[i++];
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  while (i < buf.length) {
    let key: number;
    try {
      key = readVarint();
    } catch (err: unknown) {
      providerLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'protobuf varint eof',
      );
      break;
    }
    const field = Math.floor(key / 8);
    const wire = key & 7;
    try {
      if (wire === 0) readVarint();
      else if (wire === 2) {
        const len = readVarint();
        if (len < 0 || i + len > buf.length) break;
        const data = buf.subarray(i, i + len);
        i += len;
        const path = prefix ? `${prefix}.${field}` : String(field);
        let asText: string | null = null;
        if (len > 0) {
          try {
            const t = new TextDecoder('utf-8', { fatal: true }).decode(data);
            // Heuristic: leading chars must be printable — otherwise treat as
            // a nested message and recurse.
            const head = t.slice(0, 80);
            if (/^[\x20-\x7e\n\t\r]*$/.test(head)) asText = t;
          } catch (err: unknown) {
            providerLog.debug(
              { err: err instanceof Error ? err.message : String(err) },
              'protobuf field not utf-8',
            );
            /* not utf-8 */
          }
        }
        if (asText !== null) out.push([path, asText]);
        else out.push(...protoStrings(data, path));
      } else if (wire === 5) i += 4;
      else if (wire === 1) i += 8;
      else break;
    } catch (err: unknown) {
      providerLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'protobuf wire parse error',
      );
      break;
    }
  }
  return out;
}

interface TrajectoryTailState {
  spawnedAt: number;
  /** Known agy conversation id — when set, only that db is polled. */
  convId?: string;
  /** Highest step idx per db that is fully consumed AND closed (a later step
   *  exists). The newest row is deliberately NOT finalized: agy grows its
   *  step_payload in place while the model streams (verified: 287→1625 bytes
   *  over ~2.5s), so it must be re-read every poll. */
  finalizedIdx: Map<string, number>;
  /** chars of thinking already emitted per `${file}:${idx}` row */
  emittedLen: Map<string, number>;
}

function newTrajectoryTail(convId?: string): TrajectoryTailState {
  const state: TrajectoryTailState = {
    spawnedAt: Date.now(),
    convId,
    finalizedIdx: new Map(),
    emittedLen: new Map(),
  };
  // Resuming an existing conversation: its db already holds every prior turn's
  // steps — seed past them so old reasoning isn't replayed into this turn.
  if (convId) {
    const file = agyConvDb(convId);
    if (!file) return state;
    try {
      const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
      const db = new Database(file, { readonly: true });
      try {
        const row = db.query('select max(idx) as m from steps').get() as { m: number | null };
        if (row?.m != null) state.finalizedIdx.set(file, row.m);
      } finally {
        db.close();
      }
    } catch (err: unknown) {
      providerLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'db missing/locked seeding trajectory tail',
      );
      /* db missing/locked — worst case we re-emit prior-turn thinking once */
    }
  }
  return state;
}

/** Concatenated reasoning text (proto field …20.3) of a model-response step. */
function stepThinkingText(payload: Uint8Array): string {
  let out = '';
  for (const [path, text] of protoStrings(payload)) {
    // 20.3 = reasoning text (20.1/20.8 are the final answer, streamed
    // elsewhere; 20.14 is the encrypted thought signature).
    if (path.endsWith('20.3')) out += text;
  }
  return out;
}

/** Poll live conversation dbs for new model-response steps; extract thinking. */
function drainTrajectoryThinking(state: TrajectoryTailState): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  let dbs: string[] = [];
  if (state.convId) {
    // Exact conversation known — no mtime-window guessing across all dbs.
    const f = agyConvDb(state.convId);
    if (f) dbs = [f];
  } else {
    try {
      dbs = agyConvDirs()
        .flatMap((dir) => {
          try {
            return readdirSync(dir)
              .filter((f) => f.endsWith('.db'))
              .map((f) => join(dir, f));
          } catch {
            return [];
          }
        })
        .filter((f) => {
          if (state.finalizedIdx.has(f)) return true;
          try {
            return statSync(f).mtimeMs >= state.spawnedAt - 2_000;
          } catch (err: unknown) {
            providerLog.debug(
              { err: err instanceof Error ? err.message : String(err) },
              'stat failed for conversation db',
            );
            return false;
          }
        });
    } catch (err: unknown) {
      providerLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'failed to list conversation dbs',
      );
      return events;
    }
  }
  for (const file of dbs) {
    try {
      // Bun's sqlite reads WAL-mode dbs fine in readonly.
      const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
      const db = new Database(file, { readonly: true });
      try {
        const fin = state.finalizedIdx.get(file) ?? -1;
        // idx > fin includes the newest (still-growing) row every poll — its
        // payload streams in place, so we diff and emit only the new suffix.
        const rows = db
          .query('select idx, step_type, step_payload from steps where idx > ? order by idx')
          .all(fin) as Array<{ idx: number; step_type: number; step_payload: Uint8Array | null }>;
        if (rows.length === 0) continue;
        for (const row of rows) {
          if (row.step_type !== 15 || !row.step_payload) continue;
          const full = stepThinkingText(new Uint8Array(row.step_payload));
          const key = `${file}:${row.idx}`;
          const prev = state.emittedLen.get(key) ?? 0;
          if (full.length > prev) {
            events.push({ type: 'thinking_delta', thinking: full.slice(prev) });
            state.emittedLen.set(key, full.length);
          }
        }
        // Everything below the newest row can no longer change.
        const maxIdx = rows[rows.length - 1].idx;
        if (maxIdx - 1 > fin) state.finalizedIdx.set(file, maxIdx - 1);
      } finally {
        db.close();
      }
    } catch (err: unknown) {
      providerLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'db busy/locked this tick — retry next poll',
      );
      /* db busy/locked this tick — retry next poll */
    }
  }
  return events;
}

const AGY_TOOL_TYPES = new Set([
  'RUN_COMMAND',
  'VIEW_FILE',
  'LIST_DIRECTORY',
  'GREP_SEARCH',
  'CODE_ACTION',
  'SEARCH_WEB',
  'READ_URL_CONTENT',
  'GENERIC',
  'INVOKE_SUBAGENT',
  'MANAGE_TASK',
  'GENERATE_IMAGE',
  'IMAGE_GENERATION',
]);

interface TranscriptTailState {
  /** byte offsets per transcript file */
  offsets: Map<string, number>;
  spawnedAt: number;
  emittedContent: boolean;
  /** Known agy conversation id — when set, only its transcript is tailed. */
  convId?: string;
  /** Live stdout text so far — used to skip transcript responses the user
   *  already saw streaming (the final answer is printed to stdout too). */
  stdoutSoFar: () => string;
}

function transcriptPath(convId: string): string {
  for (const brainDir of agyBrainDirs()) {
    const candidate = join(brainDir, convId, '.system_generated', 'logs', 'transcript_full.jsonl');
    if (existsSync(candidate)) return candidate;
  }
  return join(agyBrainDirs()[0], convId, '.system_generated', 'logs', 'transcript_full.jsonl');
}

function newTranscriptTail(stdoutSoFar: () => string, convId?: string): TranscriptTailState {
  const state: TranscriptTailState = {
    offsets: new Map(),
    spawnedAt: Date.now(),
    emittedContent: false,
    convId,
    stdoutSoFar,
  };
  // Resuming: skip the transcript content from earlier turns.
  if (convId) {
    const f = transcriptPath(convId);
    try {
      state.offsets.set(f, statSync(f).size);
    } catch (err: unknown) {
      providerLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'transcript not created yet',
      );
      /* transcript not created yet */
    }
  }
  return state;
}

/** Transcript files touched since this run started. */
function findLiveTranscripts(state: TranscriptTailState): string[] {
  if (state.convId) {
    const f = transcriptPath(state.convId);
    return existsSync(f) ? [f] : [];
  }
  const out: string[] = [];
  for (const brainDir of agyBrainDirs()) {
    let ids: string[];
    try {
      ids = readdirSync(brainDir);
    } catch (err: unknown) {
      providerLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'brain dir absent — older agy or different install',
      );
      continue;
    }
    for (const id of ids) {
      const f = join(brainDir, id, '.system_generated', 'logs', 'transcript_full.jsonl');
      try {
        if (state.offsets.has(f) || statSync(f).mtimeMs >= state.spawnedAt - 2_000) out.push(f);
      } catch (err: unknown) {
        providerLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'no transcript in this brain dir',
        );
        /* no transcript in this brain dir */
      }
    }
  }
  return out;
}

/** Read new complete lines from a transcript, mapped to provider events. */
function drainTranscript(state: TranscriptTailState): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  for (const file of findLiveTranscripts(state)) {
    try {
      const start = state.offsets.get(file) ?? 0;
      const fd = openSync(file, 'r');
      const size = fstatSync(fd).size;
      if (size <= start) {
        closeSync(fd);
        continue;
      }
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      closeSync(fd);
      const text = buf.toString('utf-8');
      // Only consume complete lines; partial tail re-reads next poll.
      const lastNl = text.lastIndexOf('\n');
      if (lastNl === -1) continue;
      state.offsets.set(file, start + Buffer.byteLength(text.slice(0, lastNl + 1), 'utf-8'));
      for (const line of text.slice(0, lastNl).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const row = JSON.parse(trimmed) as {
            type?: string;
            source?: string;
            content?: string;
            created_at?: string;
          };
          const kind = row.type ?? '';
          const content = (row.content ?? '').trim();
          if (kind === 'PLANNER_RESPONSE' && content) {
            // The FINAL response is also printed to stdout (already streamed
            // live) — only surface transcript responses the user hasn't seen.
            const probe = content.slice(0, 200);
            if (!state.stdoutSoFar().includes(probe)) {
              events.push({
                type: 'content_delta',
                content: state.emittedContent ? `\n\n${content}` : content,
              });
              state.emittedContent = true;
            }
          } else if (kind === 'ERROR_MESSAGE' && content) {
            events.push({
              type: 'tool_executed',
              toolName: 'antigravity',
              toolInput: '{}',
              toolOutput: content.slice(0, 4_000),
              isError: true,
            });
          } else if (AGY_TOOL_TYPES.has(kind) && content) {
            events.push({
              type: 'tool_executed',
              toolName: kind.toLowerCase(),
              toolInput: '{}',
              toolOutput: content.slice(0, 4_000),
            });
          }
          // USER_INPUT / EPHEMERAL_MESSAGE / SYSTEM_MESSAGE / CHECKPOINT /
          // CONVERSATION_HISTORY are prompt plumbing — not surfaced.
        } catch (err: unknown) {
          providerLog.debug(
            { err: err instanceof Error ? err.message : String(err) },
            'partial or non-JSON transcript line',
          );
          /* partial or non-JSON line */
        }
      }
    } catch (err: unknown) {
      providerLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'transcript file rotated/unreadable this tick',
      );
      /* file rotated/unreadable this tick — retry next poll */
    }
  }
  return events;
}

// The agy CLI has no flag to disable native subagent/delegation behavior, so the
// only lever is the prompt: delegation belongs to the Koryphaios layer.
const HARNESS_SYSTEM_NOTE =
  'You are running inside the Koryphaios orchestrator. Never spawn subagents or delegate ' +
  'to other agents yourself; if work should be parallelized or delegated, say so in your ' +
  'response and Koryphaios will dispatch its own worker agents. Do not start background ' +
  'tasks that require a later notification: complete the requested work in this turn and ' +
  'always finish with a concise user-facing answer.';

function buildPrompt(
  systemPrompt: string | undefined,
  messages: ProviderMessage[],
  attachments: CliAttachmentScope,
): string {
  const lines: string[] = [];
  // Use the AntigravityCliBridge's harness note for consistency (Phase 1).
  const agyBridge = getCliBridge('antigravity');
  const bridgeConfig = agyBridge?.buildAgentConfig({
    provider: 'antigravity',
    role: 'manager',
    sandbox: undefined,
    workingDirectory: process.cwd(),
    systemPrompt: systemPrompt ?? '',
    tools: [],
  });
  const harnessNote = bridgeConfig?.systemInstructions?.[1] ?? HARNESS_SYSTEM_NOTE;
  lines.push(systemPrompt?.trim() ? `${systemPrompt.trim()}\n\n${harnessNote}` : harnessNote, '');
  const turns = messages.filter((m) => m.role !== 'system');

  if (turns.length === 1 && turns[0].role === 'user' && lines.length === 0) {
    return attachments.renderContent(turns[0].content);
  }

  for (const m of turns) {
    const text = attachments.renderContent(m.content);
    if (!text.trim()) continue;
    const label = m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool result' : 'User';
    lines.push(`${label}: ${text}`);
  }
  return lines.join('\n\n');
}

/** Prompt for a resumed conversation: only the turns since the last assistant
 *  reply — agy already holds the earlier history in its own conversation. */
function buildTurnPrompt(messages: ProviderMessage[], attachments: CliAttachmentScope): string {
  const turns = messages.filter((m) => m.role !== 'system');
  let start = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'assistant') {
      start = i + 1;
      break;
    }
  }
  const fresh = turns.slice(start);
  if (fresh.length === 1 && fresh[0].role === 'user')
    return attachments.renderContent(fresh[0].content);
  return fresh
    .map((m) => {
      const text = attachments.renderContent(m.content);
      if (!text.trim()) return '';
      const label = m.role === 'tool' ? 'Tool result' : 'User';
      return `${label}: ${text}`;
    })
    .filter(Boolean)
    .join('\n\n');
}
