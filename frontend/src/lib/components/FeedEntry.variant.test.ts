import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedEntryLocal } from '$lib/types';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  fetchMessages: vi.fn(),
  loadSessionMessages: vi.fn(),
  onDelete: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('$lib/api.svelte', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
  parseJsonResponse: async (response: Response) => response.json(),
}));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/stores/sessions.svelte', () => ({
  sessionStore: {
    activeSessionId: 'session-1',
    fetchMessages: (...args: unknown[]) => mocks.fetchMessages(...args),
  },
}));
vi.mock('$lib/stores/websocket.svelte', () => ({
  wsStore: {
    loadSessionMessages: (...args: unknown[]) => mocks.loadSessionMessages(...args),
    setEntryVisibility: vi.fn(),
    rewind: vi.fn(),
    rewindPreviewLoadingHash: '',
  },
}));
vi.mock('$lib/stores/project.svelte', () => ({
  projectStore: { currentPath: '/tmp/project' },
}));
vi.mock('$lib/stores/auth.svelte', () => ({ authStore: { token: undefined } }));
vi.mock('$lib/stores/agent-settings.svelte', () => ({
  agentSettingsStore: { settings: { reasoningExpandedByDefault: true } },
}));
vi.mock('$lib/stores/toast.svelte', () => ({
  toastStore: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

import FeedEntry from './FeedEntry.svelte';
import { runStateStore } from '$lib/stores/run-state.svelte';

function entry(): FeedEntryLocal {
  return {
    id: 'hist-v0',
    timestamp: 100,
    type: 'content',
    agentId: 'kory-manager',
    agentName: 'Kory',
    glowClass: 'glow-kory',
    text: 'answer zero',
    metadata: {
      sessionId: 'session-1',
      messageId: 'v0',
      model: 'model-zero',
      provider: 'provider-zero',
      variantGroupId: 'group-1',
      activeVariantId: 'v0',
      variantIdentityAuthoritative: true,
      activeMessageId: 'follow-up-head',
      conversationRevision: 9,
      providerConversationRevision: 4,
      responseVariants: [
        {
          id: 'v0',
          content: 'answer zero',
          model: 'model-zero',
          provider: 'provider-zero',
          index: 0,
          isActive: true,
        },
        {
          id: 'v1',
          content: 'answer one',
          model: 'model-one',
          provider: 'provider-one',
          index: 1,
          isActive: false,
        },
      ],
    },
  };
}

function renderEntry() {
  return render(FeedEntry, {
    props: {
      entry: entry(),
      isSelected: false,
      isExpanded: false,
      onSelect: vi.fn(),
      onToggleGroup: vi.fn(),
      onDelete: mocks.onDelete,
    },
  });
}

function terminalRun(runId: string, phase: 'done' | 'error' | 'cancelled', reason: string | null) {
  runStateStore.applyEvent({
    type: 'run.state',
    sessionId: 'session-1',
    timestamp: 200,
    payload: {
      snapshot: {
        sessionId: 'session-1',
        runId,
        revision: 2,
        phase,
        status: 'terminal',
        waitingReason: '',
        continuationId: null,
        activeAgentIds: [],
        startedAt: 100,
        updatedAt: 200,
        finishedAt: 200,
        terminalReason: reason,
      },
      transition: null,
    },
  } as never);
}

describe('FeedEntry response variant actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runStateStore.clearAll();
    mocks.fetchMessages.mockResolvedValue([]);
    mocks.loadSessionMessages.mockResolvedValue(undefined);
  });

  afterEach(() => runStateStore.clearAll());

  it('regenerates the selected visible variant and refreshes only after its runId completes', async () => {
    mocks.apiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          data: { runId: 'regen-run', groupId: 'group-1', index: 2 },
        }),
      ),
    );
    renderEntry();
    await fireEvent.click(screen.getByRole('button', { name: 'Next response' }));
    await waitFor(() => expect(screen.getByText('answer one')).toBeTruthy());

    await fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    const [, request] = mocks.apiFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({
      sessionId: 'session-1',
      messageId: 'v1',
      model: 'provider-one:model-one',
    });
    expect(mocks.fetchMessages).not.toHaveBeenCalled();

    terminalRun('regen-run', 'done', 'completed');
    await waitFor(() => expect(mocks.fetchMessages).toHaveBeenCalledTimes(1));
    expect(mocks.loadSessionMessages).toHaveBeenCalledTimes(1);
  });

  it('surfaces the matching run failure without fetching history', async () => {
    mocks.apiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          data: { runId: 'failed-run', groupId: 'group-1', index: 2 },
        }),
      ),
    );
    renderEntry();
    await fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    terminalRun('failed-run', 'error', 'provider_failed');

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('provider_failed'));
    expect(mocks.fetchMessages).not.toHaveBeenCalled();
  });

  it('CAS-activates and deletes the selected visible sibling', async () => {
    mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, data: {} })));
    renderEntry();
    await fireEvent.click(screen.getByRole('button', { name: 'Next response' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Use this response' }));

    const [url, request] = mocks.apiFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/messages/variant');
    expect(JSON.parse(String(request.body))).toEqual({
      sessionId: 'session-1',
      messageId: 'v1',
      expectedActiveMessageId: 'follow-up-head',
      expectedProviderConversationRevision: 4,
    });

    await fireEvent.click(screen.getByTitle('Delete the response currently shown'));
    expect(mocks.onDelete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messageId: 'v1',
        model: 'model-one',
        provider: 'provider-one',
      }),
    );
  });
});
