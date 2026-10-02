import { fireEvent, render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom has no Web Animations API; Svelte transitions call element.animate().
// A no-op animation that finishes immediately keeps the slide transitions from
// throwing while leaving the DOM assertions meaningful.
if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
  Element.prototype.animate = function animate() {
    const animation = {
      onfinish: null as (() => void) | null,
      oncancel: null as (() => void) | null,
      finished: Promise.resolve(),
      cancel() {
        this.oncancel?.();
      },
      finish() {
        this.onfinish?.();
      },
      play() {},
      pause() {},
      reverse() {},
      updatePlaybackRate() {},
      currentTime: 0,
      playbackRate: 1,
    };
    queueMicrotask(() => animation.onfinish?.());
    return animation as unknown as Animation;
  };
}

const mocks = vi.hoisted(() => ({
  saveSettings: vi.fn(async () => true),
  loadSettings: vi.fn(async () => undefined),
  loadProvidersFromApi: vi.fn(async () => undefined),
  setPreset: vi.fn(),
  setAccent: vi.fn(),
  setSecondaryAccent: vi.fn(),
  setCustomAccent: vi.fn(),
  setCustomSecondaryAccent: vi.fn(),
  settings: {
    intentInterview: 'adaptive',
    planApproval: 'material',
    permissionMode: 'guarded',
    criticGateEnabled: true,
    reasoningExpandedByDefault: false,
  },
}));

vi.mock('$lib/stores/agent-settings.svelte', () => ({
  agentSettingsStore: {
    get settings() {
      return mocks.settings;
    },
    settingsLoaded: true,
    isLoading: false,
    saveSettings: mocks.saveSettings,
    loadSettings: mocks.loadSettings,
  },
}));

vi.mock('$lib/stores/providers.svelte', () => ({
  providersStore: {
    statusList: [
      { name: 'anthropic', connectionState: 'detected' },
      { name: 'openai', connectionState: 'not_configured' },
    ],
    loadProvidersFromApi: mocks.loadProvidersFromApi,
  },
}));

vi.mock('$lib/stores/theme.svelte', () => ({
  THEME_PRESETS: {
    kintsugi: {
      '--color-surface-1': '#141210',
      '--color-surface-3': '#262220',
      '--color-text-primary': '#F6EFE2',
    },
    midnight: {
      '--color-surface-1': '#111113',
      '--color-surface-3': '#222',
      '--color-text-primary': '#fff',
    },
    light: {
      '--color-surface-1': '#fff',
      '--color-surface-3': '#eee',
      '--color-text-primary': '#111',
    },
  },
  theme: {
    preset: 'kintsugi',
    accent: 'gold',
    secondaryAccent: 'gold',
    customAccent: undefined,
    customSecondaryAccent: undefined,
    presets: [
      { id: 'kintsugi', label: 'Kintsugi' },
      { id: 'midnight', label: 'Midnight' },
      { id: 'light', label: 'Light' },
      { id: 'system', label: 'System' },
    ],
    accents: [
      { id: 'gold', label: 'Kintsugi Gold', color: '#D5B261' },
      { id: 'cyan', label: 'Cyan', color: '#06b6d4' },
    ],
    currentAccent: { main: '#D5B261', hover: '#D5B261' },
    currentSecondaryAccent: { main: '#D5B261', hover: '#D5B261' },
    setPreset: mocks.setPreset,
    setAccent: mocks.setAccent,
    setSecondaryAccent: mocks.setSecondaryAccent,
    setCustomAccent: mocks.setCustomAccent,
    setCustomSecondaryAccent: mocks.setCustomSecondaryAccent,
  },
}));

import OnboardingWalkthrough from './OnboardingWalkthrough.svelte';
import { onboardingStore } from '$lib/stores/onboarding.svelte';

function renderWalkthrough() {
  const onOpenProviders = vi.fn();
  render(OnboardingWalkthrough, { props: { onOpenProviders } });
  return { onOpenProviders };
}

describe('OnboardingWalkthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    onboardingStore.reset();
  });

  it('opens on the welcome step with a skip-and-use-defaults escape hatch', async () => {
    renderWalkthrough();

    expect(screen.getByRole('heading', { name: 'Welcome to Koryphaios' })).toBeVisible();
    await fireEvent.click(screen.getByRole('button', { name: /Skip and use Koryphaios defaults/ }));

    expect(onboardingStore.record?.outcome).toBe('skipped');
    expect(mocks.saveSettings).not.toHaveBeenCalled();
    expect(mocks.setPreset).not.toHaveBeenCalled();
  });

  it('walks forward through the steps and writes choices to the real stores', async () => {
    renderWalkthrough();

    await fireEvent.click(screen.getByRole('button', { name: /Set up in a minute/ }));
    expect(screen.getByRole('heading', { name: 'Make it look like yours' })).toBeVisible();

    await fireEvent.click(screen.getByRole('button', { name: /Midnight/ }));
    expect(mocks.setPreset).toHaveBeenCalledWith('midnight');
    expect(screen.getByRole('button', { name: /Light/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /System/ })).toBeVisible();
    await fireEvent.click(screen.getByRole('button', { name: /Prefer light mode/ }));
    expect(mocks.setPreset).toHaveBeenCalledWith('light');
    expect(screen.getByRole('button', { name: 'Open primary accent picker' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open secondary accent picker' })).toBeVisible();

    await fireEvent.click(screen.getByRole('button', { name: /^Continue/ }));
    expect(screen.getByRole('heading', { name: 'How should Kory work with you?' })).toBeVisible();
    await fireEvent.click(screen.getByRole('button', { name: /Interview me/ }));
    expect(mocks.saveSettings).toHaveBeenCalledWith(
      { intentInterview: 'deep' },
      { quietSuccess: true },
    );

    await fireEvent.click(screen.getByRole('button', { name: /^Continue/ }));
    expect(
      screen.getByRole('heading', { name: 'How much should Kory do on its own?' }),
    ).toBeVisible();
    await fireEvent.click(screen.getByRole('button', { name: /^YOLO/ }));
    expect(mocks.saveSettings).toHaveBeenCalledWith(
      { permissionMode: 'yolo' },
      { quietSuccess: true },
    );
  });

  it('uses the welcome shortcuts as direct setup navigation', async () => {
    renderWalkthrough();

    await fireEvent.click(screen.getByRole('button', { name: 'Open Autonomy setup' }));

    expect(
      screen.getByRole('heading', { name: 'How much should Kory do on its own?' }),
    ).toBeVisible();
  });

  it('keeps the walkthrough active when the user jumps to provider settings', async () => {
    const { onOpenProviders } = renderWalkthrough();

    // Jump straight to the providers step via the rail.
    await fireEvent.click(screen.getByRole('button', { name: 'Providers' }));
    expect(screen.getByText(/1 provider detected on this machine/)).toBeVisible();

    await fireEvent.click(screen.getByRole('button', { name: /Connect a provider now/ }));
    expect(onOpenProviders).toHaveBeenCalledTimes(1);
    expect(onboardingStore.record).toBeNull();
  });

  it('marks the walkthrough complete from the final step', async () => {
    renderWalkthrough();

    await fireEvent.click(screen.getByRole('button', { name: 'Ready' }));
    expect(screen.getByRole('heading', { name: "You're set" })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Skip/ })).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: /Start using Koryphaios/ }));
    expect(onboardingStore.record?.outcome).toBe('completed');
  });

  it('skips with Escape and moves with arrow keys', async () => {
    renderWalkthrough();
    const dialog = screen.getByRole('dialog');

    await fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(screen.getByRole('heading', { name: 'Make it look like yours' })).toBeVisible();
    await fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(screen.getByRole('heading', { name: 'Welcome to Koryphaios' })).toBeVisible();

    await fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onboardingStore.record?.outcome).toBe('skipped');
  });
});
