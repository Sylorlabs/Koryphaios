import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ChatActionsMenu from './ChatActionsMenu.svelte';

describe('ChatActionsMenu', () => {
  it('exposes chat quick actions without pin', async () => {
    const onaction = vi.fn();
    const onclose = vi.fn();

    render(ChatActionsMenu, {
      props: {
        id: 'chat-actions-demo',
        chatTitle: 'Design Lab',
        x: 20,
        y: 30,
        onaction,
        onclose,
      },
    });

    expect(screen.getByRole('menu', { name: 'Actions for Design Lab' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: /Rename/i })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: /Copy chat ID/i })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: /Archive/i })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: /Delete chat/i })).toBeVisible();
    // Pin remains on the chat-row foreground button.
    expect(screen.queryByRole('menuitem', { name: /Pin/i })).toBeNull();

    await fireEvent.click(screen.getByRole('menuitem', { name: /^Rename/i }));

    expect(onclose).toHaveBeenCalledOnce();
    await waitFor(() => expect(onaction).toHaveBeenCalledWith('rename'));
  });

  it('disables archive while archiving', () => {
    render(ChatActionsMenu, {
      props: {
        id: 'chat-actions-archiving',
        chatTitle: 'Design Lab',
        x: 20,
        y: 30,
        archiving: true,
        onaction: () => {},
        onclose: () => {},
      },
    });

    expect(screen.getByRole('menuitem', { name: /Archive/i })).toBeDisabled();
  });

  it('supports Escape dismissal and restores focus to the trigger', async () => {
    const onaction = vi.fn();
    const onclose = vi.fn();
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const view = render(ChatActionsMenu, {
      props: {
        id: 'chat-actions-keyboard',
        chatTitle: 'Docs',
        x: 20,
        y: 30,
        returnFocus: trigger,
        onaction,
        onclose,
      },
    });

    await fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(onclose).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
