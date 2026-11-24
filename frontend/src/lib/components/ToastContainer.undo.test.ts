// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ToastContainer from './ToastContainer.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import { setPlatformForTesting } from '$lib/utils/platform';

const STAY = 120_000;

describe('undo toasts', () => {
  beforeEach(() => {
    setPlatformForTesting('linux');
    toastStore.clear();
  });
  afterEach(() => {
    toastStore.clear();
    setPlatformForTesting(null);
  });

  it('runs the action from its button and dismisses the toast', async () => {
    const undo = vi.fn();
    toastStore.success('Chat pinned', { duration: STAY, action: undo, actionLabel: 'Undo' });
    render(ToastContainer);

    await fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(undo).toHaveBeenCalledTimes(1);
    expect(toastStore.toasts).toHaveLength(0);
  });

  it('labels the undo button with the formatted shortcut, not a literal modifier', () => {
    toastStore.success('Chat pinned', { duration: STAY, action: () => {}, actionLabel: 'Undo' });
    render(ToastContainer);

    const button = screen.getByRole('button', { name: 'Undo' });
    expect(button.getAttribute('title')).toBe('Undo (Ctrl+Z)');
  });

  it('routes the undo chord to the newest undo offer', async () => {
    const older = vi.fn();
    const newer = vi.fn();
    toastStore.success('Chat archived', { duration: STAY, action: older, actionLabel: 'Undo' });
    toastStore.success('Chat pinned', { duration: STAY, action: newer, actionLabel: 'Undo' });
    render(ToastContainer);

    const event = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(toastStore.toasts.map((t) => t.message)).toEqual(['Chat archived']);
  });

  it('ignores the undo chord while typing in a textarea', () => {
    const undo = vi.fn();
    toastStore.success('Chat pinned', { duration: STAY, action: undo, actionLabel: 'Undo' });
    render(ToastContainer);

    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    textarea.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(event);

    expect(undo).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(toastStore.toasts).toHaveLength(1);
    textarea.remove();
  });

  it('does nothing for the chord when no undo offer is visible', () => {
    toastStore.success('Chat restored to the sidebar', { duration: STAY });
    render(ToastContainer);

    const event = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(toastStore.toasts).toHaveLength(1);
  });
});
