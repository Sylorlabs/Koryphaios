import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isUndoToast, toastStore, UNDO_LABEL } from './toast.svelte';

const STAY = 120_000;

describe('toast actions', () => {
  beforeEach(() => toastStore.clear());
  afterEach(() => toastStore.clear());

  it('keeps the function form of success actions working and labels it', () => {
    const run = vi.fn();
    toastStore.success('Chat archived', { duration: STAY, action: run, actionLabel: UNDO_LABEL });

    const [toast] = toastStore.toasts;
    expect(toast.action?.label).toBe(UNDO_LABEL);
    expect(isUndoToast(toast)).toBe(true);
    expect(toast.onRetry).toBeUndefined();
  });

  it('accepts the object form and runs it once, dismissing the toast', () => {
    const run = vi.fn();
    toastStore.warning('Pick an account', { duration: STAY, action: { label: 'Open', run } });

    const [toast] = toastStore.toasts;
    expect(isUndoToast(toast)).toBe(false);
    expect(toastStore.runAction(toast.id)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(toastStore.toasts).toHaveLength(0);
    expect(toastStore.runAction(toast.id)).toBe(false);
  });

  it('routes the undo offer to the newest undoable toast only', () => {
    const plain = vi.fn();
    const undoOld = vi.fn();
    const undoNew = vi.fn();
    toastStore.success('Pinned', { duration: STAY, action: plain, actionLabel: 'Open' });
    toastStore.success('Archived', { duration: STAY, action: undoOld, actionLabel: UNDO_LABEL });
    toastStore.success('Pinned again', {
      duration: STAY,
      action: undoNew,
      actionLabel: UNDO_LABEL,
    });

    expect(toastStore.runLatestUndo()).toBe(true);
    expect(undoNew).toHaveBeenCalledTimes(1);
    expect(undoOld).not.toHaveBeenCalled();
    expect(plain).not.toHaveBeenCalled();
    expect(toastStore.toasts.map((t) => t.message)).toEqual(['Pinned', 'Archived']);

    expect(toastStore.runLatestUndo()).toBe(true);
    expect(undoOld).toHaveBeenCalledTimes(1);
    expect(toastStore.runLatestUndo()).toBe(false);
  });
});
