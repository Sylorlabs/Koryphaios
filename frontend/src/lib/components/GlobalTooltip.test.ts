import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
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
      await waitFor(() => expect(screen.getByRole('tooltip').textContent).toContain('Second action'));
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
