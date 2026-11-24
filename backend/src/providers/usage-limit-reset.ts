/**
 * When does a provider usage limit reset, and how long to wait when it does not say.
 *
 * Pure functions only. Each provider reports its reset differently, so callers
 * pass whatever they have: response headers, the provider's own account fields,
 * or the error text. A parsed time is advisory: the auto-resume re-admits the
 * turn at that time, and a turn that still hits the limit reschedules on the
 * conservative backoff below.
 */

/** Wait this long after a limit when the provider gives no reset time: 15m, 1h, 3h. */
export const USAGE_LIMIT_BACKOFF_MS = [15 * 60_000, 60 * 60_000, 3 * 60 * 60_000] as const;
export const USAGE_LIMIT_MAX_ATTEMPTS = USAGE_LIMIT_BACKOFF_MS.length;

/** A provider reset further away than this is treated as unreliable, not a schedule. */
const MAX_PROVIDER_RESET_AHEAD_MS = 7 * 24 * 60 * 60_000;
/** Resume a little after a stated reset so the provider has certainly rolled over. */
const RESET_GRACE_MS = 60_000;

export type UsageLimitResetSource =
  'retry_after' | 'reset_header' | 'account_field' | 'reset_text' | 'backoff';

export interface UsageLimitReset {
  /** Epoch ms of the next automatic attempt. */
  resumeAt: number;
  source: UsageLimitResetSource;
}

export interface UsageLimitResetHints {
  /** Raw `Retry-After` header: delta seconds or an HTTP date. */
  retryAfter?: string | null;
  /** Raw `x-ratelimit-reset` style header: delta seconds, epoch seconds, or epoch ms. */
  resetHeader?: string | null;
  /** Epoch seconds from a provider account record (Devin/Freebuff quota reset fields). */
  accountResetAtUnix?: number | null;
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** Epoch ms for a reset that is genuinely in the future and not absurdly far away. */
function usableFuture(resetAt: number, now: number): number | null {
  if (!Number.isFinite(resetAt)) return null;
  if (resetAt <= now) return null;
  if (resetAt - now > MAX_PROVIDER_RESET_AHEAD_MS) return null;
  return resetAt;
}

/** `Retry-After`: delta seconds, or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now: number): number | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return usableFuture(now + Number(raw) * 1_000, now);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : usableFuture(date, now);
}

/**
 * `x-ratelimit-reset` and kin. Providers disagree on the unit, so the magnitude
 * decides: values past 1e12 are epoch ms, past 1e9 epoch seconds, anything
 * smaller is a delta in seconds.
 */
export function parseResetHeader(value: string | null | undefined, now: number): number | null {
  const raw = value?.trim();
  if (!raw || !/^\d+(\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  if (n > 1e12) return usableFuture(n, now);
  if (n > 1e9) return usableFuture(n * 1_000, now);
  return usableFuture(now + n * 1_000, now);
}

/** Account quota reset fields are epoch seconds (Devin GetUserStatus, Freebuff account). */
export function resetFromAccountUnix(
  unixSeconds: number | null | undefined,
  now: number,
): number | null {
  if (typeof unixSeconds !== 'number' || !Number.isFinite(unixSeconds) || unixSeconds <= 0) {
    return null;
  }
  return usableFuture(unixSeconds * 1_000, now);
}

/** Epoch ms for a local clock time on the day `now` falls on, or the next day if that has passed. */
function localClock(now: number, hour: number, minute: number, second = 0): number | null {
  if (hour > 23 || minute > 59 || second > 59) return null;
  const base = new Date(now);
  const candidate = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    hour,
    minute,
    second,
  ).getTime();
  if (candidate > now) return candidate;
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate() + 1,
    hour,
    minute,
    second,
  ).getTime();
}

const RESET_AT_CLOCK =
  /\b(?:resets?|reset|try again|available|retry)\s+(?:at|after)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
const RESET_IN_DURATION =
  /\b(?:resets?|try again|retry|available)\s+in\s+((?:\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\s*,?\s*(?:and\s+)?)+)/i;
const ISO_TIMESTAMP =
  /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)\b/;
const MONTH_DAY_TIME =
  /\b(?:resets?|try again)\s+(?:on\s+)?([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})?,?\s*(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?/i;

function clockTo24(hour: number, meridiem: string | undefined): number {
  const pm = meridiem?.toLowerCase() === 'pm';
  const am = meridiem?.toLowerCase() === 'am';
  if (am && hour === 12) return 0;
  if (pm && hour < 12) return hour + 12;
  return hour;
}

/**
 * A reset time named in provider error text: "resets at 3:40 PM", "try again at
 * 15:40", "try again in 2 hours 15 minutes", "resets Dec 1, 2026 9:00 AM", or an
 * ISO timestamp. Clock times are the host's local time.
 */
export function parseResetFromText(text: string, now: number): number | null {
  if (!text) return null;

  const iso = ISO_TIMESTAMP.exec(text);
  if (iso) {
    const parsed = Date.parse(iso[1]!);
    const usable = usableFuture(parsed, now);
    if (usable !== null) return usable;
  }

  const duration = RESET_IN_DURATION.exec(text);
  if (duration) {
    let ms = 0;
    const parts = duration[1]!.matchAll(
      /(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi,
    );
    for (const [, amountRaw, unit] of parts) {
      const amount = Number(amountRaw);
      const u = unit!.toLowerCase();
      if (u.startsWith('h')) ms += amount * 3_600_000;
      else if (u.startsWith('m')) ms += amount * 60_000;
      else ms += amount * 1_000;
    }
    return usableFuture(now + ms, now);
  }

  const monthDay = MONTH_DAY_TIME.exec(text);
  if (monthDay) {
    const month = MONTHS[monthDay[1]!.slice(0, 3).toLowerCase()];
    if (month !== undefined) {
      const year = monthDay[3] ? Number(monthDay[3]) : new Date(now).getFullYear();
      const hour = clockTo24(Number(monthDay[4]), monthDay[6]);
      const at = new Date(year, month, Number(monthDay[2]), hour, Number(monthDay[5])).getTime();
      const usable = usableFuture(at, now);
      if (usable !== null) return usable;
    }
  }

  const clock = RESET_AT_CLOCK.exec(text);
  if (clock) {
    const hour = clockTo24(Number(clock[1]), clock[3]);
    const local = localClock(now, hour, Number(clock[2] ?? 0));
    if (local !== null) return usableFuture(local, now);
  }
  return null;
}

/**
 * The best reset time the provider gave, with where it came from. Headers and
 * account fields beat text, since they are structured.
 */
export function parseUsageLimitReset(
  text: string,
  now: number,
  hints: UsageLimitResetHints = {},
): UsageLimitReset | null {
  const retry = parseRetryAfter(hints.retryAfter, now);
  if (retry !== null) return { resumeAt: retry + RESET_GRACE_MS, source: 'retry_after' };
  const header = parseResetHeader(hints.resetHeader, now);
  if (header !== null) return { resumeAt: header + RESET_GRACE_MS, source: 'reset_header' };
  const account = resetFromAccountUnix(hints.accountResetAtUnix, now);
  if (account !== null) return { resumeAt: account + RESET_GRACE_MS, source: 'account_field' };
  const fromText = parseResetFromText(text, now);
  if (fromText !== null) return { resumeAt: fromText + RESET_GRACE_MS, source: 'reset_text' };
  return null;
}

/**
 * Next automatic attempt. A stated reset wins. Otherwise the conservative
 * backoff applies, indexed by how many automatic attempts already ran.
 */
export function nextUsageLimitResume(input: {
  now: number;
  /** Automatic attempts already made. 0 schedules the first retry. */
  attempt: number;
  reset?: UsageLimitReset | null;
}): UsageLimitReset {
  if (input.reset && input.reset.resumeAt > input.now) return input.reset;
  const index = Math.min(Math.max(0, input.attempt), USAGE_LIMIT_MAX_ATTEMPTS - 1);
  return { resumeAt: input.now + USAGE_LIMIT_BACKOFF_MS[index]!, source: 'backoff' };
}
