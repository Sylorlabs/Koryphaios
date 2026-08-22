// CLI usage readers — real local data written by the agent CLIs themselves.
//
// Subscription CLIs are flat-rate, so instead of dollars-spent we report:
//   • token usage over hourly / daily / weekly / monthly windows
//   • the provider's OWN quota state (% burned + reset time) where the CLI
//     records it locally (Codex writes rate_limits into every session log)
//   • the raw inference API model equivalent for each CLI model (apiModelId)
//     so users can see what subscription models map to on the backing API
//
// Sources verified on-disk:
//   claude       ~/.claude/projects/**/*.jsonl              message.usage + message.model
//   codex        ~/.codex/sessions/**/*.jsonl               token_count events + rate_limits
//   copilot      ~/.copilot/session-state/<uuid>/events.jsonl  modelMetrics usage totals
//   grok         ~/.grok/sessions/<cwd>/<session>/signals.json  contextTokensUsed + modelsUsed
//   antigravity  credit-accountant DB + live /usage command  (protobuf transcripts not parseable)
//   cursor       credit-accountant DB                         (agent-transcripts have no token counts)
//   devin        ~/.local/share/devin/cli/transcripts/*.json  ATIF final_metrics (session totals)
//   cline        ~/.cline/data/sessions/<id>/*.messages.json  per-message metrics + modelInfo
//   kimicode     ~/.kimi/sessions/<hash>/<uuid>/wire.jsonl    StatusUpdate token_usage events
//   freebuff     detected-only (fail-closed; no usage recorded)
//   jules        detected-only (approval-required; no local usage)
//
// Quota state: claude, codex, copilot, and antigravity expose live quota
// endpoints or local rate_limit records. cursor, devin, cline, and kimicode
// return empty quotas because their CLIs don't expose a local quota state —
// usage limits are enforced server-side by the backing API and are not
// written to disk in a parseable form.

import { readdirSync, statSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { readdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ProviderName } from '@koryphaios/shared';
import { discoverCliAccounts, type DiscoveredCliAccount } from '../providers/cli-accounts';
import { CodexAppServer } from '../providers/codex-app-server';
import { getUsageSamplesByProvider } from '../credit-accountant';
import { getContext } from '../context';
import { serverLog } from '../logger';
import {
  detectFreebuffCLILogin,
  detectJulesApiKey,
} from '../providers/auth-utils';

export interface UsageWindow {
  /** 'hour' | 'day' | 'week' | 'month' */
  period: string;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
}

export interface QuotaWindow {
  label: string;
  usedPercent: number;
  resetsAt: number | null; // epoch ms
  windowMinutes: number | null;
}

export interface CliUsageReport {
  provider: string;
  accountId?: string;
  accountLabel?: string;
  accountEmail?: string;
  available: boolean;
  /** Whether the local session files can be attributed to this exact profile. */
  attribution: 'account' | 'unavailable';
  attributionNote?: string;
  planType?: string;
  /** Current account-wide credit balance when the official Codex CLI reports one. */
  creditBalance?: string | null;
  /** Provenance for the activity time series. */
  usageSource?: 'local-session-history' | 'codex-app-server';
  windows: UsageWindow[];
  /** Calendar-day token totals from the same local CLI session records. */
  dailyUsage: Array<{ date: string; tokens: number }>;
  quotas: QuotaWindow[];
  byModel: Array<{
    model: string;
    tokensIn: number;
    tokensOut: number;
    /** The raw inference API model ID this CLI model maps to (e.g. claude-sonnet-4-5-20250929). */
    apiEquivalent?: string;
    /** The API provider that serves the equivalent model (e.g. anthropic, openai, google). */
    apiProvider?: string;
  }>;
  /** The backing API provider name for this CLI subscription (e.g. anthropic for claude). */
  apiProviderName?: string;
  updatedAt: number;
}

const WINDOWS_MS: Array<[string, number]> = [
  ['hour', 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
];
const SCAN_HORIZON_MS = 31 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Kimi Code's wire.jsonl StatusUpdate events don't carry a per-turn model
// name. The kimi CLI's config.toml has default_model = "" (API default). We
// try to resolve the live default from the KimiCode provider's catalog at
// runtime; if the catalog is unavailable, fall back to this constant.
const KIMI_DEFAULT_MODEL = 'kimi-k2';

export interface UsageSample {
  ts: number;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
}

function isReportedModel(model: string): boolean {
  const value = model.trim();
  return (
    value.length > 0 &&
    !value.startsWith('<') &&
    !/(?:^|[-_])(unknown|synthetic|null|undefined)$/i.test(value)
  );
}

function hasReportedUsage(samples: UsageSample[]): boolean {
  return samples.some(
    (sample) => isReportedModel(sample.model) && (sample.tokensIn > 0 || sample.tokensOut > 0),
  );
}

let cached: { at: number; reports: CliUsageReport[] } | null = null;
let inFlight: Promise<CliUsageReport[]> | null = null;
const CACHE_TTL_MS = 60_000;

async function* walkJsonlAsync(root: string, newerThan: number): AsyncGenerator<string> {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err: unknown) {
      // Expected: directory may vanish between existsSync and readdir, or be
      // unreadable. Skipping it is safe — we just lose those session files.
      serverLog.debug(
        { dir, err: err instanceof Error ? err.message : String(err) },
        'walkJsonlAsync: readdir skipped',
      );
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.endsWith('.jsonl')) {
        try {
          if ((await stat(full)).mtimeMs >= newerThan) yield full;
        } catch (err: unknown) {
          // Expected: file was removed or renamed between readdir and stat.
          serverLog.debug(
            { full, err: err instanceof Error ? err.message : String(err) },
            'walkJsonlAsync: stat skipped (raced)',
          );
        }
      }
    }
  }
}

function* walkJsonl(root: string, newerThan: number): Generator<string> {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err: unknown) {
      serverLog.debug(
        { dir, err: err instanceof Error ? err.message : String(err) },
        'walkJsonl: readdir skipped',
      );
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith('.jsonl')) {
        try {
          if (statSync(full).mtimeMs >= newerThan) yield full;
        } catch (err: unknown) {
          serverLog.debug(
            { full, err: err instanceof Error ? err.message : String(err) },
            'walkJsonl: stat skipped (raced)',
          );
        }
      }
    }
  }
}

function windowsFromSamples(samples: UsageSample[], now: number): UsageWindow[] {
  return WINDOWS_MS.map(([period, ms]) => {
    let tokensIn = 0,
      tokensOut = 0,
      cacheRead = 0;
    for (const s of samples) {
      if (now - s.ts > ms || !isReportedModel(s.model)) continue;
      tokensIn += s.tokensIn;
      tokensOut += s.tokensOut;
      cacheRead += s.cacheRead;
    }
    return { period, tokensIn, tokensOut, cacheRead };
  });
}

function dailyUsageFromSamples(
  samples: UsageSample[],
  now: number,
  days = 30,
): CliUsageReport['dailyUsage'] {
  const end = new Date(now);
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  const startDay = endDay - (days - 1) * DAY_MS;
  const totals = new Map<string, number>();
  for (const sample of samples) {
    if (!isReportedModel(sample.model) || sample.ts < startDay || sample.ts >= endDay + DAY_MS)
      continue;
    const date = new Date(sample.ts).toISOString().slice(0, 10);
    totals.set(date, (totals.get(date) ?? 0) + sample.tokensIn + sample.tokensOut);
  }
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(startDay + index * DAY_MS).toISOString().slice(0, 10);
    return { date, tokens: totals.get(date) ?? 0 };
  });
}

function windowsFromDailyUsage(
  dailyUsage: Array<{ date: string; tokens: number }>,
  now: number,
): UsageWindow[] {
  const today = new Date(now).toISOString().slice(0, 10);
  return WINDOWS_MS.map(([period, ms]) => {
    const cutoff = new Date(now - ms).toISOString().slice(0, 10);
    const tokens = dailyUsage
      .filter((entry) => entry.date >= cutoff && entry.date <= today)
      .reduce((sum, entry) => sum + entry.tokens, 0);
    return { period, tokensIn: tokens, tokensOut: 0, cacheRead: 0 };
  });
}

/** Resolves a CLI-local model name to its raw inference API equivalent.
 *  Returns `{ apiEquivalent, apiProvider }` when the provider's model catalog
 *  contains a matching entry (by id, apiModelId, or realModelId); otherwise
 *  the fields are omitted so the UI can show "—" rather than a fabricated id. */
export type ApiEquivalentResolver = (
  model: string,
) => { apiEquivalent?: string; apiProvider?: string } | null;

export function byModelFromSamples(
  samples: UsageSample[],
  now: number,
  resolveApi?: ApiEquivalentResolver,
): CliUsageReport['byModel'] {
  const perModel = new Map<string, { in: number; out: number }>();
  for (const s of samples) {
    if (now - s.ts > 30 * 24 * 60 * 60 * 1000 || !isReportedModel(s.model)) continue;
    const m = perModel.get(s.model) ?? { in: 0, out: 0 };
    m.in += s.tokensIn;
    m.out += s.tokensOut;
    perModel.set(s.model, m);
  }
  return [...perModel.entries()]
    .map(([model, t]) => {
      const entry: {
        model: string;
        tokensIn: number;
        tokensOut: number;
        apiEquivalent?: string;
        apiProvider?: string;
      } = { model, tokensIn: t.in, tokensOut: t.out };
      const resolved = resolveApi?.(model);
      if (resolved?.apiEquivalent) entry.apiEquivalent = resolved.apiEquivalent;
      if (resolved?.apiProvider) entry.apiProvider = resolved.apiProvider;
      return entry;
    })
    .sort((a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut));
}

// ── API equivalent resolution ────────────────────────────────────────────────
// Each CLI subscription routes to a backing raw inference API. We resolve the
// apiModelId from the live provider model catalog so the billing view can show
// the exact API model a subscription turn maps to (e.g. claude-sonnet-4-5 →
// claude-sonnet-4-5-20250929 on the anthropic API).

/** Maps a CLI provider name to its backing raw inference API provider. */
export const CLI_API_PROVIDER_MAP: Record<string, string> = {
  claude: 'anthropic',
  codex: 'openai',
  'codex-auth': 'openai',
  copilot: 'openai',
  grok: 'xai',
  antigravity: 'google',
  cursor: 'openai',
  devin: 'devin',
  cline: 'cline',
  kimicode: 'kimicode',
  kilocode: 'kilocode',
  freebuff: 'freebuff',
  jules: 'google',
};

/** Builds a resolver that consults the provider's live model catalog to map
 *  CLI-local model names to their raw API model IDs. Falls back to the
 *  CLI_API_PROVIDER_MAP for the apiProvider field when the catalog has no
 *  explicit mapping (e.g. the model is already an API id). */
export function makeApiEquivalentResolver(providerName: string): ApiEquivalentResolver {
  const fallbackApiProvider = CLI_API_PROVIDER_MAP[providerName];
  let models:
    | Array<{ id: string; apiModelId?: string; realModelId?: string; provider?: string }>
    | null
    | undefined;
  const loadModels = (): typeof models => {
    if (models !== undefined) return models;
    try {
      const provider = getContext().providers.get(providerName as ProviderName);
      models = provider ? provider.listModels() : null;
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err), provider: providerName },
        'makeApiEquivalentResolver: provider lookup failed',
      );
      models = null;
    }
    return models;
  };
  return (model: string) => {
    const catalog = loadModels();
    if (!catalog || catalog.length === 0) {
      return fallbackApiProvider ? { apiProvider: fallbackApiProvider } : null;
    }
    const match = catalog.find(
      (m) => m.id === model || m.apiModelId === model || m.realModelId === model,
    );
    if (!match) {
      return fallbackApiProvider ? { apiProvider: fallbackApiProvider } : null;
    }
    return {
      apiEquivalent: match.apiModelId ?? match.realModelId ?? match.id,
      apiProvider: match.provider ?? fallbackApiProvider,
    };
  };
}

// ── Per-file sample cache ─────────────────────────────────────────────────────
// The claude tree alone is hundreds of MB of JSONL; parse each file once per
// (mtime,size) and reuse across refreshes.
const fileCache = new Map<string, { mtimeMs: number; size: number; samples: UsageSample[] }>();

type LineParser = (line: string, now: number) => UsageSample | null;

async function samplesFromFile(
  file: string,
  parse: LineParser,
  now: number,
): Promise<UsageSample[]> {
  let st: import('node:fs').Stats;
  try {
    st = await stat(file);
  } catch (err: unknown) {
    // Expected: file removed between walk and read. No samples to extract.
    serverLog.debug(
      { file, err: err instanceof Error ? err.message : String(err) },
      'samplesFromFile: stat failed, skipping',
    );
    return [];
  }
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.samples;
  const out: UsageSample[] = [];
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err: unknown) {
    // Expected: file removed or became unreadable between stat and read.
    serverLog.debug(
      { file, err: err instanceof Error ? err.message : String(err) },
      'samplesFromFile: readFile failed, skipping',
    );
    return [];
  }
  for (const line of text.split('\n')) {
    const s = parse(line, now);
    if (s) out.push(s);
  }
  fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, samples: out });
  return out;
}

function parseClaudeLine(line: string, now: number): UsageSample | null {
  if (!line.includes('"usage"')) return null;
  try {
    const row = JSON.parse(line) as {
      timestamp?: string;
      message?: {
        id?: string;
        model?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      };
    };
    const u = row.message?.usage;
    if (!u) return null;
    const ts = row.timestamp ? Date.parse(row.timestamp) : NaN;
    if (!Number.isFinite(ts) || now - ts > SCAN_HORIZON_MS) return null;
    const model = row.message?.model?.trim();
    if (!model) return null;
    const sample: UsageSample & { id?: string } = {
      ts,
      model,
      tokensIn: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      tokensOut: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
    };
    if (row.message?.id) sample.id = row.message.id;
    return sample;
  } catch (err: unknown) {
    // Expected: malformed JSONL line in a session log. Skipping one line
    // doesn't lose the rest of the file's samples.
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'parseClaudeLine: skipped malformed line',
    );
    return null;
  }
}

// ── Claude Code ───────────────────────────────────────────────────────────────

async function readClaude(now: number): Promise<CliUsageReport> {
  // Scan BOTH the user's ~/.claude AND Koryphaios's isolated claude-home so
  // the billing view reflects TOTAL subscription burn (theirs + ours).
  const roots = [
    join(homedir(), '.claude', 'projects'),
    join(homedir(), '.koryphaios', 'claude-home', 'projects'),
  ];
  const samples: UsageSample[] = [];
  // Streaming rewrites the same assistant message id with growing usage —
  // keep only the LAST occurrence per message id.
  const byId = new Map<string, UsageSample>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for await (const file of walkJsonlAsync(root, now - SCAN_HORIZON_MS)) {
      for (const sample of await samplesFromFile(file, parseClaudeLine, now)) {
        const id = (sample as UsageSample & { id?: string }).id;
        if (id) byId.set(id, sample);
        else samples.push(sample);
      }
    }
  }
  samples.push(...byId.values());
  return {
    provider: 'claude',
    apiProviderName: CLI_API_PROVIDER_MAP['claude'],
    available: hasReportedUsage(samples),
    attribution: 'account',
    windows: windowsFromSamples(samples, now),
    dailyUsage: dailyUsageFromSamples(samples, now),
    quotas: [],
    byModel: byModelFromSamples(samples, now, makeApiEquivalentResolver('claude')),
    updatedAt: now,
  };
}

// ── Codex ─────────────────────────────────────────────────────────────────────

function codexSessionRoot(profileDir: string): string {
  const root = join(profileDir, 'sessions');
  try {
    return realpathSync(root);
  } catch (err: unknown) {
    // Expected: sessions dir doesn't exist yet. The unexpanded path is a
    // safe fallback — it just won't match any files until it does exist.
    serverLog.debug(
      { root, err: err instanceof Error ? err.message : String(err) },
      'codexSessionRoot: realpath failed, using literal path',
    );
    return root;
  }
}

export function codexSessionAttribution(
  accounts: Array<Pick<DiscoveredCliAccount, 'id' | 'label' | 'profileDir'>>,
  resolveRoot: (profileDir: string) => string = codexSessionRoot,
): Map<string, string | undefined> {
  const owners = new Map<string, Pick<DiscoveredCliAccount, 'id' | 'label' | 'profileDir'>>();
  const notes = new Map<string, string | undefined>();
  for (const account of accounts) {
    const root = resolveRoot(account.profileDir);
    const owner = owners.get(root);
    if (owner) {
      notes.set(account.id, `Shares local session history with ${owner.label}`);
    } else {
      owners.set(root, account);
      notes.set(account.id, undefined);
    }
  }
  return notes;
}

function normalizedPlan(plan?: string | null): string | null {
  const value = plan?.trim().toLowerCase();
  return value || null;
}

export function codexAttributionNote(
  sharedHistoryNote: string | undefined,
  profilePlan: string | null | undefined,
  sessionPlan: string | undefined,
): string | undefined {
  if (sharedHistoryNote) return sharedHistoryNote;
  const expected = normalizedPlan(profilePlan);
  const observed = normalizedPlan(sessionPlan);
  if (expected && observed && expected !== observed) {
    return `Session history reports a ${observed.toUpperCase()} plan, but this profile is ${expected.toUpperCase()}`;
  }
  return undefined;
}

async function readCodex(
  now: number,
  account?: DiscoveredCliAccount,
  attributionNote?: string,
): Promise<CliUsageReport> {
  const root = join(account?.profileDir ?? join(homedir(), '.codex'), 'sessions');
  const samples: UsageSample[] = [];
  let latestLimits: {
    ts: number;
    plan?: string;
    primary?: { used_percent?: number; window_minutes?: number; resets_at?: number };
    secondary?: { used_percent?: number; window_minutes?: number; resets_at?: number };
  } | null = null;

  if (!attributionNote && existsSync(root)) {
    for await (const file of walkJsonlAsync(root, now - SCAN_HORIZON_MS)) {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (err: unknown) {
        // Expected: file removed between walk and read.
        serverLog.debug(
          { file, err: err instanceof Error ? err.message : String(err) },
          'readCodex: readFile skipped',
        );
        continue;
      }
      // Session logs carry the selected model in turn_context records and
      // CUMULATIVE totals in token_count records. Associate each delta with
      // the latest real model from that same session; never invent a model id.
      let activeModel: string | null = null;
      // last_token_usage, which is exactly one turn's tokens.
      for (const line of text.split('\n')) {
        try {
          const row = JSON.parse(line) as {
            type?: string;
            timestamp?: string;
            payload?: {
              type?: string;
              model?: string;
              info?: {
                last_token_usage?: {
                  input_tokens?: number;
                  cached_input_tokens?: number;
                  output_tokens?: number;
                };
              };
              rate_limits?: {
                plan_type?: string;
                primary?: { used_percent?: number; window_minutes?: number; resets_at?: number };
                secondary?: { used_percent?: number; window_minutes?: number; resets_at?: number };
              };
            };
          };
          if (row.type === 'turn_context' && typeof row.payload?.model === 'string') {
            activeModel = row.payload.model.trim() || null;
            continue;
          }
          if (row.payload?.type !== 'token_count') continue;
          const ts = row.timestamp ? Date.parse(row.timestamp) : NaN;
          if (!Number.isFinite(ts)) continue;
          const last = row.payload.info?.last_token_usage;
          if (last && activeModel && now - ts <= SCAN_HORIZON_MS) {
            samples.push({
              ts,
              model: activeModel,
              tokensIn: last.input_tokens ?? 0,
              tokensOut: last.output_tokens ?? 0,
              cacheRead: last.cached_input_tokens ?? 0,
            });
          }
          const rl = row.payload.rate_limits;
          if (rl && (!latestLimits || ts > latestLimits.ts)) {
            latestLimits = { ts, plan: rl.plan_type, primary: rl.primary, secondary: rl.secondary };
          }
        } catch (err: unknown) {
          // Expected: malformed JSONL line. Skipping one line preserves the
          // rest of the session's token_count events.
          serverLog.debug(
            { file, err: err instanceof Error ? err.message : String(err) },
            'readCodex: skipped malformed line',
          );
        }
      }
    }
  }

  const quotas: QuotaWindow[] = [];
  const describe = (w?: { used_percent?: number; window_minutes?: number; resets_at?: number }) => {
    if (!w || typeof w.used_percent !== 'number') return;
    const mins = w.window_minutes ?? null;
    const label =
      mins === 300
        ? '5-hour'
        : mins === 10080
          ? 'weekly'
          : mins != null
            ? `${Math.round(mins / 60)}h`
            : 'quota';
    quotas.push({
      label,
      usedPercent: w.used_percent,
      resetsAt: w.resets_at != null ? w.resets_at * 1000 : null,
      windowMinutes: mins,
    });
  };
  describe(latestLimits?.primary);
  describe(latestLimits?.secondary);

  // The official app-server has read-only account/usage/read and
  // account/rateLimits/read methods. These are account-scoped by CODEX_HOME,
  // unlike local session files, so they remain correct even when two profiles
  // intentionally share a sessions directory.
  let liveUsage: Awaited<ReturnType<CodexAppServer['usage']>> | null = null;
  let liveLimits: Awaited<ReturnType<CodexAppServer['rateLimits']>> | null = null;
  if (account) {
    const appServer = new CodexAppServer(account.profileDir);
    try {
      const [usageResult, limitsResult] = await Promise.allSettled([
        appServer.usage(),
        appServer.rateLimits(),
      ]);
      if (usageResult.status === 'fulfilled') liveUsage = usageResult.value;
      if (limitsResult.status === 'fulfilled') liveLimits = limitsResult.value;
    } catch (err: unknown) {
      // The installed CLI may predate these read-only methods or be offline.
      // Preserve the verified session-log fallback rather than inventing data.
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err), accountId: account?.id },
        'Codex app-server usage/rateLimits unavailable',
      );
    } finally {
      appServer.close();
    }
  }

  const liveSnapshot = liveLimits?.rateLimits ?? null;
  const resolvedAttributionNote = codexAttributionNote(
    attributionNote,
    account?.plan,
    liveSnapshot?.planType ?? latestLimits?.plan,
  );
  const attributedSamples = resolvedAttributionNote ? [] : samples;
  const liveQuotas: QuotaWindow[] = [];
  const appendLiveQuota = (
    label: string,
    window?: { usedPercent?: number; windowMinutes?: number; resetsAt?: number } | null,
  ) => {
    if (!window || typeof window.usedPercent !== 'number') return;
    liveQuotas.push({
      label,
      usedPercent: window.usedPercent,
      windowMinutes: window.windowMinutes ?? null,
      resetsAt: window.resetsAt != null ? window.resetsAt * 1000 : null,
    });
  };
  appendLiveQuota('primary', liveSnapshot?.primary);
  appendLiveQuota('secondary', liveSnapshot?.secondary);
  const attributedQuotas =
    liveQuotas.length > 0 ? liveQuotas : resolvedAttributionNote ? [] : quotas;
  const liveDaily = (liveUsage?.dailyUsageBuckets ?? [])
    .filter((bucket) => typeof bucket.startDate === 'string' && typeof bucket.tokens === 'number')
    .map((bucket) => ({ date: bucket.startDate!.slice(0, 10), tokens: bucket.tokens! }));
  const activityIsLive = liveDaily.length > 0;
  return {
    provider: 'codex',
    apiProviderName: CLI_API_PROVIDER_MAP['codex'],
    ...(account
      ? {
          accountId: account.id,
          accountLabel: account.label,
          ...(account.email ? { accountEmail: account.email } : {}),
        }
      : {}),
    available: activityIsLive || hasReportedUsage(attributedSamples),
    attribution: resolvedAttributionNote && !activityIsLive ? 'unavailable' : 'account',
    ...(resolvedAttributionNote && !activityIsLive
      ? { attributionNote: resolvedAttributionNote }
      : {}),
    planType: liveSnapshot?.planType ?? account?.plan ?? latestLimits?.plan,
    creditBalance: liveSnapshot?.credits?.balance ?? null,
    usageSource: activityIsLive ? 'codex-app-server' : 'local-session-history',
    windows: activityIsLive
      ? windowsFromDailyUsage(liveDaily, now)
      : windowsFromSamples(attributedSamples, now),
    dailyUsage: activityIsLive ? liveDaily : dailyUsageFromSamples(attributedSamples, now),
    quotas: attributedQuotas,
    byModel: byModelFromSamples(attributedSamples, now, makeApiEquivalentResolver('codex')),
    updatedAt: now,
  };
}

// ── GitHub Copilot CLI ────────────────────────────────────────────────────────
// ~/.copilot/session-state/<uuid>/events.jsonl — session.shutdown events carry
// data.modelMetrics[model].usage token totals for the whole session.

function readCopilot(now: number): CliUsageReport {
  const root = join(homedir(), '.copilot', 'session-state');
  const samples: UsageSample[] = [];
  if (existsSync(root)) {
    for (const file of walkJsonl(root, now - SCAN_HORIZON_MS)) {
      if (!file.endsWith('events.jsonl')) continue;
      let st: import('node:fs').Stats;
      try {
        st = statSync(file);
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err), file },
          'Failed to stat copilot events file',
        );
        continue;
      }
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err), file },
          'Failed to read copilot events file',
        );
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.includes('modelMetrics')) continue;
        try {
          const row = JSON.parse(line) as {
            data?: {
              modelMetrics?: Record<
                string,
                {
                  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
                }
              >;
            };
          };
          for (const [model, m] of Object.entries(row.data?.modelMetrics ?? {})) {
            const u = m.usage;
            if (!u) continue;
            samples.push({
              ts: st.mtimeMs,
              model,
              tokensIn: u.inputTokens ?? 0,
              tokensOut: u.outputTokens ?? 0,
              cacheRead: u.cacheReadTokens ?? 0,
            });
          }
        } catch (err: unknown) {
          /* skip */
          serverLog.debug(
            { err: err instanceof Error ? err.message : String(err) },
            'Failed to parse copilot events JSONL line',
          );
        }
      }
    }
  }
  return {
    provider: 'copilot',
    apiProviderName: CLI_API_PROVIDER_MAP['copilot'],
    available: hasReportedUsage(samples),
    attribution: 'account',
    windows: windowsFromSamples(samples, now),
    dailyUsage: dailyUsageFromSamples(samples, now),
    quotas: [],
    byModel: byModelFromSamples(samples, now, makeApiEquivalentResolver('copilot')),
    updatedAt: now,
  };
}

// ── xAI Grok CLI ─────────────────────────────────────────────────────────────
// ~/.grok/sessions/<cwd>/<session>/signals.json — per-session context token
// totals + models used. Coarser than per-turn logs but real.

function readGrok(now: number): CliUsageReport {
  const root = join(homedir(), '.grok', 'sessions');
  const samples: UsageSample[] = [];
  if (existsSync(root)) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err), dir },
          'Failed to read grok sessions directory',
        );
        continue;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name === 'signals.json') {
          try {
            const st = statSync(full);
            if (now - st.mtimeMs > SCAN_HORIZON_MS) continue;
            const j = JSON.parse(readFileSync(full, 'utf8')) as {
              contextTokensUsed?: number;
              modelsUsed?: string[];
            };
            const model = j.modelsUsed?.[0]?.trim();
            if (typeof j.contextTokensUsed === 'number' && j.contextTokensUsed > 0 && model) {
              samples.push({
                ts: st.mtimeMs,
                model,
                tokensIn: j.contextTokensUsed,
                tokensOut: 0,
                cacheRead: 0,
              });
            }
          } catch (err: unknown) {
            /* skip */
            serverLog.debug(
              { err: err instanceof Error ? err.message : String(err), file: full },
              'Failed to parse grok signals.json',
            );
          }
        }
      }
    }
  }
  return {
    provider: 'grok',
    apiProviderName: CLI_API_PROVIDER_MAP['grok'],
    available: hasReportedUsage(samples),
    attribution: 'account',
    windows: windowsFromSamples(samples, now),
    dailyUsage: dailyUsageFromSamples(samples, now),
    quotas: [],
    byModel: byModelFromSamples(samples, now, makeApiEquivalentResolver('grok')),
    updatedAt: now,
  };
}

// ── Subscription quota fetchers (live, cached) ───────────────────────────────

const quotaCache = new Map<string, { at: number; quotas: QuotaWindow[]; plan?: string }>();
const QUOTA_TTL_MS = 5 * 60_000;
const QUOTA_TIMEOUT_MS = 5_000;

/** Claude subscription quota via the CLI's own OAuth credential — the same
 *  data /usage shows (read-only status; no inference goes through this). */
async function fetchClaudeQuota(): Promise<void> {
  const hit = quotaCache.get('claude');
  if (hit && Date.now() - hit.at < QUOTA_TTL_MS) return;
  try {
    const credPath = join(homedir(), '.claude', '.credentials.json');
    if (!existsSync(credPath)) return;
    const creds = JSON.parse(readFileSync(credPath, 'utf8')) as {
      claudeAiOauth?: { accessToken?: string };
    };
    const token = creds.claudeAiOauth?.accessToken;
    if (!token) return;
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS),
    });
    if (!res.ok) return;
    const j = (await res.json()) as Record<
      string,
      { utilization?: number; resets_at?: string } | undefined
    >;
    const quotas: QuotaWindow[] = [];
    const add = (key: string, label: string, mins: number | null) => {
      const w = j[key];
      if (w && typeof w.utilization === 'number') {
        quotas.push({
          label,
          usedPercent: w.utilization,
          resetsAt: w.resets_at ? Date.parse(w.resets_at) : null,
          windowMinutes: mins,
        });
      }
    };
    add('five_hour', '5-hour', 300);
    add('seven_day', 'weekly', 10080);
    add('seven_day_sonnet', 'weekly (Sonnet)', 10080);
    if (quotas.length) quotaCache.set('claude', { at: Date.now(), quotas });
  } catch (err: unknown) {
    /* endpoint is undocumented — degrade silently */
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Claude quota endpoint unavailable',
    );
  }
}

/** Copilot monthly quota via copilot_internal/user (the CLI's own source). */
async function fetchCopilotQuota(ghToken: string | undefined): Promise<void> {
  if (!ghToken) return;
  const hit = quotaCache.get('copilot');
  if (hit && Date.now() - hit.at < QUOTA_TTL_MS) return;
  try {
    const res = await fetch('https://api.github.com/copilot_internal/user', {
      headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS),
    });
    if (!res.ok) return;
    const j = (await res.json()) as {
      copilot_plan?: string;
      quota_snapshots?: Record<
        string,
        { percent_remaining?: number; unlimited?: boolean; quota_reset_at?: string } | undefined
      >;
    };
    const quotas: QuotaWindow[] = [];
    for (const [name, q] of Object.entries(j.quota_snapshots ?? {})) {
      if (!q || q.unlimited || typeof q.percent_remaining !== 'number') continue;
      quotas.push({
        label: `monthly ${name.replace(/_/g, ' ')}`,
        usedPercent: Math.max(0, Math.min(100, 100 - q.percent_remaining)),
        resetsAt: q.quota_reset_at ? Date.parse(q.quota_reset_at) : null,
        windowMinutes: null,
      });
    }
    if (quotas.length) quotaCache.set('copilot', { at: Date.now(), quotas, plan: j.copilot_plan });
  } catch (err: unknown) {
    /* internal endpoint — degrade silently */
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Copilot quota endpoint unavailable',
    );
  }
}

// ── Antigravity ───────────────────────────────────────────────────────────────
// The agy CLI stores conversations as protobuf-encoded SQLite + JSONL transcripts
// that don't expose per-turn token counts in a parseable format.  Instead, we
// derive usage windows from Koryphaios's own credit-accountant DB (which records
// every provider stream's usage_update events with timestamps) and report the
// live per-group quota from the agy CLI's own `/usage` command.

function readAntigravity(now: number): CliUsageReport {
  // 1. Token usage windows from the credit-accountant DB
  let samples: UsageSample[] = [];
  try {
    const rows = getUsageSamplesByProvider('antigravity', now - SCAN_HORIZON_MS);
    samples = rows.map((r) => ({
      ts: r.ts,
      model: r.model,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      cacheRead: 0,
    }));
  } catch (err: unknown) {
    // Expected when the credit DB hasn't been initialized yet.
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'readAntigravity: credit DB unavailable',
    );
  }

  // 2. Live per-group quota from the agy CLI (already cached by the provider)
  const quotas: QuotaWindow[] = [];
  try {
    const provider = getContext().providers.get('antigravity');
    const quotaProvider = provider as unknown as {
      getQuotaGroups?: () => Array<{
        name: string;
        buckets: Array<{
          id: string;
          name: string;
          window: string;
          remainingFraction: number;
          resetTime: string;
        }>;
      }> | null;
    };
    if (provider && typeof quotaProvider.getQuotaGroups === 'function') {
      const groups = quotaProvider.getQuotaGroups();
      if (groups) {
        for (const group of groups) {
          for (const bucket of group.buckets) {
            const mins = bucket.window === 'weekly' ? 10080 : bucket.window === '5h' ? 300 : null;
            quotas.push({
              label: `${group.name} ${bucket.name}`,
              usedPercent: Math.max(
                0,
                Math.min(100, Math.round((1 - bucket.remainingFraction) * 100)),
              ),
              resetsAt: bucket.resetTime ? Date.parse(bucket.resetTime) : null,
              windowMinutes: mins,
            });
          }
        }
      }
    }
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'readAntigravity: quota fetch failed',
    );
  }

  return {
    provider: 'antigravity',
    apiProviderName: CLI_API_PROVIDER_MAP['antigravity'],
    available: hasReportedUsage(samples) || quotas.length > 0,
    attribution: 'account',
    usageSource: 'local-session-history',
    windows: windowsFromSamples(samples, now),
    dailyUsage: dailyUsageFromSamples(samples, now),
    quotas,
    byModel: byModelFromSamples(samples, now, makeApiEquivalentResolver('antigravity')),
    updatedAt: now,
  };
}

// ── Cursor CLI ────────────────────────────────────────────────────────────────
// Cursor's agent-transcripts (~/.cursor/projects/<cwd>/agent-transcripts/<uuid>/*.jsonl)
// carry user/assistant messages and turn_ended events but NO per-turn token
// counts. The CursorProvider DOES emit usage_update events that the credit
// accountant records, so we derive all usage windows from the credit DB —
// the same approach used for antigravity. Multi-account Cursor profiles are
// discovered via cli-accounts (~/.cursor, ~/.cursor2, …).

function readCursorFromCreditDb(now: number, account?: DiscoveredCliAccount): CliUsageReport {
  let samples: UsageSample[] = [];
  try {
    const rows = getUsageSamplesByProvider('cursor', now - SCAN_HORIZON_MS);
    // When multiple Cursor profiles share the same credit DB, we cannot
    // attribute individual samples to a specific profile. Report aggregate
    // usage only for the primary profile and mark others unavailable.
    if (account) {
      // Per-account attribution requires an accountId filter in the credit DB;
      // the current schema stores accountId but the cursor provider does not
      // emit it. Show aggregate under the first profile only.
      const cursorAccounts = discoverCliAccounts().filter((a) => a.provider === 'cursor');
      const isFirst = cursorAccounts[0]?.id === account.id;
      if (!isFirst) {
        return {
          provider: 'cursor',
          apiProviderName: CLI_API_PROVIDER_MAP['cursor'],
          accountId: account.id,
          accountLabel: account.label,
          ...(account.email ? { accountEmail: account.email } : {}),
          available: false,
          attribution: 'unavailable',
          attributionNote:
            'Cursor profiles share a single local usage history; per-account attribution is not available',
          windows: [],
          dailyUsage: [],
          quotas: [],
          byModel: [],
          updatedAt: now,
        };
      }
    }
    samples = rows.map((r) => ({
      ts: r.ts,
      model: r.model,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      cacheRead: 0,
    }));
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'readCursor: credit DB unavailable',
    );
  }

  return {
    provider: 'cursor',
    apiProviderName: CLI_API_PROVIDER_MAP['cursor'],
    ...(account
      ? {
          accountId: account.id,
          accountLabel: account.label,
          ...(account.email ? { accountEmail: account.email } : {}),
        }
      : {}),
    available: hasReportedUsage(samples),
    attribution: 'account',
    usageSource: 'local-session-history',
    windows: windowsFromSamples(samples, now),
    dailyUsage: dailyUsageFromSamples(samples, now),
    quotas: [],
    byModel: byModelFromSamples(samples, now, makeApiEquivalentResolver('cursor')),
    updatedAt: now,
  };
}

// ── Devin CLI ─────────────────────────────────────────────────────────────────
// Devin stores ATIF-v1.7 transcripts at ~/.local/share/devin/cli/transcripts/*.json
// Each transcript has agent.model_name and final_metrics with total_prompt_tokens,
// total_completion_tokens, and total_cached_tokens. Steps carry timestamps.
// We use the file's mtime as the sample timestamp and final_metrics as the
// session-level token totals (one sample per transcript).

async function readDevin(now: number, account?: DiscoveredCliAccount): Promise<CliUsageReport> {
  const transcriptRoot = join(homedir(), '.local', 'share', 'devin', 'cli', 'transcripts');
  const samples: UsageSample[] = [];
  if (existsSync(transcriptRoot)) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(transcriptRoot, { withFileTypes: true });
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'readDevin: readdir transcripts failed',
      );
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.name.endsWith('.json')) continue;
      const file = join(transcriptRoot, entry.name);
      try {
        const st = await stat(file);
        if (now - st.mtimeMs > SCAN_HORIZON_MS) continue;
        const text = await readFile(file, 'utf8');
        const data = JSON.parse(text) as {
          agent?: { model_name?: string };
          final_metrics?: {
            total_prompt_tokens?: number;
            total_completion_tokens?: number;
            total_cached_tokens?: number;
          };
        };
        const model = data.agent?.model_name?.trim();
        const metrics = data.final_metrics;
        if (!model || !metrics) continue;
        const tokensIn = (metrics.total_prompt_tokens ?? 0) + (metrics.total_cached_tokens ?? 0);
        const tokensOut = metrics.total_completion_tokens ?? 0;
        if (tokensIn > 0 || tokensOut > 0) {
          samples.push({
            ts: st.mtimeMs,
            model,
            tokensIn,
            tokensOut,
            cacheRead: metrics.total_cached_tokens ?? 0,
          });
        }
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err), file },
          'readDevin: transcript parse failed',
        );
      }
    }
  }

  return {
    provider: 'devin',
    apiProviderName: CLI_API_PROVIDER_MAP['devin'],
    ...(account
      ? {
          accountId: account.id,
          accountLabel: account.label,
          ...(account.email ? { accountEmail: account.email } : {}),
        }
      : {}),
    available: hasReportedUsage(samples),
    attribution: 'account',
    usageSource: 'local-session-history',
    windows: windowsFromSamples(samples, now),
    dailyUsage: dailyUsageFromSamples(samples, now),
    quotas: [],
    byModel: byModelFromSamples(samples, now, makeApiEquivalentResolver('devin')),
    updatedAt: now,
  };
}

// ── Cline CLI ─────────────────────────────────────────────────────────────────
// Cline stores session metadata + messages at ~/.cline/data/sessions/<id>/*.json
// The messages file has per-assistant-message metrics (inputTokens, outputTokens,
// cacheReadTokens, cacheWriteTokens) and modelInfo.id. Each message has a `ts`
// epoch-ms field. We parse every messages.json in the session tree.

async function readCline(now: number, account?: DiscoveredCliAccount): Promise<CliUsageReport> {
  const sessionsRoot = join(homedir(), '.cline', 'data', 'sessions');
  const samples: UsageSample[] = [];
  if (existsSync(sessionsRoot)) {
    const stack = [sessionsRoot];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err), dir },
          'readCline: readdir sessions failed',
        );
        continue;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!entry.name.endsWith('.messages.json')) continue;
        try {
          const st = await stat(full);
          if (now - st.mtimeMs > SCAN_HORIZON_MS) continue;
          const text = await readFile(full, 'utf8');
          const data = JSON.parse(text) as {
            messages?: Array<{
              role?: string;
              ts?: number;
              modelInfo?: { id?: string; provider?: string };
              metrics?: {
                inputTokens?: number;
                outputTokens?: number;
                cacheReadTokens?: number;
                cacheWriteTokens?: number;
              };
            }>;
          };
          for (const msg of data.messages ?? []) {
            if (msg.role !== 'assistant') continue;
            const model = msg.modelInfo?.id?.trim();
            const metrics = msg.metrics;
            const ts = msg.ts;
            if (!model || !metrics || typeof ts !== 'number') continue;
            if (now - ts > SCAN_HORIZON_MS) continue;
            // Cline routes through OpenAI-compatible providers, so inputTokens
            // (prompt_tokens) already INCLUDES cached tokens. Do not add
            // cacheReadTokens or cacheWriteTokens to tokensIn — that would
            // double-count. cacheRead is recorded as a breakdown detail only.
            const tokensIn = metrics.inputTokens ?? 0;
            const tokensOut = metrics.outputTokens ?? 0;
            if (tokensIn > 0 || tokensOut > 0) {
              samples.push({
                ts,
                model,
                tokensIn,
                tokensOut,
                cacheRead: metrics.cacheReadTokens ?? 0,
              });
            }
          }
        } catch (err: unknown) {
          serverLog.debug(
            { err: err instanceof Error ? err.message : String(err), file: full },
            'readCline: messages parse failed',
          );
        }
      }
    }
  }

  return {
    provider: 'cline',
    apiProviderName: CLI_API_PROVIDER_MAP['cline'],
    ...(account
      ? {
          accountId: account.id,
          accountLabel: account.label,
          ...(account.email ? { accountEmail: account.email } : {}),
        }
      : {}),
    available: hasReportedUsage(samples),
    attribution: 'account',
    usageSource: 'local-session-history',
    windows: windowsFromSamples(samples, now),
    dailyUsage: dailyUsageFromSamples(samples, now),
    quotas: [],
    byModel: byModelFromSamples(samples, now, makeApiEquivalentResolver('cline')),
    updatedAt: now,
  };
}

// ── Kimi Code CLI ─────────────────────────────────────────────────────────────
// Kimi stores sessions at ~/.kimi/sessions/<hash>/<uuid>/{wire.jsonl,context.jsonl}
// wire.jsonl has StatusUpdate events with token_usage (input_other, output,
// input_cache_read, input_cache_creation) and a float timestamp. We parse each
// StatusUpdate as one usage sample with the model from the session metadata or
// the KimiCode provider's model catalog fallback.

async function readKimiCode(now: number, account?: DiscoveredCliAccount): Promise<CliUsageReport> {
  const sessionsRoot = join(homedir(), '.kimi', 'sessions');
  const samples: UsageSample[] = [];

  // Kimi wire logs don't carry a per-turn model name. Resolve the active
  // model from the KimiCode provider's live catalog (first model = default);
  // fall back to KIMI_DEFAULT_MODEL when the catalog is unavailable.
  let resolvedKimiModel: string | null = null;
  try {
    const provider = getContext().providers.get('kimicode' as ProviderName);
    const models = provider?.listModels() ?? [];
    if (models.length > 0) resolvedKimiModel = models[0].apiModelId ?? models[0].id;
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'readKimiCode: provider catalog unavailable, using fallback model',
    );
  }
  const kimiModel = resolvedKimiModel ?? KIMI_DEFAULT_MODEL;

  if (existsSync(sessionsRoot)) {
    let sessionDirs: import('node:fs').Dirent[];
    try {
      sessionDirs = readdirSync(sessionsRoot, { withFileTypes: true });
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'readKimiCode: readdir sessions failed',
      );
      sessionDirs = [];
    }
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue;
      const sessionPath = join(sessionsRoot, sessionDir.name);
      let convDirs: import('node:fs').Dirent[];
      try {
        convDirs = readdirSync(sessionPath, { withFileTypes: true });
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err), dir: sessionPath },
          'readKimiCode: readdir conversation dir failed',
        );
        continue;
      }
      for (const convDir of convDirs) {
        if (!convDir.isDirectory()) continue;
        const wirePath = join(sessionPath, convDir.name, 'wire.jsonl');
        if (!existsSync(wirePath)) continue;
        try {
          const st = await stat(wirePath);
          if (now - st.mtimeMs > SCAN_HORIZON_MS) continue;
          const text = await readFile(wirePath, 'utf8');
          for (const line of text.split('\n')) {
            if (!line.includes('StatusUpdate')) continue;
            try {
              const row = JSON.parse(line) as {
                timestamp?: number;
                message?: {
                  type?: string;
                  payload?: {
                    token_usage?: {
                      input_other?: number;
                      output?: number;
                      input_cache_read?: number;
                      input_cache_creation?: number;
                    };
                  };
                };
              };
              if (row.message?.type !== 'StatusUpdate') continue;
              // Kimi timestamps are float seconds; floor to avoid rounding
              // up into the next second bucket.
              const ts = typeof row.timestamp === 'number' ? Math.floor(row.timestamp * 1000) : NaN;
              if (!Number.isFinite(ts) || now - ts > SCAN_HORIZON_MS) continue;
              const usage = row.message.payload?.token_usage;
              if (!usage) continue;
              const tokensIn =
                (usage.input_other ?? 0) +
                (usage.input_cache_read ?? 0) +
                (usage.input_cache_creation ?? 0);
              const tokensOut = usage.output ?? 0;
              if (tokensIn > 0 || tokensOut > 0) {
                samples.push({
                  ts,
                  model: kimiModel,
                  tokensIn,
                  tokensOut,
                  cacheRead: usage.input_cache_read ?? 0,
                });
              }
            } catch (err: unknown) {
              serverLog.debug(
                { err: err instanceof Error ? err.message : String(err) },
                'readKimiCode: StatusUpdate line parse failed',
              );
            }
          }
        } catch (err: unknown) {
          serverLog.debug(
            { err: err instanceof Error ? err.message : String(err), file: wirePath },
            'readKimiCode: wire.jsonl read failed',
          );
        }
      }
    }
  }

  return {
    provider: 'kimicode',
    apiProviderName: CLI_API_PROVIDER_MAP['kimicode'],
    ...(account
      ? {
          accountId: account.id,
          accountLabel: account.label,
          ...(account.email ? { accountEmail: account.email } : {}),
        }
      : {}),
    available: hasReportedUsage(samples),
    attribution: 'account',
    usageSource: 'local-session-history',
    windows: windowsFromSamples(samples, now),
    dailyUsage: dailyUsageFromSamples(samples, now),
    quotas: [],
    byModel: byModelFromSamples(samples, now, makeApiEquivalentResolver('kimicode')),
    updatedAt: now,
  };
}

// ── Unavailable CLI providers (kilocode, freebuff, jules) ─────────────────────
// These providers are fail-closed or approval-required in this build. They never
// emit usage_update and have no parseable local session logs. When their CLI
// login is detected, surface them in billing with an explicit unavailable
// attribution so users understand WHY no usage appears (not just "no data").

function readUnavailableCli(
  providerName: string,
  detectionFn: (() => boolean | string | null) | null,
  unavailableNote: string,
  now: number,
): CliUsageReport | null {
  // Only surface when the CLI is actually detected on-disk.
  const detected = detectionFn ? !!detectionFn() : false;
  if (!detected) return null;
  return {
    provider: providerName,
    apiProviderName: CLI_API_PROVIDER_MAP[providerName],
    available: false,
    attribution: 'unavailable',
    attributionNote: unavailableNote,
    windows: [],
    dailyUsage: [],
    quotas: [],
    byModel: [],
    updatedAt: now,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

async function collectCliUsageReports(opts?: {
  githubToken?: string;
  forceRefresh?: boolean;
}): Promise<CliUsageReport[]> {
  if (!opts?.forceRefresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.reports;
  const now = Date.now();

  // Kick live quota fetches in parallel with the local log scans.
  const quotaJobs = Promise.allSettled([fetchClaudeQuota(), fetchCopilotQuota(opts?.githubToken)]);

  const reports: CliUsageReport[] = [];
  const allAccounts = discoverCliAccounts();

  // ── Codex: per-account readers with shared-history attribution guards ──────
  const codexAccounts = allAccounts.filter((account) => account.provider === 'codex');
  const codexAttribution = codexSessionAttribution(codexAccounts);
  const codexReaders = (codexAccounts.length > 0 ? codexAccounts : [undefined]).map((account) => {
    if (!account) return (at: number) => readCodex(at);
    // A symlinked/shared sessions directory cannot tell us which subscription
    // performed a turn. Never copy the owner's usage or quota onto another
    // login just because the auth homes are separate.
    return (at: number) => readCodex(at, account, codexAttribution.get(account.id));
  });

  // ── Cursor: per-account readers (credit DB is aggregate; secondary profiles
  //    get an explicit unavailable attribution) ───────────────────────────────
  const cursorAccounts = allAccounts.filter((account) => account.provider === 'cursor');
  const cursorReaders = (cursorAccounts.length > 0 ? cursorAccounts : [undefined]).map(
    (account) => (at: number) => readCursorFromCreditDb(at, account),
  );

  // ── Devin: per-account readers (transcripts are shared across profiles) ────
  const devinAccounts = allAccounts.filter((account) => account.provider === 'devin');
  const devinReaders = (devinAccounts.length > 0 ? devinAccounts : [undefined]).map(
    (account) => (at: number) => readDevin(at, account),
  );

  // ── Cline: per-account readers ─────────────────────────────────────────────
  const clineAccounts = allAccounts.filter((account) => account.provider === 'cline');
  const clineReaders = (clineAccounts.length > 0 ? clineAccounts : [undefined]).map(
    (account) => (at: number) => readCline(at, account),
  );

  // ── Kimi Code: per-account readers ─────────────────────────────────────────
  const kimiAccounts = allAccounts.filter((account) => account.provider === 'kimicode');
  const kimiReaders = (kimiAccounts.length > 0 ? kimiAccounts : [undefined]).map(
    (account) => (at: number) => readKimiCode(at, account),
  );

  // ── Unavailable CLI providers: surface only when detected on-disk ──────────
  const unavailableReaders: Array<(now: number) => CliUsageReport | null> = [
    (at) =>
      readUnavailableCli(
        'freebuff',
        detectFreebuffCLILogin,
        'Freebuff is unavailable in this build. The prior integration used an undocumented SDK contract and is disabled; no usage is recorded.',
        at,
      ),
    (at) =>
      readUnavailableCli(
        'jules',
        detectJulesApiKey,
        'Jules is an async cloud coding agent that requires explicit approval per task. No local usage is recorded; usage is tracked on Google’s side.',
        at,
      ),
  ];

  const readers: Array<(now: number) => CliUsageReport | Promise<CliUsageReport> | null> = [
    readClaude,
    ...codexReaders,
    readCopilot,
    readGrok,
    readAntigravity,
    ...cursorReaders,
    ...devinReaders,
    ...clineReaders,
    ...kimiReaders,
    ...unavailableReaders,
  ];
  const results = await Promise.allSettled(readers.map((reader) => reader(now)));
  for (const result of results) {
    if (
      result.status === 'fulfilled' &&
      result.value &&
      (result.value.available ||
        result.value.quotas.length > 0 ||
        result.value.attribution === 'unavailable')
    ) {
      reports.push(result.value);
    }
  }
  await quotaJobs;
  for (const r of reports) {
    const q = quotaCache.get(r.provider);
    if (q) {
      r.quotas = [
        ...q.quotas,
        ...r.quotas.filter((x) => !q.quotas.some((y) => y.label === x.label)),
      ];
      if (q.plan && !r.planType) r.planType = q.plan;
    }
  }
  cached = { at: now, reports };
  return reports;
}

/**
 * Billing polls while an expensive first local-history scan is still running.
 * Coalesce those requests so opening the drawer never starts several scans of
 * the same CLI histories at once.
 */
export function getCliUsageReports(opts?: {
  githubToken?: string;
  forceRefresh?: boolean;
}): Promise<CliUsageReport[]> {
  if (!opts?.forceRefresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return Promise.resolve(cached.reports);
  }
  if (!inFlight) {
    inFlight = collectCliUsageReports(opts).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}
