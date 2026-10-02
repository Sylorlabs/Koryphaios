import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import FolderToggleIcon from './FolderToggleIcon.svelte';

describe('FolderToggleIcon', () => {
  it('renders closed by default and flips to open', async () => {
    const { container, rerender } = render(FolderToggleIcon, { props: { open: false } });
    const icon = container.querySelector('.folder-toggle-icon');
    expect(icon).not.toBeNull();
    expect(icon).not.toHaveClass('is-open');
    expect(icon?.getAttribute('data-open')).toBe('false');
    // Both glyphs are always mounted so the swap can crossfade.
    expect(container.querySelector('.folder-glyph-closed svg')).not.toBeNull();
    expect(container.querySelector('.folder-glyph-open svg')).not.toBeNull();

    await rerender({ open: true });
    expect(container.querySelector('.folder-toggle-icon')).toHaveClass('is-open');
    expect(container.querySelector('.folder-toggle-icon')?.getAttribute('data-open')).toBe('true');
  });

  it('is decorative and sized from the size prop', () => {
    const { container } = render(FolderToggleIcon, { props: { open: true, size: 20 } });
    const icon = container.querySelector('.folder-toggle-icon') as HTMLElement;
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.style.width).toBe('20px');
    expect(icon.style.height).toBe('20px');
  });
});
