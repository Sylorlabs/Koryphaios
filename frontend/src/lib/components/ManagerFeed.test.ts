import { fireEvent, render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  removeEntries: vi.fn(),
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

vi.mock('$lib/stores/auth.svelte', () => ({
  authStore: { token: undefined },
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
