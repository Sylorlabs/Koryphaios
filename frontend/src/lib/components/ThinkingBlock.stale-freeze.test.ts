// @vitest-environment jsdom
import { render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ThinkingBlock from './ThinkingBlock.svelte';

function stopwatchText(container: HTMLElement): string {
  const el = container.querySelector('.stopwatch');
  if (!el?.textContent) throw new Error('stopwatch element missing');
  return el.textContent;
}

describe('ThinkingBlock stale freeze', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('freezes the stopwatch instead of ticking forever when the run dies mid-thought', async () => {
    const startedAt = Date.now() - 60_000;
    const { container } = render(ThinkingBlock, {
      props: {
        text: 'considering…',
        agentName: 'Kory',
        thinkingStartedAt: startedAt,
        finalized: false,
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    // Live while server updates are fresh.
    expect(screen.getByText('Thinking…')).toBeTruthy();
    expect(stopwatchText(container)).toBe('1m 0s');

    // No new server duration for 16s -> the block goes stale.
    await vi.advanceTimersByTimeAsync(16_000);
    expect(screen.getByText('Thought for')).toBeTruthy();
    const frozen = stopwatchText(container);
    // Frozen near the stale moment (~60s + 15s), not reset and not climbing.
    expect(frozen).toBe('1m 15s');

    // Another two minutes pass with no server update: the display must not move.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(screen.queryByText('Thinking…')).toBeNull();
    expect(stopwatchText(container)).toBe(frozen);
  });

  it('keeps ticking while server durations arrive, then freezes at the last value', async () => {
    const startedAt = Date.now() - 10_000;
    const { container, rerender } = render(ThinkingBlock, {
      props: {
        text: 'considering…',
        agentName: 'Kory',
        thinkingStartedAt: startedAt,
        durationMs: 10_000,
        finalized: false,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText('Thinking…')).toBeTruthy();

    // Server keeps reporting: 5s later the duration prop advances.
    await vi.advanceTimersByTimeAsync(5_000);
    await rerender({ durationMs: 15_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText('Thinking…')).toBeTruthy();

    // Then silence: 15s after the last server update the block goes stale
    // and freezes instead of climbing without bound.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(screen.getByText('Thought for')).toBeTruthy();
    const frozen = stopwatchText(container);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(stopwatchText(container)).toBe(frozen);
  });

  it('renders the server duration verbatim once finalized', async () => {
    const { container } = render(ThinkingBlock, {
      props: {
        text: 'done thinking',
        agentName: 'Kory',
        thinkingStartedAt: Date.now() - 600_000,
        durationMs: 42_500,
        finalized: true,
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    // 42.5s -> "42.5s", and no interval keeps running after finalize.
    expect(screen.getByText('Thought for')).toBeTruthy();
    expect(stopwatchText(container)).toBe('42.5s');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(stopwatchText(container)).toBe('42.5s');
  });

  it('shows a restored reasoning block as finished from the first frame', async () => {
    // Reopening a chat replays hours-old reasoning. It has to arrive already
    // final: rendered live it counts up from the ancient start timestamp for
    // the whole staleness window, then relabels itself — the timer and the row
    // change long after the turn actually ended.
    const { container } = render(ThinkingBlock, {
      props: {
        text: 'reasoning from this morning',
        agentName: 'Kory',
        thinkingStartedAt: Date.now() - 7_200_000,
        durationMs: 31_000,
        finalized: true,
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByText('Thought for')).toBeTruthy();
    expect(stopwatchText(container)).toBe('31.0s');

    // Never climbs, and never relabels: no waiting on a staleness watchdog.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stopwatchText(container)).toBe('31.0s');
    expect(screen.queryByText('Thinking…')).toBeNull();
  });

  it('freezes a stale block at the server duration, not at the watchdog moment', async () => {
    // The server last reported 20s of reasoning. When the run then goes quiet
    // the block must stop at 20s: freezing at the moment the watchdog fired
    // would bill the reader for the silence that followed.
    const startedAt = Date.now() - 20_000;
    const { container } = render(ThinkingBlock, {
      props: {
        text: 'considering…',
        agentName: 'Kory',
        thinkingStartedAt: startedAt,
        durationMs: 20_000,
        finalized: false,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopwatchText(container)).toBe('20.0s');

    await vi.advanceTimersByTimeAsync(16_000);
    expect(screen.getByText('Thought for')).toBeTruthy();
    expect(stopwatchText(container)).toBe('20.0s');
  });
});
