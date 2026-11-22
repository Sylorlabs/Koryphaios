import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  removeEntries: vi.fn(),
  deleteEntry: vi.fn(),
  sessionStore: { activeSessionId: 'session-1' },
  isLoadingSession: false,
  isReplaying: false,
  feed: [] as Array<Record<string, unknown>>,
}));

vi.mock('$lib/stores/websocket.svelte', () => ({
  wsStore: {
    get groupedFeed() { return mocks.feed; },
    managerStatus: 'idle',
    get isLoadingSession() { return mocks.isLoadingSession; },
    removeEntries: mocks.removeEntries,
  },
}));

vi.mock('$lib/stores/sessions.svelte', () => ({
  sessionStore: mocks.sessionStore,
}));

vi.mock('$lib/stores/feed.svelte', () => ({
  feedStore: {
    sessionId: 'session-1',
    deleteEntry: mocks.deleteEntry,
    isReplayingSession: () => mocks.isReplaying,
  },
}));

vi.mock('$lib/stores/toast.svelte', () => ({
  toastStore: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock('$lib/stores/auth.svelte', () => ({
  authStore: { token: undefined },
}));

vi.mock('$lib/stores/project.svelte', () => ({
  // ManagerFeed's empty-state (with the suggestion cards and the Pro
  // Tips/Workflow panels the test exercises) only renders once the project
  // store reports a ready workspace. Tests that don't care about project
  // state must still supply a non-empty `currentPath` so the empty state
  // appears instead of the perpetual "Loading workspace…" placeholder.
  projectStore: {
    currentPath: '/tmp/project',
    workspaceRoot: '/tmp',
    revision: 1,
    scope: 'project',
    setScope: vi.fn(),
  },
  projectDisplayName: (path: string) => path.split('/').at(-1) ?? path,
}));

vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/api.svelte', () => ({ apiFetch: vi.fn(), parseJsonResponse: vi.fn() }));

const autoScroll = vi.hoisted(() => ({
  follow: true,
  hasContentBelow: false,
  unseenCount: 0,
  attach: vi.fn(),
  requestPin: vi.fn(),
  notifyNewEntry: vi.fn(),
  jumpToBottom: vi.fn(),
  setFollow: vi.fn(),
  setSuspended: vi.fn(),
}));

vi.mock('$lib/utils/autoscroll.svelte', () => ({
  createAutoScroll: () => autoScroll,
}));

import ManagerFeed from './ManagerFeed.svelte';
import { welcomePreferencesStore } from '$lib/stores/welcome-preferences.svelte';

const BACKGROUND = {
  source: 'data:image/png;base64,aGk=',
  fit: 'cover' as const,
  position: 'center' as const,
  opacity: 1,
};

describe('ManagerFeed suggestion controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isLoadingSession = false;
    mocks.isReplaying = false;
    mocks.feed = [];
    welcomePreferencesStore.setBackground(undefined);
  });

  it('shows the chat loading surface instead of empty-chat suggestions while history loads', () => {
    mocks.isLoadingSession = true;
    render(ManagerFeed);
    expect(screen.getByRole('status').textContent).toContain('Loading chat');
    expect(screen.queryByRole('button', { name: 'Load Map the codebase into composer' })).toBeNull();
  });

  it('starts bottom-anchored and covers the transcript until it has landed', async () => {
    mocks.feed = [
      {
        id: 'entry-1',
        timestamp: Date.now(),
        type: 'content',
        agentId: 'agent-1',
        agentName: 'Agent',
        glowClass: '',
        text: 'hello there',
      },
    ];
    const { container } = render(ManagerFeed);

    // A parked position from the previous chat must not make this one paint
    // from the top and then crawl down to the bottom.
    expect(autoScroll.setFollow).toHaveBeenCalledWith(true);
    // The list is mounted underneath but hidden until its rows stop measuring.
    expect(screen.getByText('hello there')).toBeTruthy();
    expect(container.querySelector('.chat-loading.cover')).not.toBeNull();

    await waitFor(() => expect(container.querySelector('.chat-loading.cover')).toBeNull());
    expect(screen.getByText('hello there')).toBeTruthy();
  });

  it('does not hold the transcript cover for a replay burst once landed', async () => {
    mocks.feed = [
      {
        id: 'entry-1',
        timestamp: Date.now(),
        type: 'content',
        agentId: 'agent-1',
        agentName: 'Agent',
        glowClass: '',
        text: 'hello there',
      },
    ];
    mocks.isReplaying = true;
    const { container } = render(ManagerFeed);

    // Replayed events fold without touching the visible rows and merge in one
    // settle at the burst's end, so the reader is not kept behind a spinner
    // for the remainder of the log.
    await waitFor(() =>
      expect(container.querySelector('.chat-loading.cover')).toBeNull(),
    );
  });

  it('keeps load and edit actions as sibling buttons with independent behavior', async () => {
    const onUseSuggestion = vi.fn();
    const { container } = render(ManagerFeed, { props: { onUseSuggestion } });

    const load = screen.getByRole('button', { name: 'Load Map the codebase into composer' });
    const edit = screen.getByRole('button', { name: 'Edit Map the codebase' });
    expect(load.contains(edit)).toBe(false);
    expect(container.querySelector('button button, [role="button"] button')).toBeNull();

    await fireEvent.click(load);
    expect(onUseSuggestion).toHaveBeenCalledWith(
      expect.stringContaining('Inspect this project and summarize the architecture'),
    );

    await fireEvent.click(edit);
    expect(screen.getByRole('textbox')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Load Map the codebase into composer' }),
    ).toBeNull();
    expect(container.querySelector('button button, [role="button"] button')).toBeNull();
  });
});

describe('ManagerFeed home background', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isLoadingSession = false;
    mocks.isReplaying = false;
    mocks.feed = [];
    welcomePreferencesStore.setBackground(undefined);
  });

  it('renders the home background layer for an empty feed', () => {
    welcomePreferencesStore.setBackground({ ...BACKGROUND });
    const { container } = render(ManagerFeed);
    expect(container.querySelector('.welcome-background-layer')).not.toBeNull();
  });

  it('keeps the home background mounted after the feed has entries', () => {
    welcomePreferencesStore.setBackground({ ...BACKGROUND });
    mocks.feed = [
      {
        id: 'entry-1',
        timestamp: Date.now(),
        type: 'content',
        agentId: 'agent-1',
        agentName: 'Agent',
        glowClass: '',
        text: 'hello there',
      },
    ];
    const { container } = render(ManagerFeed);
    // Invoking a prompt populates the feed; it must not reset the user's
    // selected background.
    expect(screen.getByText('hello there')).toBeTruthy();
    expect(container.querySelector('.welcome-background-layer')).not.toBeNull();
    expect(container.querySelector('.welcome-background')).toHaveAttribute('src', BACKGROUND.source);
  });
});
