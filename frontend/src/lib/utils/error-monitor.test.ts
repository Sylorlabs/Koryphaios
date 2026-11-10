import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/demo-flags', () => ({ isDemoMode: false }));

import {
  disposeErrorMonitoring,
  getStallSnapshot,
  heartbeatGapIsStall,
  initErrorMonitoring,
  initStallMonitoring,
  MONITOR_MAX_BATCH_BYTES,
  recordRendererStall,
  reportStall,
  resetStallMonitoring,
  summarizeMonitorValue,
} from './error-monitor';

afterEach(() => {
  disposeErrorMonitoring();
  resetStallMonitoring();
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

describe('renderer stall monitor', () => {
  test('tracks worst gap, counts longtasks, and caps the ring', () => {
    expect(getStallSnapshot()).toEqual({ worstFrameGapMs: 0, longTaskCount: 0, recentStalls: [] });
    recordRendererStall({ at: 1, durationMs: 3_500, source: 'heartbeat' });
    recordRendererStall({ at: 2, durationMs: 1_200, source: 'longtask' });
    for (let i = 0; i < 12; i++) {
      recordRendererStall({ at: 10 + i, durationMs: 100 + i, source: 'heartbeat' });
    }
    const snapshot = getStallSnapshot();
    expect(snapshot.worstFrameGapMs).toBe(3_500);
    expect(snapshot.longTaskCount).toBe(1);
    expect(snapshot.recentStalls).toHaveLength(10);
    // Oldest entries evicted first.
    expect(snapshot.recentStalls[0]).toMatchObject({ at: 12, durationMs: 102 });
  });

  test('reset clears stall state', () => {
    recordRendererStall({ at: 1, durationMs: 9_000, source: 'heartbeat' });
    resetStallMonitoring();
    expect(getStallSnapshot()).toEqual({ worstFrameGapMs: 0, longTaskCount: 0, recentStalls: [] });
  });

  test('heartbeat gap is a stall only when timers were starved with frames', () => {
    // Frozen main thread: the last poll predates the last frame.
    expect(heartbeatGapIsStall(1_000, 1_500)).toBe(true);
    // Scheduling slack: a poll a few hundred ms past the last frame still
    // means it fired while frames were running.
    expect(heartbeatGapIsStall(1_900, 1_500)).toBe(true);
    // Not painting (boot/occlusion): timers kept firing long after the last
    // frame, so the gap is a paused frame loop, not a frozen main thread.
    expect(heartbeatGapIsStall(5_000, 1_500)).toBe(false);
  });

  test('records stalls during startup grace without logging a console error', () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    initStallMonitoring();
    reportStall(4_200, 'heartbeat');
    expect(getStallSnapshot().recentStalls).toHaveLength(1);
    expect(getStallSnapshot().worstFrameGapMs).toBe(4_200);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('logs a stall once monitoring is past the startup grace window', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Never initialized here, so the grace window does not apply.
    reportStall(5_000, 'longtask');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
