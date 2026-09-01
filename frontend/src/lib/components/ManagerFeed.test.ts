import { fireEvent, render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  removeEntries: vi.fn(),
  deleteEntry: vi.fn(),
  sessionStore: { activeSessionId: 'session-1' },
}));

vi.mock('$lib/stores/websocket.svelte', () => ({
  wsStore: {
    groupedFeed: [],
    managerStatus: 'idle',
    isLoadingSession: false,
    removeEntries: mocks.removeEntries,
  },
}));

vi.mock('$lib/stores/sessions.svelte', () => ({
  sessionStore: mocks.sessionStore,
}));

vi.mock('$lib/stores/feed.svelte', () => ({
  feedStore: { deleteEntry: mocks.deleteEntry },
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

vi.mock('$lib/utils/autoscroll.svelte', () => ({
  createAutoScroll: () => ({
    follow: true,
    unseenCount: 0,
    attach: vi.fn(),
    requestPin: vi.fn(),
    notifyNewEntry: vi.fn(),
    jumpToBottom: vi.fn(),
  }),
}));

import ManagerFeed from './ManagerFeed.svelte';

describe('ManagerFeed suggestion controls', () => {
  beforeEach(() => vi.clearAllMocks());

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
