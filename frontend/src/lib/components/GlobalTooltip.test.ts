import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GlobalTooltip from './GlobalTooltip.svelte';

describe('global tooltip focus lifecycle', () => {
  it('does not let a deferred focusout hide the next focused tooltip', async () => {
    const { unmount } = render(GlobalTooltip);
    const first = document.createElement('button');
    const second = document.createElement('button');
    first.title = 'First action';
    second.title = 'Second action';
    document.body.append(first, second);
    try {
      await fireEvent.focusIn(first);
      expect(screen.getByRole('tooltip').textContent).toContain('First action');
      first.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      second.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      await waitFor(() =>
        expect(screen.getByRole('tooltip').textContent).toContain('Second action'),
      );
      expect(first.title).toBe('First action');
      await fireEvent.focusOut(second);
      await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
      expect(second.title).toBe('Second action');
    } finally {
      first.remove();
      second.remove();
      unmount();
    }
  });
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('global tooltip side placement', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('places an opted-in tooltip to the right of its trigger, vertically centred', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1200);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
    vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 160, 30));
    const { unmount } = render(GlobalTooltip);
    const navItem = document.createElement('button');
    navItem.title = 'Providers and models';
    navItem.dataset.tooltipPlacement = 'right';
    navItem.getBoundingClientRect = () => rect(20, 200, 200, 36);
    document.body.append(navItem);
    try {
      await fireEvent.focusIn(navItem);
      const tooltip = screen.getByRole('tooltip');
      await waitFor(() => expect(tooltip.dataset.placement).toBe('right'));
      // 9px gap after the trigger's right edge; centred on the trigger's middle.
      expect(tooltip.style.left).toBe('229px');
      expect(tooltip.style.top).toBe('203px');
    } finally {
      navItem.remove();
      unmount();
    }
  });

  it('falls back to the left when the right side would overflow the viewport', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1200);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
    vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 160, 30));
    const { unmount } = render(GlobalTooltip);
    const navItem = document.createElement('button');
    navItem.title = 'Edge item';
    navItem.dataset.tooltipPlacement = 'right';
    navItem.getBoundingClientRect = () => rect(1000, 200, 150, 36);
    document.body.append(navItem);
    try {
      await fireEvent.focusIn(navItem);
      const tooltip = screen.getByRole('tooltip');
      await waitFor(() => expect(tooltip.dataset.placement).toBe('left'));
      expect(tooltip.style.left).toBe('831px');
    } finally {
      navItem.remove();
      unmount();
    }
  });

  it('keeps the default top placement for triggers without the attribute', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1200);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
    vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 160, 30));
    const { unmount } = render(GlobalTooltip);
    const button = document.createElement('button');
    button.title = 'Plain action';
    button.getBoundingClientRect = () => rect(400, 300, 100, 36);
    document.body.append(button);
    try {
      await fireEvent.focusIn(button);
      const tooltip = screen.getByRole('tooltip');
      await waitFor(() => expect(tooltip.style.top).toBe('261px'));
      expect(tooltip.dataset.placement).toBe('top');
    } finally {
      button.remove();
      unmount();
    }
  });
});
