import { describe, expect, test } from 'bun:test';
import {
  nextUsageLimitResume,
  parseResetFromText,
  parseResetHeader,
  parseRetryAfter,
  parseUsageLimitReset,
  resetFromAccountUnix,
  USAGE_LIMIT_BACKOFF_MS,
} from './usage-limit-reset';

/** A fixed local morning so clock-time parsing is deterministic in any timezone. */
const NOW = new Date(2026, 10, 24, 9, 0, 0, 0).getTime();
const MINUTE = 60_000;

describe('reset text parsing', () => {
  test('Claude/Codex "resets at" clock times use the host local time, rolled to the next day when past', () => {
    const at340 = parseResetFromText('Usage limit reached. Your limit resets at 3:40 PM.', NOW);
    expect(at340).toBe(new Date(2026, 10, 24, 15, 40).getTime());

    const passed = parseResetFromText('Usage limit reached, try again at 8:15 am', NOW);
    expect(passed).toBe(new Date(2026, 10, 25, 8, 15).getTime());
  });

  test('24-hour clock and meridiem edge cases', () => {
    expect(parseResetFromText('resets at 15:40', NOW)).toBe(new Date(2026, 10, 24, 15, 40).getTime());
    expect(parseResetFromText('resets at 12:05 am', NOW)).toBe(
      new Date(2026, 10, 25, 0, 5).getTime(),
    );
    expect(parseResetFromText('resets at 12:30 pm', NOW)).toBe(
      new Date(2026, 10, 24, 12, 30).getTime(),
    );
  });

  test('relative durations are added to now', () => {
    expect(parseResetFromText('Try again in 2 hours 15 minutes.', NOW)).toBe(
      NOW + 135 * MINUTE,
    );
    expect(parseResetFromText('retry in 45 minutes', NOW)).toBe(NOW + 45 * MINUTE);
  });

  test('ISO timestamps in the future are used; past ones are not', () => {
    const future = '2026-11-24T18:00:00Z';
    expect(parseResetFromText(`resets ${future}`, NOW)).toBe(Date.parse(future));
    expect(parseResetFromText('reset 2020-01-01T00:00:00Z', NOW)).toBeNull();
  });

  test('explicit month and day with a time', () => {
    expect(parseResetFromText('Your limit resets Dec 1, 2026 9:00 AM', NOW)).toBe(
      new Date(2026, 11, 1, 9, 0).getTime(),
    );
  });

  test('text without a reset clause yields nothing, and a bare clock time is not trusted', () => {
    expect(parseResetFromText('Usage limit reached', NOW)).toBeNull();
    expect(parseResetFromText('the meeting is at 3:40 pm', NOW)).toBeNull();
  });
});

describe('header and account reset parsing', () => {
  test('Retry-After as delta seconds and as an HTTP date', () => {
    expect(parseRetryAfter('120', NOW)).toBe(NOW + 120_000);
    const httpDate = new Date(NOW + 3_600_000).toUTCString();
    expect(parseRetryAfter(httpDate, NOW)).toBe(Math.floor((NOW + 3_600_000) / 1000) * 1000);
    expect(parseRetryAfter('not a date', NOW)).toBeNull();
  });

  test('x-ratelimit-reset is epoch seconds, epoch ms, or a delta, by magnitude', () => {
    const epochSeconds = Math.floor(NOW / 1000) + 600;
    expect(parseResetHeader(String(epochSeconds), NOW)).toBe(epochSeconds * 1000);
    expect(parseResetHeader(String(NOW + 900_000), NOW)).toBe(NOW + 900_000);
    expect(parseResetHeader('30', NOW)).toBe(NOW + 30_000);
    expect(parseResetHeader('soon', NOW)).toBeNull();
  });

  test('account quota reset fields (epoch seconds) are used when in the future', () => {
    expect(resetFromAccountUnix(Math.floor(NOW / 1000) + 3600, NOW)).toBe(
      (Math.floor(NOW / 1000) + 3600) * 1000,
    );
    expect(resetFromAccountUnix(1, NOW)).toBeNull();
    expect(resetFromAccountUnix(null, NOW)).toBeNull();
  });

  test('a reset more than seven days away is ignored as unreliable', () => {
    expect(parseRetryAfter(String(10 * 24 * 3600), NOW)).toBeNull();
  });
});

describe('parseUsageLimitReset precedence and grace', () => {
  test('structured hints beat text; a grace period is added after the stated reset', () => {
    const reset = parseUsageLimitReset('resets at 3:40 PM', NOW, { retryAfter: '600' });
    expect(reset).toEqual({ resumeAt: NOW + 600_000 + 60_000, source: 'retry_after' });

    const fromText = parseUsageLimitReset('resets at 3:40 PM', NOW);
    expect(fromText?.source).toBe('reset_text');
    expect(fromText?.resumeAt).toBe(new Date(2026, 10, 24, 15, 40).getTime() + 60_000);
  });

  test('no hints and no text gives no reset', () => {
    expect(parseUsageLimitReset('usage limit reached', NOW)).toBeNull();
  });
});

describe('conservative backoff', () => {
  test('without a provider reset the schedule is 15m, 1h, 3h', () => {
    expect(USAGE_LIMIT_BACKOFF_MS).toEqual([15 * MINUTE, 60 * MINUTE, 180 * MINUTE]);
    expect(nextUsageLimitResume({ now: NOW, attempt: 0 })).toEqual({
      resumeAt: NOW + 15 * MINUTE,
      source: 'backoff',
    });
    expect(nextUsageLimitResume({ now: NOW, attempt: 1 }).resumeAt).toBe(NOW + 60 * MINUTE);
    expect(nextUsageLimitResume({ now: NOW, attempt: 2 }).resumeAt).toBe(NOW + 180 * MINUTE);
    // Past the schedule the last step is reused; the service caps attempts itself.
    expect(nextUsageLimitResume({ now: NOW, attempt: 9 }).resumeAt).toBe(NOW + 180 * MINUTE);
  });

  test('a future provider reset is preferred over the backoff', () => {
    const reset = { resumeAt: NOW + 5 * MINUTE, source: 'reset_text' as const };
    expect(nextUsageLimitResume({ now: NOW, attempt: 0, reset })).toEqual(reset);
  });

  test('a provider reset that has already passed falls back to the backoff', () => {
    const stale = { resumeAt: NOW - MINUTE, source: 'reset_text' as const };
    expect(nextUsageLimitResume({ now: NOW, attempt: 0, reset: stale })).toEqual({
      resumeAt: NOW + 15 * MINUTE,
      source: 'backoff',
    });
  });
});
