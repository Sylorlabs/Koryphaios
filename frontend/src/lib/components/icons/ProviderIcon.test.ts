import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProviderIcon from './ProviderIcon.svelte';

const { getCustomProviderIcon } = vi.hoisted(() => ({
  getCustomProviderIcon: vi.fn(),
}));

// Exercise asset classification before the deployment base is added.
vi.mock('$app/paths', () => ({ base: '/demo-app' }));
vi.mock('$lib/stores/providers.svelte', () => ({
  providersStore: { getCustomProviderIcon },
}));

beforeEach(() => getCustomProviderIcon.mockReset());
afterEach(() => cleanup());

describe('ProviderIcon', () => {
  it.each(['beam', 'Beam'])(
    'renders %s with the local, theme-adaptive Reflection symbol',
    (provider) => {
      render(ProviderIcon, { provider });
      const icon = screen.getByRole('img', { name: `${provider} logo` });
      expect(icon).toHaveAttribute('src', '/demo-app/provider-icons/reflection.svg');
      expect(icon).toHaveClass('provider-icon', 'theme-adaptive');
    },
  );

  it('falls back gracefully if the bundled Reflection symbol fails to load', async () => {
    render(ProviderIcon, { provider: 'beam' });
    await fireEvent.error(screen.getByRole('img', { name: 'beam logo' }));
    expect(screen.getByRole('img', { name: 'beam logo' })).toHaveClass('provider-icon-placeholder');
  });

  it.each(['experientiallabs', 'ExperientialLabs'])(
    'renders %s using the bundled theme-adaptive mark',
    (provider) => {
      render(ProviderIcon, { provider, size: 20, class: 'shrink-0' });
      const icon = screen.getByRole('img', { name: `${provider} logo` });
      expect(icon).toHaveAttribute('src', '/demo-app/provider-icons/experientiallabs-color.svg');
      expect(icon).toHaveClass('provider-icon', 'theme-adaptive', 'shrink-0');
      expect(icon).toHaveAttribute('width', '20');
      expect(icon).toHaveAttribute('height', '20');
    },
  );

  it.each(['commandcode', 'unorouter'])('preserves the fixed-color %s mark', (provider) => {
    render(ProviderIcon, { provider });
    const icon = screen.getByRole('img', { name: `${provider} logo` });
    expect(icon).toHaveAttribute('src', `/demo-app/provider-icons/${provider}-color.svg`);
    expect(icon).not.toHaveClass('theme-adaptive');
  });

  it.each([
    ['experientiallabs', 'experientiallabs-color.svg'],
    ['beam', 'reflection.svg'],
  ])(
    'preserves custom artwork for %s and falls back to the themed mark if it fails',
    async (provider, asset) => {
      getCustomProviderIcon.mockReturnValue({
        url: 'blob:custom-logo',
        revision: '1',
        shape: 'circle',
      });
      render(ProviderIcon, { provider });
      const custom = screen.getByRole('img', { name: `${provider} custom logo` });
      expect(custom).toHaveAttribute('src', 'blob:custom-logo');
      expect(custom).toHaveClass('custom-provider-icon-circle');
      expect(custom).not.toHaveClass('theme-adaptive');

      await fireEvent.error(custom);
      const fallback = screen.getByRole('img', { name: `${provider} logo` });
      expect(fallback).toHaveAttribute('src', `/demo-app/provider-icons/${asset}`);
      expect(fallback).toHaveClass('theme-adaptive');
    },
  );
});
