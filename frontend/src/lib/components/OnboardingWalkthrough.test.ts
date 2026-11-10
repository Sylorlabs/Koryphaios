import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
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
  apiFetch: vi.fn(),
  fetchSessions: vi.fn(async () => undefined),
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

vi.mock('$lib/api.svelte', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

vi.mock('$lib/stores/sessions.svelte', () => ({
  sessionStore: {
    fetchSessions: mocks.fetchSessions,
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
    getCustomProviderIcon: () => null,
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

const mockDiscoveryData = {
  providers: [
    {
      id: 'claude',
      provider: 'claude',
      displayName: 'Claude Code',
      checked: true,
      storageFound: true,
      checkedPaths: ['~/.claude/projects'],
      chatCount: 2,
      projectCount: 1,
    },
    {
      id: 'codex',
      provider: 'codex',
      displayName: 'Codex CLI',
      checked: true,
      storageFound: false,
      checkedPaths: ['~/.codex/sessions'],
      chatCount: 0,
      projectCount: 0,
    },
    {
      id: 'devin',
      provider: 'devin',
      displayName: 'Devin',
      checked: true,
      storageFound: true,
      checkedPaths: ['~/.devin/sessions'],
      chatCount: 1,
      projectCount: 1,
    },
    {
      id: 'antigravity',
      provider: 'antigravity',
      displayName: 'Antigravity',
      checked: true,
      storageFound: false,
      checkedPaths: ['~/.gemini/antigravity'],
      chatCount: 0,
      projectCount: 0,
    },
  ],
  projects: [
    {
      projectPath: '/Users/Shared/micah/projects/alpha',
      projectName: 'alpha',
      chatCount: 2,
      latestUpdatedAt: 1760000060000,
      providers: [{ provider: 'claude', displayName: 'Claude Code', chatCount: 2 }],
      chats: [
        {
          id: 'claude:c-1',
          externalId: 'c-1',
          provider: 'claude',
          providerDisplayName: 'Claude Code',
          projectPath: '/Users/Shared/micah/projects/alpha',
          projectName: 'alpha',
          title: 'Refactor alpha router',
          preview: 'Please refactor router to use v2 API',
          model: 'claude-3-7-sonnet',
          messageCount: 5,
          createdAt: 1760000000000,
          updatedAt: 1760000060000,
          alreadyImported: false,
          sampleMessages: [
            {
              role: 'user',
              content: 'Please refactor router to use v2 API',
              createdAt: 1760000000000,
            },
          ],
        },
        {
          id: 'claude:c-2',
          externalId: 'c-2',
          provider: 'claude',
          providerDisplayName: 'Claude Code',
          projectPath: '/Users/Shared/micah/projects/alpha',
          projectName: 'alpha',
          title: 'Write alpha tests',
          preview: 'Add vitest coverage for router',
          model: 'claude-3-7-sonnet',
          messageCount: 4,
          createdAt: 1760000010000,
          updatedAt: 1760000050000,
          alreadyImported: false,
          sampleMessages: [],
        },
      ],
    },
    {
      projectPath: '/Users/Shared/micah/projects/beta',
      projectName: 'beta',
      chatCount: 1,
      latestUpdatedAt: 1760080060000,
      providers: [{ provider: 'devin', displayName: 'Devin', chatCount: 1 }],
      chats: [
        {
          id: 'devin:dv-1',
          externalId: 'dv-1',
          provider: 'devin',
          providerDisplayName: 'Devin',
          projectPath: '/Users/Shared/micah/projects/beta',
          projectName: 'beta',
          title: 'Fix beta migration',
          preview: 'Fix the SQLite migration in beta',
          model: 'devin-default',
          messageCount: 3,
          createdAt: 1760080000000,
          updatedAt: 1760080060000,
          alreadyImported: false,
          sampleMessages: [
            {
              role: 'user',
              content: 'Fix the SQLite migration in beta',
              createdAt: 1760080000000,
            },
          ],
        },
      ],
    },
  ],
  totalChats: 3,
  totalProjects: 2,
};

function renderWalkthrough() {
  const onOpenProviders = vi.fn();
  const onOpenDevices = vi.fn();
  const rendered = render(OnboardingWalkthrough, { props: { onOpenProviders, onOpenDevices } });
  return { onOpenProviders, onOpenDevices, ...rendered };
}

describe('OnboardingWalkthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    onboardingStore.reset();
    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/cli-chat-import/discover')) {
        return new Response(JSON.stringify({ ok: true, data: mockDiscoveryData }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (String(url).includes('/api/cli-chat-import/import')) {
        const body = init?.body ? JSON.parse(String(init.body)) : { chatIds: [] };
        const chatIds: string[] = body.chatIds ?? [];
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              importedCount: chatIds.length,
              alreadyImportedCount: 0,
              sessions: chatIds.map((id, i) => ({ id: `ported-${i}`, title: id })),
              items: chatIds.map((chatId, i) => ({
                chatId,
                sessionId: `ported-${i}`,
                status: 'imported',
              })),
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
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
    expect(screen.queryByRole('button', { name: /Prefer light mode/ })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Light' }));
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
    await fireEvent.click(screen.getByRole('button', { name: /^Accept edits/ }));
    expect(mocks.saveSettings).toHaveBeenCalledWith(
      { permissionMode: 'edits' },
      { quietSuccess: true },
    );
    expect(screen.getByText('Critic', { exact: true })).toBeVisible();
    await fireEvent.click(screen.getByRole('combobox', { name: 'Critic mode' }));
    await fireEvent.click(screen.getByRole('option', { name: /^Auto/ }));
    expect(mocks.saveSettings).toHaveBeenCalledWith(
      { criticMode: 'auto' },
      { quietSuccess: true },
    );
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

  it('shows providers first, allows expanding provider then project, category selection and cherry-picking', async () => {
    renderWalkthrough();

    await fireEvent.click(screen.getByRole('button', { name: 'Port chats' }));
    expect(
      screen.getByRole('heading', { name: 'Port existing chats from your projects' }),
    ).toBeVisible();

    // Wait for discovery to resolve
    await waitFor(() => {
      expect(screen.getByText(/Checked all 4 CLI providers/)).toBeVisible();
    });

    // Level 1: Providers are shown first. Projects are not visible yet.
    expect(screen.getByText('Claude Code')).toBeVisible();
    expect(screen.getByText('Devin')).toBeVisible();
    expect(screen.queryByText('Refactor alpha router')).toBeNull();

    // Level 1 -> Level 2: Expand provider "Claude Code", then expand project "alpha"
    await fireEvent.click(screen.getByRole('button', { name: 'Toggle provider Claude Code' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Toggle project alpha' }));
    expect(screen.getByText('Refactor alpha router')).toBeVisible();
    expect(screen.getByText('Write alpha tests')).toBeVisible();

    // Test category selection: choosing entire Claude Code category selects both chats in alpha
    const claudeCatBtn = screen.getByRole('checkbox', {
      name: 'Select entire Claude Code category',
    });
    await fireEvent.click(claudeCatBtn);
    expect(screen.getByText(/2 chats selected/)).toBeVisible();

    // Deselect to test cherry-picking across mixed providers
    await fireEvent.click(claudeCatBtn);
    expect(screen.queryByText(/chats selected/)).toBeNull();

    // Cherry-pick 1 chat from Claude in alpha + 1 chat from Devin in beta
    // Level 1 -> Level 2: Expand provider "Devin", then project "beta"
    await fireEvent.click(screen.getByRole('button', { name: 'Toggle provider Devin' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Toggle project beta' }));
    expect(screen.getByText('Fix beta migration')).toBeVisible();

    // Cherry-pick individual chats (Level 3)
    await fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select chat Refactor alpha router' }),
    );
    await fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select chat Fix beta migration' }),
    );

    expect(screen.getByText(/2 chats selected/)).toBeVisible();
    expect(screen.getByText(/across 2 projects and 2 providers/)).toBeVisible();

    // Port the selected chats
    await fireEvent.click(screen.getByRole('button', { name: /Port 2 selected chats/ }));

    await waitFor(() => {
      expect(mocks.apiFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/cli-chat-import/import'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ chatIds: ['claude:c-1', 'devin:dv-1'] }),
        }),
      );
    });
    expect(mocks.fetchSessions).toHaveBeenCalledTimes(1);
  });

  it('marks the walkthrough complete from the final step', async () => {
    renderWalkthrough();

    await fireEvent.click(screen.getByRole('button', { name: 'Link device' }));
    expect(screen.getByRole('heading', { name: 'Take Koryphaios with you' })).toBeVisible();
    expect(onboardingStore.record).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: /^Continue/ }));
    expect(screen.getByRole('heading', { name: "You're set" })).toBeVisible();
    expect(screen.getByText('Step 8 of 8')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Skip/ })).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: /Start using Koryphaios/ }));
    expect(onboardingStore.record?.outcome).toBe('completed');
  });

  it('offers device linking as the last optional step and resumes it after Settings closes', async () => {
    const { onOpenDevices, onOpenProviders, rerender } = renderWalkthrough();
    const rail = within(screen.getByRole('navigation', { name: 'Walkthrough steps' }));
    expect(rail.getAllByRole('button').at(-2)).toHaveTextContent('Link device');
    expect(rail.getAllByRole('button').at(-1)).toHaveTextContent('Ready');
    await fireEvent.click(rail.getByRole('button', { name: 'Link device' }));
    expect(screen.getByRole('heading', { name: 'Phone or tablet' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Another desktop' })).toBeVisible();
    await fireEvent.click(screen.getByRole('button', { name: 'Link a device now' }));
    expect(onOpenDevices).toHaveBeenCalledOnce();
    expect(onboardingStore.record).toBeNull();
    await rerender({ suspended: true, onOpenDevices, onOpenProviders });
    expect(screen.queryByRole('dialog')).toBeNull();
    await rerender({ suspended: false, onOpenDevices, onOpenProviders });
    expect(screen.getByRole('heading', { name: 'Take Koryphaios with you' })).toBeVisible();
    expect(screen.getByText('Step 7 of 8')).toBeVisible();
    await fireEvent.click(screen.getByRole('button', { name: /^Continue/ }));
    expect(screen.getByRole('heading', { name: "You're set" })).toBeVisible();
    await fireEvent.click(screen.getByRole('button', { name: 'Start using Koryphaios' }));
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
