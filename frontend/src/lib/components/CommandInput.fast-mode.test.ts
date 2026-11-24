// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadComposerPreference } from '$lib/stores/composer-preferences';
import type { ModelSpeedTier } from '@koryphaios/shared';

const FAST_TIER: ModelSpeedTier = {
  id: 'fast',
  label: 'Fast',
  description: 'Test fast tier.',
};

const { catalog } = vi.hoisted(() => ({
  catalog: {
    name: 'devin',
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    speedTiers: [{ id: 'fast', label: 'Fast', description: 'Test fast tier.' }] as
      ModelSpeedTier[] | undefined,
  },
}));

vi.mock('$lib/api.svelte', () => ({ apiFetch: vi.fn(async () => new Response('{}')) }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('./icons/ProviderIcon.svelte', async () => ({
  default: (await import('lucide-svelte/icons/circle')).default,
}));
vi.mock('$lib/stores/websocket.svelte', () => ({
  wsStore: {
    get providers() {
      return [
        {
          name: catalog.name,
          enabled: true,
          authenticated: true,
          models: [catalog.id],
          allAvailableModels: [
            {
              id: catalog.id,
              name: catalog.label,
              speedTiers: catalog.speedTiers,
            },
          ],
        },
      ];
    },
    feed: [],
    setYoloMode: vi.fn(),
    contextUsage: null,
  },
}));
vi.mock('$lib/stores/sessions.svelte', () => ({ sessionStore: { activeSessionId: null } }));
vi.mock('$lib/stores/project.svelte', () => ({ projectStore: { currentPath: null } }));
vi.mock('$lib/stores/goals.svelte', () => ({
  goalStore: { goals: [], loaded: true, refresh: vi.fn(), selectedGoalId: '' },
}));
vi.mock('$lib/stores/goal-display.svelte', () => ({
  goalDisplayStore: { composer: false, update: vi.fn() },
}));
vi.mock('$lib/utils/now-signal.svelte', () => ({
  useNow: () => ({ now: Date.now(), unsubscribe: vi.fn() }),
  useSecondClock: () => ({ now: Date.now(), unsubscribe: vi.fn() }),
}));
vi.mock('$lib/stores/agent-settings.svelte', () => ({
  agentSettingsStore: { settings: {}, loadSettings: vi.fn() },
}));

import CommandInput from './CommandInput.svelte';

const model = 'devin:claude-opus-5-5';
function composer(selectedModel: string = model) {
  const onSend = vi.fn((..._args: unknown[]) => true);
  const result = render(CommandInput, {
    onSend,
    selectedModel,
    disableModelPreviewRequests: true,
    draftKey: 'fast-mode-test',
  });
  return { ...result, onSend };
}

describe('composer speed-tier control', () => {
  beforeEach(() => {
    localStorage.clear();
    catalog.speedTiers = [FAST_TIER];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  it('cycles Off → Fast → Off on chip-body clicks', async () => {
    composer();
    await screen.findByLabelText('Fast: off');
    await fireEvent.click(screen.getByLabelText('Fast: off'));
    expect(screen.getByLabelText('Fast: on')).toBeTruthy();
    await fireEvent.click(screen.getByLabelText('Fast: on'));
    expect(screen.getByLabelText('Fast: off')).toBeTruthy();
  });

  it('cycles Off → A → B → Off with two tiers', async () => {
    catalog.speedTiers = [
      { id: 'a', label: 'Alpha', description: 'a' },
      { id: 'b', label: 'Beta', description: 'b' },
    ];
    composer();
    await screen.findByLabelText('Alpha: off');
    await fireEvent.click(screen.getByLabelText('Alpha: off'));
    expect(screen.getByLabelText('Alpha: on')).toBeTruthy();
    await fireEvent.click(screen.getByLabelText('Alpha: on'));
    expect(screen.getByLabelText('Beta: on')).toBeTruthy();
    await fireEvent.click(screen.getByLabelText('Beta: on'));
    expect(screen.getByLabelText('Alpha: off')).toBeTruthy();
  });

  it('hides the chip after switching to a model with no tiers', async () => {
    const { rerender } = composer();
    await screen.findByTestId('composer-fast-control');
    await rerender({ selectedModel: 'devin:plain-model' });
    await waitFor(() => expect(screen.queryByTestId('composer-fast-control')).toBeNull());
  });

  it('selects a tier directly from the menu and persists it per provider:model', async () => {
    composer();
    await screen.findByLabelText('Fast: off');
    // The chevron opens the menu; the body does not.
    await fireEvent.click(screen.getByLabelText('Fast options'));
    const menu = await screen.findByRole('menu');
    expect(menu.textContent).toContain('Test fast tier.');
    await fireEvent.click(screen.getByRole('menuitemradio', { name: /Fast/ }));
    await waitFor(() => expect(loadComposerPreference(model).speedTier).toBe('fast'));
    expect(screen.getByLabelText('Fast: on')).toBeTruthy();
    // Selecting Off from the menu stores an explicit off choice.
    await fireEvent.click(screen.getByLabelText('Fast options'));
    await fireEvent.click(screen.getByRole('menuitemradio', { name: 'Off' }));
    await waitFor(() => expect(loadComposerPreference(model).speedTier).toBeNull());
    expect(screen.getByLabelText('Fast: off')).toBeTruthy();
  });

  it('sends the selected speedTier to onSend', async () => {
    const { onSend } = composer();
    await screen.findByLabelText('Fast: off');
    await fireEvent.click(screen.getByLabelText('Fast: off'));
    expect(screen.getByLabelText('Fast: on')).toBeTruthy();
  });
});
