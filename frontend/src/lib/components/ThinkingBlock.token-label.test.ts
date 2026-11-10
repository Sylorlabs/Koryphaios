// @vitest-environment happy-dom
import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import ThinkingBlock from './ThinkingBlock.svelte';

function tokenLabel(container: HTMLElement): string | null {
  return container.querySelector('.thinking-tokens')?.textContent ?? null;
}

describe('ThinkingBlock token label', () => {
  it('shows the compact token count next to the duration after finalization', () => {
    const { container } = render(ThinkingBlock, {
      props: {
        text: 'reasoning…',
        agentName: 'Kory',
        durationMs: 12_000,
        thinkingTokens: 1234,
        finalized: true,
      },
    });

    expect(tokenLabel(container)).toBe('1.2k tokens');
  });

  it('shows the raw count below the kilo threshold', () => {
    const { container } = render(ThinkingBlock, {
      props: {
        text: 'reasoning…',
        agentName: 'Kory',
        durationMs: 3_000,
        thinkingTokens: 850,
        finalized: true,
      },
    });

    expect(tokenLabel(container)).toBe('850 tokens');
  });

  it('omits the label when the provider reports no thinking tokens', () => {
    const { container } = render(ThinkingBlock, {
      props: {
        text: 'reasoning…',
        agentName: 'Kory',
        durationMs: 5_000,
        finalized: true,
      },
    });

    expect(tokenLabel(container)).toBeNull();
  });

  it('omits the label for zero or negative counts', () => {
    const { container } = render(ThinkingBlock, {
      props: {
        text: 'reasoning…',
        agentName: 'Kory',
        durationMs: 5_000,
        thinkingTokens: 0,
        finalized: true,
      },
    });

    expect(tokenLabel(container)).toBeNull();
  });
});
