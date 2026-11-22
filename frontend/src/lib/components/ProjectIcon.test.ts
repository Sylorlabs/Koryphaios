import { render, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearProjectIconAssetCache } from '$lib/utils/project-icon-assets.svelte';
import ProjectIcon from './ProjectIcon.svelte';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('$lib/api.svelte', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => `http://backend.test${path}` }));

const identity = {
  id: 'project-1',
  name: 'Design Lab',
  icon: { mode: 'automatic' as const },
};

function pngResponse() {
  return new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  });
}

describe('ProjectIcon', () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    clearProjectIconAssetCache();
  });

  it('renders the deterministic automatic icon as a decorative element', () => {
    const { container } = render(ProjectIcon, { props: { identity, size: 40 } });
    const icon = container.querySelector('.project-icon') as HTMLElement;

    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon.style.width).toBe('40px');
    expect(icon.textContent).toContain('DL');
  });

  it('renders an emoji monogram and status separately from the base icon', () => {
    const { container } = render(ProjectIcon, {
      props: { identity, icon: { mode: 'monogram', value: '🧪' }, status: 'running' },
    });

    expect(container.querySelector('.project-icon')?.textContent).toContain('🧪');
    expect(container.querySelector('.project-icon-status-running')).not.toBeNull();
  });

  it('falls back to the monogram when an image asset is unavailable', () => {
    const { container } = render(ProjectIcon, {
      props: {
        identity,
        icon: { mode: 'image', assetId: 'asset_01' },
      },
    });

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('DL');
  });

  it('renders a color tile as a solid clipped shape with no glyph', () => {
    const { container } = render(ProjectIcon, {
      props: {
        identity,
        icon: { mode: 'color', color: 'accent', shape: 'rounded-square' },
        size: 40,
      },
    });
    const icon = container.querySelector('.project-icon') as HTMLElement;
    expect(icon.textContent?.trim()).toBe('');
    expect(icon.querySelectorAll('img')).toHaveLength(0);
    const bg = getComputedStyle(icon).backgroundColor;
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
  });

  it('renders transparent shape with no background and a larger glyph', () => {
    const { container } = render(ProjectIcon, {
      props: {
        identity,
        icon: { mode: 'monogram', value: 'DL', shape: 'transparent' },
        size: 40,
      },
    });
    const icon = container.querySelector('.project-icon') as HTMLElement;
    expect(icon).toHaveAttribute('data-project-shape', 'transparent');
    expect(icon.style.background).toBe('');
    const glyph = icon.querySelector('span:last-child') as HTMLElement;
    expect(Number(glyph.style.fontSize.replace('px', ''))).toBe(20); // 0.5 × 40
  });

  it('renders custom color and shape choices while keeping legacy icons compatible', () => {
    const { container } = render(ProjectIcon, {
      props: {
        identity,
        icon: { mode: 'monogram', value: 'DL', customColor: '#3366CC', shape: 'circle' },
      },
    });
    const icon = container.querySelector('.project-icon') as HTMLElement;

    expect(icon).toHaveAttribute('data-project-shape', 'circle');
    expect(icon.style.color).toBe('#3366CC');
  });

  it('loads an image asset through apiFetch and renders it as a data URL', async () => {
    mocks.apiFetch.mockImplementation(async () => pngResponse());
    const { container } = render(ProjectIcon, {
      props: {
        identity,
        icon: { mode: 'image', assetId: 'asset_1' },
        assetUrl: '/api/workspace/project-icon/asset_1',
      },
    });

    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      'http://backend.test/api/workspace/project-icon/asset_1',
    );
    expect(container.querySelector('img')?.getAttribute('src')).toMatch(/^data:/u);
  });

  it('falls back to letters when the asset fetch fails', async () => {
    mocks.apiFetch.mockResolvedValue(new Response('not found', { status: 404 }));
    const { container } = render(ProjectIcon, {
      props: {
        identity,
        icon: { mode: 'image', assetId: 'missing' },
        assetUrl: '/api/workspace/project-icon/missing',
      },
    });

    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalled());
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('DL');
  });

  it('fetches again when the asset URL changes', async () => {
    mocks.apiFetch.mockImplementation(async () => pngResponse());
    const { container, rerender } = render(ProjectIcon, {
      props: {
        identity,
        icon: { mode: 'image', assetId: 'asset_a' },
        assetUrl: '/api/workspace/project-icon/asset_a',
      },
    });
    await waitFor(() =>
      expect(mocks.apiFetch).toHaveBeenCalledWith(
        'http://backend.test/api/workspace/project-icon/asset_a',
      ),
    );

    await rerender({
      identity,
      icon: { mode: 'image', assetId: 'asset_b' },
      assetUrl: '/api/workspace/project-icon/asset_b',
    });
    await waitFor(() =>
      expect(mocks.apiFetch).toHaveBeenCalledWith(
        'http://backend.test/api/workspace/project-icon/asset_b',
      ),
    );
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
  });
});
