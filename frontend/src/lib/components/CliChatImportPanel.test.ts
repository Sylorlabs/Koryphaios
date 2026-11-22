import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom has no Web Animations API; Svelte transitions call element.animate().
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
}));

vi.mock('$lib/api.svelte', () => ({ apiFetch: (...args: unknown[]) => mocks.apiFetch(...args) }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/stores/sessions.svelte', () => ({
  sessionStore: { fetchSessions: mocks.fetchSessions },
}));
vi.mock('$lib/stores/toast.svelte', () => ({
  toastStore: { success: vi.fn(), error: vi.fn() },
}));

import CliChatImportPanel from './CliChatImportPanel.svelte';
import { cliChatImportStore } from '$lib/stores/cli-chat-import.svelte';

const CHAT_COUNT = 18;

function discovery() {
  const chats = Array.from({ length: CHAT_COUNT }, (_, i) => ({
    id: `claude:c-${i}`,
    externalId: `c-${i}`,
    provider: 'claude',
    providerDisplayName: 'Claude Code',
    projectPath: '/work/alpha',
    projectName: 'alpha',
    title: `Chat number ${i}`,
    preview: `Preview ${i}`,
    messageCount: 4,
    createdAt: 1_000 + i,
    updatedAt: 2_000 - i,
    alreadyImported: false,
    sampleMessages: [],
  }));
  return {
    ok: true,
    data: {
      providers: [
        {
          id: 'claude',
          provider: 'claude',
          displayName: 'Claude Code',
          checked: true,
          storageFound: true,
          checkedPaths: ['/home/.claude'],
          chatCount: CHAT_COUNT,
          projectCount: 1,
        },
        {
          id: 'grok',
          provider: 'grok',
          displayName: 'Grok CLI',
          checked: true,
          storageFound: false,
          checkedPaths: ['/home/.grok'],
          chatCount: 0,
          projectCount: 0,
        },
      ],
      projects: [
        {
          projectPath: '/work/alpha',
          projectName: 'alpha',
          chatCount: CHAT_COUNT,
          providers: [{ provider: 'claude', displayName: 'Claude Code', chatCount: CHAT_COUNT }],
          latestUpdatedAt: 2_000,
          chats,
        },
      ],
    },
  };
}

function discoverCalls() {
  return mocks.apiFetch.mock.calls.filter(([url]) =>
    String(url).includes('/api/cli-chat-import/discover'),
  ).length;
}

beforeEach(() => {
  vi.clearAllMocks();
  cliChatImportStore.reset();
  mocks.apiFetch.mockImplementation(
    async () =>
      new Response(JSON.stringify(discovery()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
});

describe('CliChatImportPanel', () => {
  it('renders a prefetched discovery immediately without scanning again', async () => {
    await cliChatImportStore.prefetch();
    expect(discoverCalls()).toBe(1);

    const onImportedChange = vi.fn();
    render(CliChatImportPanel, { props: { onImportedChange } });

    expect(screen.getByText(/Checked all 2 CLI providers/)).toBeVisible();
    expect(screen.queryByText(/Scanning CLI chat histories/)).toBeNull();
    expect(screen.getByText('1 checked CLIs had no chats')).toBeVisible();
    expect(discoverCalls()).toBe(1);
    expect(onImportedChange).toHaveBeenCalledWith(0);
  });

  it('shows the scanning state until the first discovery resolves, and Rescan refetches', async () => {
    render(CliChatImportPanel);
    expect(screen.getByText(/Scanning CLI chat histories/)).toBeVisible();
    await waitFor(() => expect(screen.getByText(/Checked all 2 CLI providers/)).toBeVisible());
    expect(discoverCalls()).toBe(1);

    await fireEvent.click(screen.getByRole('button', { name: 'Rescan CLI providers' }));
    await waitFor(() => expect(discoverCalls()).toBe(2));
  });

  it('keeps the port action inert until a chat is selected and reaches chats past the first page', async () => {
    await cliChatImportStore.prefetch();
    render(CliChatImportPanel);

    const port = screen.getByRole('button', { name: /Port selected chats/ });
    expect(port).toBeDisabled();

    await fireEvent.click(screen.getByRole('button', { name: 'Toggle provider Claude Code' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Toggle project alpha' }));
    expect(screen.getAllByTestId('cli-import-chat-row')).toHaveLength(15);

    await fireEvent.click(screen.getByRole('button', { name: `Show all ${CHAT_COUNT} chats` }));
    expect(screen.getAllByTestId('cli-import-chat-row')).toHaveLength(CHAT_COUNT);

    await fireEvent.click(screen.getByRole('checkbox', { name: 'Select chat Chat number 17' }));
    expect(screen.getByRole('button', { name: /Port 1 selected chat/ })).toBeEnabled();
  });
});
