import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ImageInputFallbackDialog from './ImageInputFallbackDialog.svelte';

describe('ImageInputFallbackDialog', () => {
  it('offers a vision model or an explicit remembered text-only continuation', async () => {
    const oncontinue = vi.fn();
    const onchoosemodel = vi.fn();
    render(ImageInputFallbackDialog, {
      props: {
        modelLabel: '(Freebuff) Text model',
        imageCount: 2,
        mode: 'send',
        oncontinue,
        onchoosemodel,
        oncancel: vi.fn(),
      },
    });

    expect(screen.getByRole('button', { name: /choose a vision model/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /continue without images/i })).toBeTruthy();
    const remember = screen.getByRole('switch', { name: /don't ask again/i });
    expect(remember.getAttribute('aria-checked')).toBe('false');
    await fireEvent.click(remember);
    await fireEvent.click(screen.getByRole('button', { name: /continue without images/i }));
    expect(oncontinue).toHaveBeenCalledWith(true);
    expect(onchoosemodel).not.toHaveBeenCalled();
  });
});
