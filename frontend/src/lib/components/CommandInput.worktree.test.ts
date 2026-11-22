// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { settings, sessionApi } = vi.hoisted(() => ({
  settings: { value: {} as Record<string, unknown> },
  sessionApi: {
    setSessionAgentOverrides: vi.fn(async () => true),
    sessions: [] as Array<{ id: string; agentOverrides: Record<string, unknown> }>,
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
          name: 'devin',
          enabled: true,
          authenticated: true,
          models: ['claude-opus-5-5'],
          allAvailableModels: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }],
        },
      ];
    },
    feed: [],
    setYoloMode: vi.fn(),
    contextUsage: null,
    beginManagerContextPreview: vi.fn(),
  },
}));
vi.mock('$lib/stores/sessions.svelte', () => ({
  sessionStore: {
    get activeSessionId() {
      return sessionApi.sessions[0]?.id ?? null;
    },
    get sessions() {
      return sessionApi.sessions;
    },
    setSessionAgentOverrides: sessionApi.setSessionAgentOverrides,
  },
}));
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
  agentSettingsStore: {
    get settings() {
      return settings.value;
    },
    loadSettings: vi.fn(),
    saveSettings: vi.fn(async () => true),
  },
}));

import CommandInput from './CommandInput.svelte';

describe('composer Worktree preset chip', () => {
  beforeEach(() => {
    localStorage.clear();
    settings.value = {};
    sessionApi.sessions = [{ id: 's1', agentOverrides: {} }];
    sessionApi.setSessionAgentOverrides.mockClear();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  it('cycles Auto → On → Off → Auto and persists the mode per chat', async () => {
    render(CommandInput, {
      onSend: vi.fn(() => true),
      selectedModel: 'devin:claude-opus-5-5',
      disableModelPreviewRequests: true,
      draftKey: 'worktree-test',
    });
    const chip = await screen.findByTestId('composer-worktree-toggle');
    expect(chip.textContent).toContain('Worktree: Auto');
    expect(chip.title).toContain('manager decides');

    await fireEvent.click(chip);
    expect(chip.textContent).toContain('Worktree: On');
    expect(sessionApi.setSessionAgentOverrides).toHaveBeenLastCalledWith(
      's1',
      expect.objectContaining({ worktreeMode: 'always' }),
    );

    await fireEvent.click(chip);
    expect(chip.textContent).toContain('Worktree: Off');
    expect(sessionApi.setSessionAgentOverrides).toHaveBeenLastCalledWith(
      's1',
      expect.objectContaining({ worktreeMode: 'never' }),
    );

    await fireEvent.click(chip);
    expect(chip.textContent).toContain('Worktree: Auto');
    expect(sessionApi.setSessionAgentOverrides).toHaveBeenLastCalledWith(
      's1',
      expect.objectContaining({ worktreeMode: 'auto' }),
    );
  });

  it('migrates a legacy saved boolean into the cycling label', async () => {
    // Session overrides written before the preset existed carry the checkbox.
    sessionApi.sessions = [{ id: 's1', agentOverrides: { worktreeIsolation: false } }];
    render(CommandInput, {
      onSend: vi.fn(() => true),
      selectedModel: 'devin:claude-opus-5-5',
      disableModelPreviewRequests: true,
      draftKey: 'worktree-legacy',
    });
    const chip = await screen.findByTestId('composer-worktree-toggle');
    expect(chip.textContent).toContain('Worktree: Off');
  });
});
