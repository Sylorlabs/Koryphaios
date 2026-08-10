import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/demo-flags', () => ({ isDemoMode: false }));

import {
  disposeErrorMonitoring,
  initErrorMonitoring,
  MONITOR_MAX_BATCH_BYTES,
  summarizeMonitorValue,
} from './error-monitor';

afterEach(() => {
  disposeErrorMonitoring();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('frontend error monitor confidentiality boundary', () => {
  test('summarizes cyclic and oversized values without retaining content', () => {
    const sentinel = 'SYNTHETIC_PRIVATE_PROMPT_61cbe7';
    const value: Record<string, unknown> = {
      prompt: sentinel,
      output: sentinel.repeat(10_000),
      items: Array.from({ length: 100 }, () => sentinel),
      error: new Error(sentinel),
    };
    value.self = value;

    const serialized = JSON.stringify(summarizeMonitorValue(value));

    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain('prompt');
    expect(serialized).not.toContain('output');
    expect(serialized).toContain('circular');
    expect(serialized).toContain('truncated');
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(8_192);
  });

  test('keeps synthetic content out of the actual console and bounded network batch', async () => {
    vi.useFakeTimers();
    const sentinel = 'SYNTHETIC_PRIVATE_CONSOLE_CONTENT_f024';
    const originalError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const originalWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(String(init?.body ?? ''));
        return new Response('{}', { status: 200 });
      }),
    );

    initErrorMonitoring();
    const cyclic: Record<string, unknown> = { prompt: sentinel };
    cyclic.self = cyclic;
    console.error(sentinel, new Error(sentinel), cyclic, sentinel.repeat(20_000));
    console.warn(
      sentinel,
      Array.from({ length: 100 }, () => sentinel),
    );

    await vi.advanceTimersByTimeAsync(1_100);

    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toContain(sentinel);
    expect(new TextEncoder().encode(requests[0]).byteLength).toBeLessThanOrEqual(
      MONITOR_MAX_BATCH_BYTES,
    );
    const consoleOutput = JSON.stringify([...originalError.mock.calls, ...originalWarn.mock.calls]);
    expect(consoleOutput).not.toContain(sentinel);
    expect(new TextEncoder().encode(consoleOutput).byteLength).toBeLessThan(8_192);
  });
});
