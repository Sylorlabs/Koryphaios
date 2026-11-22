// Devin CLI account status — plan, quota windows and reset times.
//
// The Devin CLI owns its credentials at ~/.local/share/devin/credentials.toml
// (windsurf_api_key + api_server_url). The CLI's own account probe is the
// Connect RPC `exa.seat_management_pb.SeatManagementService/GetUserStatus`
// against that server: `user_status.plan_status` carries the plan name/tier,
// daily/weekly quota remaining percentages, reset timestamps, plan start/end,
// credit balances and ACU consumption. Verified live against devin
// 3000.14.30821 — the request requires `connect-protocol-version: 1` and a
// metadata block with apiKey + ide/extension identity fields.
//
// This module reads the credentials file only (never logs it, never forwards
// it anywhere except the provider's own account endpoint over TLS), caches by
// file revision, and degrades to stale/unavailable rather than blocking model
// discovery or chat when the fetch fails.

import { statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEVIN_ACCOUNT_TTL_MS = 30_000;
const DEVIN_ACCOUNT_TIMEOUT_MS = 10_000;

export interface DevinQuotaWindow {
  remainingPercent: number;
  resetAtMs: number | null;
  /** The provider hides this window from its own UI for some plans (e.g. Max
   *  hides the daily window). Koryphaios respects that rather than inventing a
   *  limit display the provider deliberately omits. */
  hidden: boolean;
}

export interface DevinAccountSnapshot {
  source: 'devin-account';
  status: 'fresh' | 'stale' | 'unavailable';
  updatedAt?: number;
  note?: string;
  /** `plan_info.plan_name` — e.g. "Max". */
  planName?: string;
  /** Human label for `teams_tier` — e.g. "Devin Max". */
  tierLabel?: string;
  /** Preferred planType display: tier label, falling back to plan name. */
  planType?: string;
  email?: string;
  accountDisplayName?: string;
  billingStrategy?: string;
  dailyQuota?: DevinQuotaWindow;
  weeklyQuota?: DevinQuotaWindow;
  planStart?: string;
  planEnd?: string;
  /** -1 means unlimited on this plan. */
  availablePromptCredits?: number;
  monthlyPromptCredits?: number;
  acuConsumed?: number;
  acuLimit?: number;
  overageBalanceMicros?: number;
  requestUsageActionLabel?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max = 512): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

/** Numbers arrive as JSON numbers or proto-int64 strings. */
function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return undefined;
}

function unixMs(value: unknown): number | null {
  const n = num(value);
  return n !== undefined && n > 0 ? n * 1000 : null;
}

/** `TEAMS_TIER_DEVIN_MAX` → "Devin Max". */
function tierLabel(value: unknown): string | undefined {
  if (!text(value, 128)) return undefined;
  const stripped = value.replace(/^TEAMS_TIER_/, '').replace(/_/g, ' ').toLowerCase();
  if (!stripped || stripped === value.toLowerCase()) return undefined;
  return stripped
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

export function parseDevinAccountStatus(value: unknown, now: number): DevinAccountSnapshot {
  if (!record(value) || !record(value.userStatus)) {
    throw new Error('Invalid Devin account response');
  }
  const user = value.userStatus;
  const plan = record(user.planStatus) ? user.planStatus : {};
  const info = record(plan.planInfo) ? plan.planInfo : {};
  const devinInfo = record(info.devinInfo) ? info.devinInfo : {};
  const action = record(devinInfo.requestUsageAction) ? devinInfo.requestUsageAction : {};

  const planName = text(info.planName, 128) ? info.planName : undefined;
  const tier = tierLabel(info.teamsTier ?? user.teamsTier);
  const snapshot: DevinAccountSnapshot = {
    source: 'devin-account',
    status: 'fresh',
    updatedAt: now,
    planType: tier ?? planName,
    planName,
    tierLabel: tier,
    email: text(user.email, 254) ? user.email : undefined,
    accountDisplayName: text(devinInfo.accountDisplayName, 128)
      ? devinInfo.accountDisplayName
      : undefined,
    billingStrategy: text(info.billingStrategy, 128) ? info.billingStrategy : undefined,
    planStart: text(plan.planStart, 64) ? plan.planStart : undefined,
    planEnd: text(plan.planEnd, 64) ? plan.planEnd : undefined,
    availablePromptCredits: num(plan.availablePromptCredits),
    monthlyPromptCredits: num(info.monthlyPromptCredits),
    acuConsumed: num(plan.acuConsumed),
    acuLimit: num(plan.acuLimit),
    overageBalanceMicros: num(plan.overageBalanceMicros),
    requestUsageActionLabel: text(action.label, 256) ? action.label : undefined,
  };
  const daily = num(plan.dailyQuotaRemainingPercent);
  if (daily !== undefined) {
    snapshot.dailyQuota = {
      remainingPercent: daily,
      resetAtMs: unixMs(plan.dailyQuotaResetAtUnix),
      hidden: info.hideDailyQuota === true,
    };
  }
  const weekly = num(plan.weeklyQuotaRemainingPercent);
  if (weekly !== undefined) {
    snapshot.weeklyQuota = {
      remainingPercent: weekly,
      resetAtMs: unixMs(plan.weeklyQuotaResetAtUnix),
      hidden: info.hideWeeklyQuota === true,
    };
  }
  return snapshot;
}

interface DevinCredentials {
  apiKey: string;
  apiServerUrl: string;
}

/** Read only the two scalar keys this module needs out of the CLI-owned TOML.
 *  The file is small and line-based (`key = "value"`); a TOML dependency would
 *  be heavier than the surface we consume. */
export function readDevinCredentials(
  path = join(homedir(), '.local', 'share', 'devin', 'credentials.toml'),
): DevinCredentials | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const pick = (key: string): string | undefined => {
    const match = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm'));
    return match?.[1];
  };
  const apiKey = pick('windsurf_api_key');
  if (!apiKey) return null;
  return {
    apiKey,
    apiServerUrl: pick('api_server_url') ?? 'https://server.codeium.com',
  };
}

interface CacheEntry {
  revision: string;
  attemptedAt: number;
  value: DevinAccountSnapshot;
  inFlight?: Promise<DevinAccountSnapshot>;
}

const cache = new Map<string, CacheEntry>();
const CREDENTIALS_PATH = join(homedir(), '.local', 'share', 'devin', 'credentials.toml');

export interface DevinAccountDependencies {
  fetch: typeof fetch;
  now: () => number;
  credentialsPath?: string;
  version?: string;
}

export async function getDevinAccountSnapshot(
  force = false,
  deps: DevinAccountDependencies = { fetch, now: Date.now },
): Promise<DevinAccountSnapshot> {
  const credentialsPath = deps.credentialsPath ?? CREDENTIALS_PATH;
  let revision: string;
  try {
    const stat = statSync(credentialsPath);
    revision = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    cache.delete(credentialsPath);
    return {
      source: 'devin-account',
      status: 'unavailable',
      note: 'Devin CLI login is required. Run "devin auth login" and refresh billing.',
    };
  }
  const credentials = readDevinCredentials(credentialsPath);
  if (!credentials) {
    return {
      source: 'devin-account',
      status: 'unavailable',
      note: 'Devin credentials file has no session token. Run "devin auth login".',
    };
  }
  const previous = cache.get(credentialsPath);
  const existing = previous?.revision === revision ? previous : undefined;
  if (existing?.inFlight) return existing.inFlight;
  if (!force && existing && deps.now() - existing.attemptedAt < DEVIN_ACCOUNT_TTL_MS) {
    return existing.value;
  }
  const state: CacheEntry = existing ?? {
    revision,
    attemptedAt: 0,
    value: { source: 'devin-account', status: 'unavailable' },
  };
  state.attemptedAt = deps.now();
  // The server rejects a bare apiKey metadata block; the CLI sends its own
  // ide/extension identity. Resolve the installed version lazily so this
  // module never pays a probe it does not need.
  let version = deps.version;
  if (!version) {
    try {
      const { getDevinCapabilities } = require('./devin-capabilities') as typeof import('./devin-capabilities');
      version = getDevinCapabilities().version ?? '0';
    } catch {
      version = '0';
    }
  } else {
    version = version || '0';
  }
  state.inFlight = deps
    .fetch(
      `${credentials.apiServerUrl}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.apiKey}`,
          'Content-Type': 'application/json',
          'connect-protocol-version': '1',
        },
        body: JSON.stringify({
          metadata: {
            apiKey: credentials.apiKey,
            ide_name: 'devin-cli',
            ide_version: version,
            extension_name: 'devin',
            extension_version: version,
          },
        }),
        signal: AbortSignal.timeout(DEVIN_ACCOUNT_TIMEOUT_MS),
        redirect: 'error',
      },
    )
    .then(async (response) => {
      if (!response.ok) throw new Error(`Devin account request failed (${response.status})`);
      return parseDevinAccountStatus(await response.json(), deps.now());
    })
    .then((value) => {
      state.value = value;
      return value;
    })
    .catch(() => {
      // Never forward fetch errors, response bodies, headers, or tokens.
      state.value = {
        ...state.value,
        status: state.value.planType ? 'stale' : 'unavailable',
        note: 'Devin account refresh failed. Check the CLI login, then refresh billing.',
      };
      return state.value;
    })
    .finally(() => {
      state.inFlight = undefined;
    });
  cache.set(credentialsPath, state);
  return state.inFlight;
}

export function resetDevinAccountCacheForTests(): void {
  cache.clear();
}

// ─── Provider quota groups (GET /api/providers/:name/quota) ─────────────────

export interface DevinQuotaGroup {
  name: string;
  description: string;
  buckets: Array<{
    id: string;
    name: string;
    window: string;
    remainingFraction: number;
    resetTime: string;
  }>;
}

/** Shape the account snapshot into the quota-groups contract the provider
 *  route serves. Returns null when no account data exists — the route then
 *  reports `available: false` rather than inventing limits. */
export function devinQuotaGroupsFrom(snapshot: DevinAccountSnapshot): DevinQuotaGroup[] | null {
  if (snapshot.status === 'unavailable') return null;
  const buckets: DevinQuotaGroup['buckets'] = [];
  if (snapshot.dailyQuota) {
    buckets.push({
      id: 'daily',
      name: snapshot.dailyQuota.hidden ? 'Daily quota (hidden by plan)' : 'Daily quota',
      window: 'daily',
      remainingFraction: Math.max(0, Math.min(1, snapshot.dailyQuota.remainingPercent / 100)),
      resetTime: snapshot.dailyQuota.resetAtMs
        ? new Date(snapshot.dailyQuota.resetAtMs).toISOString()
        : '',
    });
  }
  if (snapshot.weeklyQuota) {
    buckets.push({
      id: 'weekly',
      name: snapshot.weeklyQuota.hidden ? 'Weekly quota (hidden by plan)' : 'Weekly quota',
      window: 'weekly',
      remainingFraction: Math.max(0, Math.min(1, snapshot.weeklyQuota.remainingPercent / 100)),
      resetTime: snapshot.weeklyQuota.resetAtMs
        ? new Date(snapshot.weeklyQuota.resetAtMs).toISOString()
        : '',
    });
  }
  const details: string[] = [];
  if (snapshot.planType) details.push(`Plan: ${snapshot.planType}`);
  if (snapshot.planStart && snapshot.planEnd) {
    details.push(`Cycle ${snapshot.planStart.slice(0, 10)} → ${snapshot.planEnd.slice(0, 10)}`);
  }
  if (snapshot.availablePromptCredits !== undefined && snapshot.availablePromptCredits >= 0) {
    details.push(`Prompt credits: ${snapshot.availablePromptCredits}`);
  }
  if (snapshot.acuConsumed !== undefined && snapshot.acuLimit !== undefined) {
    details.push(`ACU ${snapshot.acuConsumed}/${snapshot.acuLimit}`);
  }
  if (snapshot.status === 'stale') details.push('stale — refresh failed');
  return [
    {
      name: snapshot.accountDisplayName
        ? `Devin account (${snapshot.accountDisplayName})`
        : 'Devin account',
      description: details.join(' · ') || 'Devin subscription account',
      buckets,
    },
  ];
}
