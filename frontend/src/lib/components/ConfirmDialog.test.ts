import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ConfirmDialog from './ConfirmDialog.svelte';

describe('ConfirmDialog opt-out button', () => {
  it('stays hidden unless the caller asks for it', () => {
    render(ConfirmDialog, { props: { open: true, message: 'Proceed?' } });

    expect(screen.queryByRole('button', { name: "Don't show again" })).toBeNull();
  });

  it('toggles on a plain click and exposes its state without a native checkbox', async () => {
    const { container } = render(ConfirmDialog, {
      props: { open: true, message: 'Proceed?', showSuppressOption: true },
    });

    const optOut = screen.getByRole('button', { name: "Don't show again" });
    expect(optOut.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();

    await fireEvent.click(optOut);
    expect(optOut.getAttribute('aria-pressed')).toBe('true');

    await fireEvent.click(optOut);
    expect(optOut.getAttribute('aria-pressed')).toBe('false');
  });

  it('does not confirm on Enter while the opt-out button has focus', async () => {
    const onConfirm = vi.fn();
    render(ConfirmDialog, {
      props: { open: true, message: 'Proceed?', showSuppressOption: true, onConfirm },
    });

    const optOut = screen.getByRole('button', { name: "Don't show again" });
    await fireEvent.click(optOut);
    await fireEvent.keyDown(optOut, { key: 'Enter' });

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('still confirms on Enter when no control has focus', async () => {
    const onConfirm = vi.fn();
    render(ConfirmDialog, { props: { open: true, message: 'Proceed?', onConfirm } });

    await fireEvent.keyDown(window, { key: 'Enter' });

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('focuses Cancel first so the opt-out button cannot be armed by accident', () => {
    render(ConfirmDialog, {
      props: { open: true, message: 'Proceed?', showSuppressOption: true },
    });

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });
});
