import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import ProjectIcon from './ProjectIcon.svelte';

const identity = {
  id: 'project-1',
  name: 'Design Lab',
  icon: { mode: 'automatic' as const },
};

describe('ProjectIcon', () => {
  it('renders the deterministic automatic icon as a decorative element', () => {
    const { container } = render(ProjectIcon, { props: { identity, size: 40 } });
    const icon = container.querySelector('.project-icon') as HTMLElement;

    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon.style.width).toBe('40px');
    expect(icon.textContent).toContain('DL');
  });

  it('renders explicit emoji and status separately from the base icon', () => {
    const { container } = render(ProjectIcon, {
      props: { identity, icon: { mode: 'emoji', value: '🧪' }, status: 'running' },
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
});
