// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ThinkingBlock from './ThinkingBlock.svelte';
import { EXPAND_ANCHOR_EVENT } from '$lib/utils/expand-anchor';

// happy-dom has no Web Animations API; the panel's slide transition calls
// element.animate(). A no-op animation that finishes immediately keeps the
// toggle's DOM assertions meaningful.
if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
  Element.prototype.animate = function animate() {
    const animation = {
      onfinish: null as (() => void) | null,
      oncancel: null as (() => void) | null,
      finished: Promise.resolve(),
      cancel() {
        this.oncancel?.();
      },
      finish() {
        this.onfinish?.();
      },
      play() {},
      pause() {},
      reverse() {},
      updatePlaybackRate() {},
      currentTime: 0,
      playbackRate: 1,
    };
    queueMicrotask(() => animation.onfinish?.());
    return animation as unknown as Animation;
  };
}

describe('ThinkingBlock expansion anchoring', () => {
  it('removes unused boundary lines while preserving paragraphs during streaming', async () => {
    const { container, rerender } = render(ThinkingBlock, {
      props: {
        text: '\n\nFirst paragraph.\n\nSecond paragraph.\n\n\n',
        agentName: 'Kory',
        defaultExpanded: true,
      },
    });
    expect(container.querySelector('.thinking-full-text')?.textContent).toBe('First paragraph.\n\nSecond paragraph.');
    await rerender({ text: '\n\nFirst paragraph.\n\nSecond paragraph. More detail.\n\n' });
    expect(container.querySelector('.thinking-full-text')?.textContent).toBe('First paragraph.\n\nSecond paragraph. More detail.');
  });

  it('asks the transcript to keep the messages below it in place', async () => {
    const onAnchor = vi.fn();
    const { container } = render(ThinkingBlock, {
      props: {
        text: 'weighing the options…',
        agentName: 'Kory',
        finalized: true,
        durationMs: 4200,
      },
    });
    // The transcript listens on the row that contains this block, so the
    // request has to bubble rather than stay on the button.
    container.addEventListener(EXPAND_ANCHOR_EVENT, onAnchor);

    await fireEvent.click(screen.getByTitle('Show reasoning'));
    expect(onAnchor).toHaveBeenCalledTimes(1);
    expect(onAnchor.mock.calls[0][0].bubbles).toBe(true);
    expect(container.querySelector('.thinking-full-text')).not.toBeNull();
    const region = screen.getByRole('region', { name: 'Reasoning' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(screen.getByTitle('Hide reasoning')).toHaveAttribute('aria-controls', region.id);
    expect(screen.getByTitle('Hide reasoning')).toHaveAttribute('aria-expanded', 'true');

    // Collapsing asks for the same anchoring, in reverse.
    await fireEvent.click(screen.getByTitle('Hide reasoning'));
    expect(onAnchor).toHaveBeenCalledTimes(2);
    expect(screen.getByTitle('Show reasoning')).toHaveAttribute('aria-expanded', 'false');
  });
});
