// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { legacyTurnParts } from '@koryphaios/shared';
import ThinkingBlock from './ThinkingBlock.svelte';
import { partsToFeedEntries } from '$lib/stores/transcript-turns';

describe('ThinkingBlock with an unknown duration', () => {
  it('says "time unknown" instead of a stopwatch, keeping tokens and expand', async () => {
    const { container } = render(ThinkingBlock, {
      props: {
        text: 'Weighing the options.',
        agentName: 'Kory',
        thinkingStartedAt: 1_000,
        durationMs: 0,
        finalized: true,
        thinkingTokens: 1234,
        timeUnknown: true,
      },
    });

    const row = container.querySelector('.thinking-row') as HTMLElement;
    expect(row.textContent).toContain('Thought');
    expect(row.textContent).toContain('time unknown');
    expect(row.textContent).not.toContain('Thought for');
    expect(row.textContent).not.toMatch(/0\.0s|\d+(\.\d+)?s\b/);
    expect(container.querySelector('.thinking-tokens')?.textContent).toBe('1.2k tokens');

    await fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByRole('region', { name: 'Reasoning' }).textContent).toContain(
      'Weighing the options.',
    );
  });

  it('never shimmers as live when the block is not finalized', () => {
    const { container } = render(ThinkingBlock, {
      props: { text: 'x', agentName: 'Kory', thinkingStartedAt: Date.now(), timeUnknown: true },
    });
    expect(container.querySelector('.shimmer')).toBeNull();
    expect(container.textContent).toContain('time unknown');
  });

  it('renders a legacy reasoning row (no stored duration) as time unknown, never 0.0s', () => {
    const [row] = partsToFeedEntries({
      sessionId: 's',
      messageId: 'm',
      parts: legacyTurnParts('answer', 'old reasoning', 5_000),
      agentName: 'Kory',
      glowClass: '',
    });
    expect(row).toMatchObject({ type: 'thinking', thinkingFinalized: true, durationUnknown: true });
    expect(row.durationMs).toBeUndefined();

    const { container } = render(ThinkingBlock, {
      props: {
        text: row.text,
        agentName: 'Kory',
        durationMs: row.durationMs,
        thinkingStartedAt: row.thinkingStartedAt,
        finalized: row.thinkingFinalized,
        timeUnknown: row.durationUnknown === true,
      },
    });
    expect(container.textContent).toContain('time unknown');
    expect(container.textContent).not.toContain('0.0s');
  });
});
