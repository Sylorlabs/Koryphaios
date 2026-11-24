import { beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_PRESETS } from '../theme-palette';

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

// happy-dom's matchMedia does not track OS preference changes; a controllable
// stub lets the tests flip the system scheme and fire the change listener.
let prefersLight = false;
const mediaListeners = new Set<() => void>();
const mediaQueryList = {
  get matches() {
    return prefersLight;
  },
  media: '(prefers-color-scheme: light)',
  onchange: null,
  addEventListener: (_type: string, listener: () => void) => {
    mediaListeners.add(listener);
  },
  removeEventListener: (_type: string, listener: () => void) => {
    mediaListeners.delete(listener);
  },
  addListener: (listener: () => void) => mediaListeners.add(listener),
  removeListener: (listener: () => void) => mediaListeners.delete(listener),
  dispatchEvent: () => true,
};
window.matchMedia = vi.fn().mockImplementation(() => mediaQueryList) as never;

function setSystemScheme(scheme: 'light' | 'dark') {
  prefersLight = scheme === 'light';
  for (const listener of [...mediaListeners]) listener();
}

import { theme } from './theme.svelte';

async function freshStore(persisted: unknown) {
  localStorage.setItem('koryphaios-theme', JSON.stringify(persisted));
  vi.resetModules();
  const module = await import('./theme.svelte');
  return module.theme;
}

beforeEach(() => {
  localStorage.clear();
  mocks.apiFetch.mockClear();
  prefersLight = false;
  mediaListeners.clear();
  theme.reset();
  mocks.apiFetch.mockClear();
});

describe('theme appearance persistence', () => {
  it('keeps primary and secondary custom accents in one persisted v2 appearance model', async () => {
    theme.setCustomAccent({ main: '#123456', hover: '#345678' });
    theme.setCustomSecondaryAccent({ main: '#ABCDEF', hover: '#CDEFFF' });

    await vi.waitFor(() => {
      expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    });

    const local = JSON.parse(localStorage.getItem('koryphaios-theme') ?? '{}');
    expect(local.version).toBe(2);
    // The active scheme is dark (system preference defaults to dark), so the
    // custom accents land in the dark slot.
    expect(local.dark.customAccent).toEqual({ main: '#123456', hover: '#345678' });
    expect(local.dark.customSecondaryAccent).toEqual({ main: '#ABCDEF', hover: '#CDEFFF' });
    expect(local.dark.accent).toBe('custom');
    expect(local.dark.secondaryAccent).toBe('custom');

    const lastWrite = mocks.apiFetch.mock.calls.at(-1);
    expect(lastWrite?.[0]).toBe('/api/appearance');
    const body = JSON.parse(String(lastWrite?.[1]?.body));
    expect(body.version).toBe(2);
    expect(body.dark.accent).toBe('custom');
    expect(body.dark.secondaryAccent).toBe('custom');
    expect(body.dark.customAccent).toEqual({ main: '#123456', hover: '#345678' });
    expect(body.dark.customSecondaryAccent).toEqual({ main: '#ABCDEF', hover: '#CDEFFF' });
  });
});

describe('theme v1 → v2 migration', () => {
  it('migrates v1 "system" to adaptive mode with both slots', async () => {
    const next = await freshStore({
      preset: 'system',
      accent: 'cyan',
      secondaryAccent: 'violet',
      font: 'inter',
    });
    expect(next.mode).toBe('system');
    expect(next.dark.preset).toBe('kintsugi');
    expect(next.light.preset).toBe('light');
    expect(next.dark.accent).toBe('cyan');
    expect(next.dark.secondaryAccent).toBe('violet');
    expect(next.light.accent).toBe('cyan');
    expect(next.light.secondaryAccent).toBe('violet');
  });

  it('migrates a v1 dark preset into the dark slot', async () => {
    const next = await freshStore({
      preset: 'nord',
      accent: 'amber',
      secondaryAccent: 'amber',
      font: 'inter',
    });
    expect(next.mode).toBe('dark');
    expect(next.dark.preset).toBe('nord');
    expect(next.dark.accent).toBe('amber');
    expect(next.light.preset).toBe('kintsugi-light');
  });

  it('migrates a v1 light preset into the light slot', async () => {
    const next = await freshStore({
      preset: 'light',
      accent: 'rose',
      secondaryAccent: 'rose',
      font: 'inter',
    });
    expect(next.mode).toBe('light');
    expect(next.light.preset).toBe('light');
    expect(next.light.accent).toBe('rose');
    expect(next.dark.preset).toBe('kintsugi');
  });
});

describe('stored unknown values normalize to defaults', () => {
  it('falls back to the slot default accent when a stored accent id is removed', async () => {
    const next = await freshStore({
      version: 2,
      mode: 'light',
      font: 'inter',
      dark: { preset: 'kintsugi', accent: 'gold', secondaryAccent: 'gold' },
      light: { preset: 'nord-light', accent: 'bronze', secondaryAccent: 'bronze' },
    });
    expect(next.light.accent).toBe('gold');
    expect(next.light.secondaryAccent).toBe('gold');
    expect(next.light.preset).toBe('nord-light');
  });

  it('falls back to the light default preset when a stored preset id is removed', async () => {
    const next = await freshStore({
      version: 2,
      mode: 'light',
      font: 'inter',
      dark: { preset: 'kintsugi', accent: 'gold', secondaryAccent: 'gold' },
      light: { preset: 'solarized-light', accent: 'gold', secondaryAccent: 'gold' },
    });
    expect(next.light.preset).toBe('kintsugi-light');
    expect(next.mode).toBe('light');
  });
});

describe('theme mode and scheme behaviour', () => {
  it('applies the light slot when the system prefers light, and flips back', () => {
    theme.setMode('system');
    const cleanup = theme.init();
    setSystemScheme('light');
    expect(theme.activeScheme).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--color-surface-0')).toBe(
      THEME_PRESETS[theme.light.preset]['--color-surface-0'],
    );

    setSystemScheme('dark');
    expect(theme.activeScheme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--color-surface-0')).toBe(
      THEME_PRESETS[theme.dark.preset]['--color-surface-0'],
    );
    cleanup?.();
  });

  it('keeps per-mode custom accents independent', () => {
    theme.setMode('dark');
    theme.setModeCustomAccent('light', 'primary', { main: '#112233', hover: '#445566' });
    expect(theme.light.accent).toBe('custom');
    expect(theme.light.customAccent).toEqual({ main: '#112233', hover: '#445566' });
    expect(theme.dark.customAccent).toBeUndefined();
    expect(theme.currentAccent.main).not.toBe('#112233');
  });

  it('switches mode when setPreset targets the other scheme', () => {
    theme.setMode('dark');
    theme.setPreset('nord-light');
    expect(theme.mode).toBe('light');
    expect(theme.light.preset).toBe('nord-light');
    expect(theme.preset).toBe('nord-light');
  });

  it('ignores a setModePreset for the wrong scheme', () => {
    theme.setMode('dark');
    theme.setModePreset('dark', 'tokyo-day');
    expect(theme.dark.preset).toBe('kintsugi');
    expect(theme.light.preset).toBe('kintsugi-light');
  });
});
