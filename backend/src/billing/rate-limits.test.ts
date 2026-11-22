import { beforeEach, describe, expect, test } from 'bun:test';
import {
  clearProviderRateLimits,
  getProviderRateLimitSnapshots,
  recordProviderRateLimit,
} from './rate-limits';

describe('provider rate-limit capture', () => {
  beforeEach(() => clearProviderRateLimits());

  test('records real request and token windows from response headers', () => {
    recordProviderRateLimit(
      'logfare',
      'deepseek-v4.1-flash-1017',
      new Headers({
        'x-ratelimit-limit-requests': '80',
        'x-ratelimit-remaining-requests': '77',
        'x-ratelimit-reset-requests': '43s',
        'x-ratelimit-limit-tokens': '200000',
        'x-ratelimit-remaining-tokens': '198000',
        'x-ratelimit-reset-tokens': '22m',
      }),
      200,
    );

    const [snapshot] = getProviderRateLimitSnapshots();
    expect(snapshot?.provider).toBe('logfare');
    expect(snapshot?.model).toBe('deepseek-v4.1-flash-1017');
    expect(snapshot?.status).toBe('ok');
    expect(snapshot?.requests).toEqual({ limit: 80, remaining: 77, reset: '43s' });
    expect(snapshot?.tokens).toEqual({
      limit: 200000,
      remaining: 198000,
      reset: '22m',
    });
  });

  test('retains a 429 retry-after even when no limit headers are present', () => {
    recordProviderRateLimit('logfare', undefined, new Headers({ 'retry-after': '17' }), 429);

    expect(getProviderRateLimitSnapshots()[0]).toMatchObject({
      provider: 'logfare',
      status: 'rate_limited',
      retryAfterSeconds: 17,
    });
  });

  test('ignores responses that report no quota signal', () => {
    recordProviderRateLimit('openai', 'gpt-test', new Headers(), 200);
    expect(getProviderRateLimitSnapshots()).toEqual([]);
  });
});
