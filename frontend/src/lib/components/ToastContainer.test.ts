// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ToastContainer from './ToastContainer.svelte';
import { toastStore } from '$lib/stores/toast.svelte';

// Long enough that no auto-dismiss timer can fire mid-test.
const STAY = 120_000;

function notify(messages: string[]): void {
  for (const message of messages) toastStore.success(message, { duration: STAY });
}

function cards(): NodeListOf<HTMLElement> {
  return document.querySelectorAll('[data-toast-type]');
}

describe('notification stack', () => {
  beforeEach(() => toastStore.clear());
  afterEach(() => toastStore.clear());

  it('keeps two notifications open and folds the rest behind a countable toggle', () => {
    notify(['first', 'second', 'third', 'fourth']);
    render(ToastContainer);

    expect(cards()).toHaveLength(2);
    // Newest first: the stack hangs from the top of the window.
    expect(screen.getByText('fourth')).toBeTruthy();
    expect(screen.getByText('third')).toBeTruthy();
    expect(screen.queryByText('first')).toBeNull();
    expect(screen.getByText('2 more notifications')).toBeTruthy();
  });

  it('shows every notification when the reader expands the stack', async () => {
    notify(['first', 'second', 'third', 'fourth']);
    render(ToastContainer);

    const toggle = screen.getByRole('button', { name: /2 more notifications/i });
    await fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(cards()).toHaveLength(4);
    expect(screen.getByText('first')).toBeTruthy();
    // The control stays so the reader can fold it back up.
    expect(screen.getByRole('button', { name: /2 more notifications/i })).toBe(toggle);

    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(cards()).toHaveLength(2);
  });

  it('clears only the folded notifications when asked', async () => {
    notify(['first', 'second', 'third', 'fourth']);
    render(ToastContainer);

    await fireEvent.click(screen.getByRole('button', { name: /2 more notifications/i }));
    await fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(cards()).toHaveLength(2);
    expect(screen.queryByText('2 more notifications')).toBeNull();
    expect(screen.getByText('fourth')).toBeTruthy();
  });

  it('never leaves an empty notification region behind', async () => {
    notify(['only']);
    render(ToastContainer);
    expect(cards()).toHaveLength(1);
    expect(screen.queryByRole('region', { name: 'Notifications' })).not.toBeNull();

    toastStore.dismissMany(toastStore.toasts.map((toast) => toast.id));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Notifications' })).toBeNull());
  });
});
