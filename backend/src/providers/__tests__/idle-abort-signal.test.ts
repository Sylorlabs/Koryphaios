import { describe, expect, it, vi, afterEach } from 'bun:test';
import {
  createIdleAbortSignal,
  mergeAbortSignals,
} from '../utils';

afterEach(() => {
  vi.useRealTimers();
});

describe('createIdleAbortSignal', () => {
  it('does not abort while activity keeps resetting the deadline', () => {
    vi.useFakeTimers();
    const { signal, reset } = createIdleAbortSignal(60_000);
    expect(signal.aborted).toBe(false);

    // Simulate a stream producing events repeatedly within the window.
    reset();
    vi.advanceTimersByTime(59_000);
    expect(signal.aborted).toBe(false);

    reset();
    vi.advanceTimersByTime(59_000);
    expect(signal.aborted).toBe(false);

    vi.useRealTimers();
  });

  it('aborts after the idle window with no activity', () => {
    vi.useFakeTimers();
    const { signal } = createIdleAbortSignal(60_000);
    expect(signal.aborted).toBe(false);

    vi.advanceTimersByTime(60_000);
    expect(signal.aborted).toBe(true);
    expect((signal.reason as DOMException)?.name).toBe('TimeoutError');

    vi.useRealTimers();
  });

  it('clear stops the timer so it never aborts', () => {
    vi.useFakeTimers();
    const { signal, clear } = createIdleAbortSignal(60_000);
    clear();
    vi.advanceTimersByTime(60_000);
    expect(signal.aborted).toBe(false);

    vi.useRealTimers();
  });
});

describe('mergeAbortSignals', () => {
  it('aborts when any input signal aborts', () => {
    const a = new AbortController();
    const b = new AbortController();
    const merged = mergeAbortSignals(a.signal, b.signal);
    expect(merged.aborted).toBe(false);

    b.abort();
    expect(merged.aborted).toBe(true);
  });

  it('skips undefined entries and merges a single signal', () => {
    const a = new AbortController();
    expect(mergeAbortSignals(undefined, a.signal, undefined)).toBe(a.signal);
    expect(mergeAbortSignals().aborted).toBe(false);
  });
});
