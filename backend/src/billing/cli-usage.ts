// CLI usage readers — real local data written by the agent CLIs themselves.
//
// Subscription CLIs are flat-rate, so instead of dollars-spent we report:
//   • token usage over hourly / daily / weekly / monthly windows
//   • the provider's OWN quota state (% burned + reset time) where the CLI
//     records it locally (Codex writes rate_limits into every session log)
//
// Sources verified on-disk:
//   claude  ~/.claude/projects/**/*.jsonl        message.usage + message.model
//   codex   ~/.codex/sessions/**/*.jsonl         token_count events + rate_limits

import { readdirSync, statSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { readdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { discoverCliAccounts, type DiscoveredCliAccount } from '../providers/cli-accounts';
import { CodexAppServer } from '../providers/codex-app-server';
import { getUsageSamplesByProvider } from '../credit-accountant';
import { getContext } from '../context';
import { serverLog } from '../logger';

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
  byModel: Array<{ model: string; tokensIn: number; tokensOut: number }>;
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

interface UsageSample {
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

function byModelFromSamples(samples: UsageSample[], now: number): CliUsageReport['byModel'] {
  const perModel = new Map<string, { in: number; out: number }>();
  for (const s of samples) {
    if (now - s.ts > 30 * 24 * 60 * 60 * 1000 || !isReportedModel(s.model)) continue;
    const m = perModel.get(s.model) ?? { in: 0, out: 0 };
    m.in += s.tokensIn;
    m.out += s.tokensOut;
    perModel.set(s.model, m);
  }
  return [...perModel.entries()]
    .map(([model, t]) => ({
      model,
      tokensIn: t.in,
      tokensOut: t.out,
    }))
    .sort((a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut));
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
    available: hasReportedUsage(samples),
    attribution: 'account',
    windows: windowsFromSamples(samples, now),
    dailyUsage: dailyUsageFromSamples(samples, now),
    quotas: [],
    byModel: byModelFromSamples(samples, now),
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
    byModel: byModelFromSamples(attributedSamples, now),
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
    available: hasReportedUsage(samples),
    attribution: 'account',
    windows: windowsFromSamples(samples, now),
    dailyUsage: dailyUsageFromSamples(samples, now),
    quotas: [],
    byModel: byModelFromSamples(samples, now),
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
    available: hasReportedUsage(samples),
    attribution: 'account',
    windows: windowsFromSamples(samples, now),
    dailyUsage: dailyUsageFromSamples(samples, now),
    quotas: [],
    byModel: byModelFromSamples(samples, now),
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
    available: hasReportedUsage(samples) || quotas.length > 0,
    attribution: 'account',
    usageSource: 'local-session-history',
    windows: windowsFromSamples(samples, now),
    dailyUsage: dailyUsageFromSamples(samples, now),
    quotas,
    byModel: byModelFromSamples(samples, now),
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
  const codexAccounts = discoverCliAccounts().filter((account) => account.provider === 'codex');
  const codexAttribution = codexSessionAttribution(codexAccounts);
  const codexReaders = (codexAccounts.length > 0 ? codexAccounts : [undefined]).map((account) => {
    if (!account) return (at: number) => readCodex(at);
    // A symlinked/shared sessions directory cannot tell us which subscription
    // performed a turn. Never copy the owner's usage or quota onto another
    // login just because the auth homes are separate.
    return (at: number) => readCodex(at, account, codexAttribution.get(account.id));
  });
  const readers: Array<(now: number) => CliUsageReport | Promise<CliUsageReport>> = [
    readClaude,
    ...codexReaders,
    readCopilot,
    readGrok,
    readAntigravity,
  ];
  const results = await Promise.allSettled(readers.map((reader) => reader(now)));
  for (const result of results) {
    if (
      result.status === 'fulfilled' &&
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
