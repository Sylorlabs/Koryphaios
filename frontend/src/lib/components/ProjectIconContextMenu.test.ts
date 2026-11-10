import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ProjectIconContextMenu from './ProjectIconContextMenu.svelte';

describe('ProjectIconContextMenu', () => {
  it('exposes project quick actions as a keyboard-friendly menu', async () => {
    const onaction = vi.fn();
    const onclose = vi.fn();

    render(ProjectIconContextMenu, {
      props: {
        id: 'project-icon-menu-demo',
        projectName: 'Design Lab',
        projectPath: '/workspace/design lab',
        x: 20,
        y: 30,
        onaction,
        onclose,
      },
    });

    expect(screen.getByRole('menu', { name: 'Actions for Design Lab' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: /Edit/i })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: /Pin project/i })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: /Archive chats/i })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: /Delete chats/i })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: /Close project/i })).toBeVisible();
    // A workspace child is discovered from disk, so it cannot be removed here.
    expect(screen.queryByRole('menuitem', { name: /Remove project/i })).toBeNull();

    await fireEvent.click(screen.getByRole('menuitem', { name: /^Edit/i }));

    expect(onclose).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(onaction).toHaveBeenCalledWith('open_project_identity:%2Fworkspace%2Fdesign%20lab'),
    );
  });

  it('offers removal only for a project that is not a workspace child', async () => {
    const onaction = vi.fn();
    render(ProjectIconContextMenu, {
      props: {
        id: 'project-icon-menu-remove',
        projectName: 'Solo',
        projectPath: '/solo',
        x: 10,
        y: 10,
        canRemove: true,
        pinned: true,
        onaction,
        onclose: () => {},
      },
    });

    expect(screen.getByRole('menuitem', { name: /Unpin project/i })).toBeVisible();
    await fireEvent.click(screen.getByRole('menuitem', { name: /Remove project/i }));
    await waitFor(() => expect(onaction).toHaveBeenCalledWith('remove_project:%2Fsolo'));
  });

  it('emits a delete-project-chats action for the project path', async () => {
    const onaction = vi.fn();
    render(ProjectIconContextMenu, {
      props: {
        id: 'project-icon-menu-delete',
        projectName: 'Solo',
        projectPath: '/solo',
        x: 10,
        y: 10,
        onaction,
        onclose: () => {},
      },
    });

    await fireEvent.click(screen.getByRole('menuitem', { name: /Delete chats/i }));
    await waitFor(() =>
      expect(onaction).toHaveBeenCalledWith('delete_project_chats:%2Fsolo'),
    );
  });

  it('supports Escape dismissal and restores focus to the trigger', async () => {
    const onaction = vi.fn();
    const onclose = vi.fn();
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const view = render(ProjectIconContextMenu, {
      props: {
        id: 'project-icon-menu-keyboard',
        projectName: 'Docs',
        projectPath: '/workspace/docs',
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
