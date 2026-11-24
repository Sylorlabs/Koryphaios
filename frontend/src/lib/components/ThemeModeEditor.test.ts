import { fireEvent, render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ),
}));

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: '' }));
vi.mock('$lib/api.svelte', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/fonts', () => ({ loadFont: vi.fn(async () => undefined) }));

// Dark system preference keeps activeScheme deterministic.
window.matchMedia = vi.fn().mockImplementation((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: vi.fn(),
})) as never;

import { theme } from '../stores/theme.svelte';
import ThemeModeEditor from './ThemeModeEditor.svelte';

beforeEach(() => {
  localStorage.clear();
  theme.reset();
});

describe('ThemeModeEditor', () => {
  it('renders the mode radios and both scheme cards', () => {
    render(ThemeModeEditor, { props: { onChooseAccent: vi.fn() } });

    expect(screen.getByRole('radio', { name: /Always light/ })).toBeVisible();
    expect(screen.getByRole('radio', { name: /Always dark/ })).toBeVisible();
    expect(screen.getByRole('radio', { name: /Adaptive/ })).toBeVisible();
    expect(screen.getByText('Light mode')).toBeVisible();
    expect(screen.getByText('Dark mode')).toBeVisible();
  });

  it('sets the mode when a mode radio is clicked', async () => {
    render(ThemeModeEditor, { props: { onChooseAccent: vi.fn() } });

    await fireEvent.click(screen.getByRole('radio', { name: /Always light/ }));
    expect(theme.mode).toBe('light');
    expect(theme.activeScheme).toBe('light');
  });

  it('selecting a light swatch updates only the light slot', async () => {
    render(ThemeModeEditor, { props: { onChooseAccent: vi.fn() } });

    await fireEvent.click(screen.getByRole('button', { name: 'Nord Snow' }));
    expect(theme.light.preset).toBe('nord-light');
    expect(theme.dark.preset).toBe('kintsugi');
    expect(theme.mode).toBe('system');
  });

  it('reports scheme and slot through onChooseAccent', async () => {
    const onChooseAccent = vi.fn();
    render(ThemeModeEditor, { props: { onChooseAccent } });

    await fireEvent.click(screen.getByRole('button', { name: 'Edit light mode primary accent' }));
    expect(onChooseAccent).toHaveBeenCalledWith('light', 'primary');

    await fireEvent.click(screen.getByRole('button', { name: 'Edit dark mode secondary accent' }));
    expect(onChooseAccent).toHaveBeenCalledWith('dark', 'secondary');
  });
});
