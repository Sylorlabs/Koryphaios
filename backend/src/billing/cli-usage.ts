// CLI usage readers — real local data written by the agent CLIs themselves.
//
// Subscription CLIs are flat-rate, so instead of dollars-spent we report:
//   • token usage over hourly / daily / weekly / monthly windows
//   • the provider's OWN quota state (% burned + reset time) where the CLI
//     records it locally (Codex writes rate_limits into every session log)
//   • "inference value": what those tokens would have cost at API prices
//     (resolved via the pricing hub — never invented).
//
// Sources verified on-disk:
//   claude  ~/.claude/projects/**/*.jsonl        message.usage + message.model
//   codex   ~/.codex/sessions/**/*.jsonl         token_count events + rate_limits

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { readdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { computeCostUsd } from '../pricing';
import { discoverCliAccounts, type DiscoveredCliAccount } from '../providers/cli-accounts';

export interface UsageWindow {
  /** 'hour' | 'day' | 'week' | 'month' */
  period: string;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  /** Equivalent API cost of these tokens, USD; null if no model was priceable. */
  inferenceValueUsd: number | null;
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
  planType?: string;
  windows: UsageWindow[];
  quotas: QuotaWindow[];
  byModel: Array<{ model: string; tokensIn: number; tokensOut: number; inferenceValueUsd: number | null }>;
  updatedAt: number;
}

const WINDOWS_MS: Array<[string, number]> = [
  ['hour', 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
];
const SCAN_HORIZON_MS = 31 * 24 * 60 * 60 * 1000;

interface UsageSample {
  ts: number;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
}

function isReportedModel(model: string): boolean {
  const value = model.trim();
  return value.length > 0 && !value.startsWith('<') && !/(?:^|[-_])(unknown|synthetic|null|undefined)$/i.test(value);
}

function hasReportedUsage(samples: UsageSample[]): boolean {
  return samples.some(
    (sample) => isReportedModel(sample.model) && (sample.tokensIn > 0 || sample.tokensOut > 0),
  );
}

let cached: { at: number; reports: CliUsageReport[] } | null = null;
const CACHE_TTL_MS = 60_000;

async function* walkJsonlAsync(root: string, newerThan: number): AsyncGenerator<string> {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.endsWith('.jsonl')) {
        try {
          if ((await stat(full)).mtimeMs >= newerThan) yield full;
        } catch {
          /* raced */
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
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith('.jsonl')) {
        try { if (statSync(full).mtimeMs >= newerThan) yield full; } catch { /* raced */ }
      }
    }
  }
}

function windowsFromSamples(samples: UsageSample[], now: number): UsageWindow[] {
  return WINDOWS_MS.map(([period, ms]) => {
    let tokensIn = 0,
      tokensOut = 0,
      cacheRead = 0;
    const perModel = new Map<string, { in: number; out: number }>();
    for (const s of samples) {
      if (now - s.ts > ms || !isReportedModel(s.model)) continue;
      tokensIn += s.tokensIn;
      tokensOut += s.tokensOut;
      cacheRead += s.cacheRead;
      const m = perModel.get(s.model) ?? { in: 0, out: 0 };
      m.in += s.tokensIn;
      m.out += s.tokensOut;
      perModel.set(s.model, m);
    }
    let value: number | null = null;
    for (const [model, t] of perModel) {
      const c = computeCostUsd(currentCliProvider, model, t.in, t.out);
      if (c) value = (value ?? 0) + c.costUsd;
    }
    return { period, tokensIn, tokensOut, cacheRead, inferenceValueUsd: value };
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
      inferenceValueUsd: computeCostUsd(currentCliProvider, model, t.in, t.out)?.costUsd ?? null,
    }))
    .sort((a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut));
}

// Set around each reader so pricing resolves against the right provider's
// equivalence rules without threading it through every helper.
let currentCliProvider = 'claude';


// ── Per-file sample cache ─────────────────────────────────────────────────────
// The claude tree alone is hundreds of MB of JSONL; parse each file once per
// (mtime,size) and reuse across refreshes.
const fileCache = new Map<string, { mtimeMs: number; size: number; samples: UsageSample[] }>();

type LineParser = (line: string, now: number) => UsageSample | null;

async function samplesFromFile(file: string, parse: LineParser, now: number): Promise<UsageSample[]> {
  let st: import('node:fs').Stats;
  try {
    st = await stat(file);
  } catch {
    return [];
  }
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.samples;
  const out: UsageSample[] = [];
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
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
  } catch {
    return null;
  }
}

// ── Claude Code ───────────────────────────────────────────────────────────────

async function readClaude(now: number): Promise<CliUsageReport> {
  currentCliProvider = 'claude';
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
    windows: windowsFromSamples(samples, now),
    quotas: [],
    byModel: byModelFromSamples(samples, now),
    updatedAt: now,
  };
}

// ── Codex ─────────────────────────────────────────────────────────────────────

async function readCodex(now: number, account?: DiscoveredCliAccount): Promise<CliUsageReport> {
  currentCliProvider = 'codex';
  const root = join(account?.profileDir ?? join(homedir(), '.codex'), 'sessions');
  const samples: UsageSample[] = [];
  let latestLimits: {
    ts: number;
    plan?: string;
    primary?: { used_percent?: number; window_minutes?: number; resets_at?: number };
    secondary?: { used_percent?: number; window_minutes?: number; resets_at?: number };
  } | null = null;

  if (existsSync(root)) {
    for await (const file of walkJsonlAsync(root, now - SCAN_HORIZON_MS)) {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
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
        } catch {
          /* skip */
        }
      }
    }
  }

  const quotas: QuotaWindow[] = [];
  const describe = (w?: { used_percent?: number; window_minutes?: number; resets_at?: number }) => {
    if (!w || typeof w.used_percent !== 'number') return;
    const mins = w.window_minutes ?? null;
    const label =
      mins === 300 ? '5-hour' : mins === 10080 ? 'weekly' : mins != null ? `${Math.round(mins / 60)}h` : 'quota';
    quotas.push({
      label,
      usedPercent: w.used_percent,
      resetsAt: w.resets_at != null ? w.resets_at * 1000 : null,
      windowMinutes: mins,
    });
  };
  describe(latestLimits?.primary);
  describe(latestLimits?.secondary);

  return {
    provider: 'codex',
    ...(account ? {
      accountId: account.id,
      accountLabel: account.label,
      ...(account.email ? { accountEmail: account.email } : {}),
    } : {}),
    available: hasReportedUsage(samples),
    planType: latestLimits?.plan,
    windows: windowsFromSamples(samples, now),
    quotas,
    byModel: byModelFromSamples(samples, now),
    updatedAt: now,
  };
}


// ── GitHub Copilot CLI ────────────────────────────────────────────────────────
// ~/.copilot/session-state/<uuid>/events.jsonl — session.shutdown events carry
// data.modelMetrics[model].usage token totals for the whole session.

function readCopilot(now: number): CliUsageReport {
  currentCliProvider = 'copilot';
  const root = join(homedir(), '.copilot', 'session-state');
  const samples: UsageSample[] = [];
  if (existsSync(root)) {
    for (const file of walkJsonl(root, now - SCAN_HORIZON_MS)) {
      if (!file.endsWith('events.jsonl')) continue;
      let st: import('node:fs').Stats;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.includes('modelMetrics')) continue;
        try {
          const row = JSON.parse(line) as {
            data?: {
              modelMetrics?: Record<
                string,
                { usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } }
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
        } catch {
          /* skip */
        }
      }
    }
  }
  return {
    provider: 'copilot',
    available: hasReportedUsage(samples),
    windows: windowsFromSamples(samples, now),
    quotas: [],
    byModel: byModelFromSamples(samples, now),
    updatedAt: now,
  };
}

// ── xAI Grok CLI ─────────────────────────────────────────────────────────────
// ~/.grok/sessions/<cwd>/<session>/signals.json — per-session context token
// totals + models used. Coarser than per-turn logs but real.

function readGrok(now: number): CliUsageReport {
  currentCliProvider = 'grok';
  const root = join(homedir(), '.grok', 'sessions');
  const samples: UsageSample[] = [];
  if (existsSync(root)) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
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
          } catch {
            /* skip */
          }
        }
      }
    }
  }
  return {
    provider: 'grok',
    available: hasReportedUsage(samples),
    windows: windowsFromSamples(samples, now),
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
  } catch {
    /* endpoint is undocumented — degrade silently */
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
  } catch {
    /* internal endpoint — degrade silently */
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getCliUsageReports(opts?: {
  githubToken?: string;
  forceRefresh?: boolean;
}): Promise<CliUsageReport[]> {
  if (!opts?.forceRefresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.reports;
  const now = Date.now();

  // Kick live quota fetches in parallel with the local log scans.
  const quotaJobs = Promise.allSettled([fetchClaudeQuota(), fetchCopilotQuota(opts?.githubToken)]);

  const reports: CliUsageReport[] = [];
  const codexAccounts = discoverCliAccounts().filter((account) => account.provider === 'codex');
  const readers: Array<(now: number) => CliUsageReport | Promise<CliUsageReport>> = [
    readClaude,
    ...(codexAccounts.length > 0
      ? codexAccounts.map((account) => (at: number) => readCodex(at, account))
      : [readCodex]),
    readCopilot,
    readGrok,
  ];
  for (const reader of readers) {
    try {
      const r = await reader(now);
      if (r.available) reports.push(r);
    } catch {
      /* a broken store must not kill billing */
    }
  }
  await quotaJobs;
  for (const r of reports) {
    const q = quotaCache.get(r.provider);
    if (q) {
      r.quotas = [...q.quotas, ...r.quotas.filter((x) => !q.quotas.some((y) => y.label === x.label))];
      if (q.plan && !r.planType) r.planType = q.plan;
    }
  }
  cached = { at: now, reports };
  return reports;
}
