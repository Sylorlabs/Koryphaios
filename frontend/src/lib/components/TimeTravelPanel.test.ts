import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  parseJsonResponse: vi.fn(),
  toastError: vi.fn(),
  sessionStore: { activeSessionId: 'session-1' },
}));

vi.mock('$lib/api.svelte', () => ({
  apiFetch: mocks.apiFetch,
  parseJsonResponse: mocks.parseJsonResponse,
}));

vi.mock('$lib/utils/api-url', () => ({
  apiUrl: (path: string) => path,
}));

vi.mock('$lib/stores/sessions.svelte', () => ({
  sessionStore: mocks.sessionStore,
}));

vi.mock('$lib/stores/toast.svelte', () => ({
  toastStore: { error: mocks.toastError },
}));

vi.mock('$lib/stores/websocket.svelte', () => ({
  wsStore: { rewindPreviewLoadingHash: null, previewRewind: vi.fn() },
}));

vi.mock('$lib/stores/run-state.svelte', () => ({
  runStateStore: { isBusy: vi.fn(() => false) },
}));

import TimeTravelPanel from './TimeTravelPanel.svelte';

describe('TimeTravelPanel loading truth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionStore.activeSessionId = 'session-1';
  });

  it('keeps repository failures distinct from an empty timeline and offers a retry', async () => {
    const repositoryError = 'No Git repository found at /tmp/provider-free-workspace';
    mocks.apiFetch
      .mockRejectedValueOnce(new Error(repositoryError))
      .mockResolvedValueOnce({ ok: true });
    mocks.parseJsonResponse.mockResolvedValueOnce({
      ok: true,
      data: {
        currentHash: '',
        timeline: [],
        canUndo: false,
        canRedo: false,
        stats: { totalStates: 0, totalCost: 0, modelsUsed: [] },
      },
    });

    render(TimeTravelPanel, { props: { open: true } });

    expect(await screen.findByRole('alert')).toHaveTextContent(repositoryError);
    expect(screen.queryByText('No recorded states yet')).toBeNull();
    expect(mocks.toastError).toHaveBeenCalledWith(repositoryError);

    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.getByText('No recorded states yet')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
  });
});
