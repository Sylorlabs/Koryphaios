import { describe, expect, test } from 'bun:test';
import {
  AUTO_COMPACT_COOLDOWN_MS,
  AUTO_COMPACT_MAX_ATTEMPTS,
  AUTO_COMPACT_RETRY_BASE_DELAY_MS,
  AUTO_COMPACT_RETRY_MAX_DELAY_MS,
  autoCompactRetryDelayMs,
  isAutoCompactCoolingDown,
  isAutoCompactRetryable,
  withAutoCompactRetry,
} from '../auto-compact';

describe('auto-compact retry policy', () => {
  test('backs off exponentially and caps the delay', () => {
    expect(autoCompactRetryDelayMs(0)).toBe(AUTO_COMPACT_RETRY_BASE_DELAY_MS);
    expect(autoCompactRetryDelayMs(1)).toBe(AUTO_COMPACT_RETRY_BASE_DELAY_MS * 2);
    expect(autoCompactRetryDelayMs(2)).toBe(AUTO_COMPACT_RETRY_BASE_DELAY_MS * 4);
    expect(autoCompactRetryDelayMs(100)).toBe(AUTO_COMPACT_RETRY_MAX_DELAY_MS);
    expect(autoCompactRetryDelayMs(-1)).toBe(AUTO_COMPACT_RETRY_BASE_DELAY_MS);
  });

  test('cools down for five minutes after a failure', () => {
    const now = 1_000_000;
    expect(isAutoCompactCoolingDown(undefined, now)).toBe(false);
    expect(isAutoCompactCoolingDown(now - 60_000, now)).toBe(true);
    expect(isAutoCompactCoolingDown(now - AUTO_COMPACT_COOLDOWN_MS, now)).toBe(false);
    expect(isAutoCompactCoolingDown(now - AUTO_COMPACT_COOLDOWN_MS - 1, now)).toBe(false);
    expect(isAutoCompactCoolingDown(now + 1_000, now)).toBe(true);
    expect(AUTO_COMPACT_COOLDOWN_MS).toBe(5 * 60_000);
  });

  test('never retries cancellation', () => {
    expect(isAutoCompactRetryable(new DOMException('aborted', 'AbortError'))).toBe(false);
    const named = new Error('cancelled');
    named.name = 'AbortError';
    expect(isAutoCompactRetryable(named)).toBe(false);
    expect(isAutoCompactRetryable(new Error('JSON Parse error'))).toBe(true);
    expect(isAutoCompactRetryable(new Error('provider unavailable'))).toBe(true);
    expect(isAutoCompactRetryable('string failure')).toBe(true);
  });

  test('succeeds on the first attempt without sleeping', async () => {
    const sleeps: number[] = [];
    const outcome = await withAutoCompactRetry(async () => 'checkpoint', {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(outcome).toMatchObject({ ok: true, attempts: 1, result: 'checkpoint' });
    expect(sleeps).toEqual([]);
  });

  test('retries twice with exponential backoff, then succeeds', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const outcome = await withAutoCompactRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error(`attempt ${calls} failed`);
        return 'checkpoint';
      },
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(outcome).toMatchObject({ ok: true, attempts: 3, result: 'checkpoint' });
    expect(sleeps).toEqual([
      AUTO_COMPACT_RETRY_BASE_DELAY_MS,
      AUTO_COMPACT_RETRY_BASE_DELAY_MS * 2,
    ]);
  });

  test('gives up after the bounded attempts and reports the last error', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const outcome = await withAutoCompactRetry(
      async () => {
        calls++;
        throw new Error('compactor keeps failing');
      },
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(AUTO_COMPACT_MAX_ATTEMPTS);
    expect((outcome.error as Error).message).toBe('compactor keeps failing');
    expect(calls).toBe(AUTO_COMPACT_MAX_ATTEMPTS);
    expect(sleeps).toHaveLength(AUTO_COMPACT_MAX_ATTEMPTS - 1);
  });

  test('does not retry an aborted compaction', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const outcome = await withAutoCompactRetry(
      async () => {
        calls++;
        throw new DOMException('aborted', 'AbortError');
      },
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(1);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });
});
