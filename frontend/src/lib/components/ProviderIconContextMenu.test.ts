import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ProviderIconContextMenu from './ProviderIconContextMenu.svelte';

describe('ProviderIconContextMenu', () => {
  it('offers edit, remove, and settings controls for a custom provider logo', async () => {
    const onedit = vi.fn();
    const onremove = vi.fn();
    const onsettings = vi.fn();
    const onclose = vi.fn();

    render(ProviderIconContextMenu, {
      props: {
        id: 'provider-icon-menu-custom',
        providerLabel: 'Local Gateway',
        hasCustomIcon: true,
        x: 20,
        y: 30,
        onedit,
        onremove,
        onsettings,
        onclose,
      },
    });

    expect(screen.getByRole('menu', { name: 'Actions for Local Gateway' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: /Edit provider logo/i })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: /Remove provider logo/i })).toBeVisible();

    await fireEvent.click(screen.getByRole('menuitem', { name: /Remove provider logo/i }));

    expect(onclose).toHaveBeenCalledOnce();
    await waitFor(() => expect(onremove).toHaveBeenCalledOnce());
  });

  it('hides remove when the provider uses the default logo', () => {
    render(ProviderIconContextMenu, {
      props: {
        id: 'provider-icon-menu-default',
        providerLabel: 'Local Gateway',
        hasCustomIcon: false,
        x: 20,
        y: 30,
        onedit: vi.fn(),
        onremove: vi.fn(),
        onsettings: vi.fn(),
        onclose: vi.fn(),
      },
    });

    expect(screen.queryByRole('menuitem', { name: /Remove provider logo/i })).toBeNull();
  });
});
