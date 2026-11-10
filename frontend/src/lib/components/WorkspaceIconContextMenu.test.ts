import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import WorkspaceIconContextMenu from './WorkspaceIconContextMenu.svelte';

describe('WorkspaceIconContextMenu', () => {
  it('offers workspace-level quick actions', async () => {
    const onaction = vi.fn();
    const onclose = vi.fn();

    render(WorkspaceIconContextMenu, {
      props: {
        id: 'workspace-icon-menu-documents',
        workspaceName: 'Documents',
        workspacePath: '/tmp/Documents',
        x: 20,
        y: 30,
        expanded: true,
        onaction,
        onclose,
      },
    });

    expect(
      screen.getByRole('menu', { name: 'Actions for Documents workspace' }),
    ).toBeVisible();
    await fireEvent.click(screen.getByRole('menuitem', { name: /New project here/i }));

    expect(onaction).toHaveBeenCalledWith('new_project');
    expect(onclose).toHaveBeenCalledOnce();
  });
});
