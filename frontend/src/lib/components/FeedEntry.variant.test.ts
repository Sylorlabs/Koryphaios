// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedEntryLocal } from '$lib/types';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  fetchMessages: vi.fn(),
  forkSession: vi.fn(),
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
    forkSession: (...args: unknown[]) => mocks.forkSession(...args),
  },
}));
vi.mock('$lib/stores/websocket.svelte', () => ({
  wsStore: {
    loadSessionMessages: (...args: unknown[]) => mocks.loadSessionMessages(...args),
    invalidateManagerContextUsage: vi.fn(),
    closeStreamTurn: vi.fn(),
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
    mocks.apiFetch.mockImplementation((url: string) =>
      Promise.resolve(
        new Response(
          url === '/api/messages/variant'
            ? JSON.stringify({ ok: true, data: {} })
            : JSON.stringify({
                ok: true,
                data: { runId: 'regen-run', groupId: 'group-1', index: 2 },
              }),
        ),
      ),
    );
    renderEntry();
    await fireEvent.click(screen.getByRole('button', { name: 'Next response' }));
    await waitFor(() => expect(screen.getByText('answer one')).toBeTruthy());

    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/messages/variant',
      expect.objectContaining({
        body: expect.stringContaining('"messageId":"v1"'),
      }),
    );
    await waitFor(() => expect(mocks.fetchMessages).toHaveBeenCalledTimes(1));
    mocks.fetchMessages.mockClear();
    mocks.loadSessionMessages.mockClear();

    await fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    const [, request] = mocks.apiFetch.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({
      sessionId: 'session-1',
      messageId: 'v1',
      model: 'provider-one:model-one',
    });
    expect(screen.queryByText('answer one')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Regenerating response');
    expect(mocks.fetchMessages).not.toHaveBeenCalled();

    terminalRun('regen-run', 'done', 'completed');
    await waitFor(() => expect(mocks.fetchMessages).toHaveBeenCalledTimes(1));
    expect(mocks.loadSessionMessages).toHaveBeenCalledTimes(1);
  });

  it('offers a sourced-note action for assistant responses and binds authoritative provenance', async () => {
    const listener = vi.fn();
    window.addEventListener('kory-notes-save-finding', listener);
    renderEntry();
    await fireEvent.click(screen.getByRole('button', { name: 'Save as note' }));
    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0]![0] as CustomEvent;
    expect(event.detail).toMatchObject({
      title: 'answer zero',
      body: 'answer zero',
      source: {
        sessionId: 'session-1',
        messageId: 'v0',
        role: 'assistant',
        provider: 'provider-zero',
        model: 'model-zero',
      },
    });
    window.removeEventListener('kory-notes-save-finding', listener);
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

  it('forks chat from the response controls at the active variant and sibling variants', async () => {
    mocks.forkSession.mockResolvedValue('session-forked-1');
    mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, data: {} })));
    renderEntry();

    const forkBtn = screen.getByTestId('fork-chat');
    expect(forkBtn).toBeDefined();
    expect(forkBtn.getAttribute('title')).toBe('Fork');
    expect(forkBtn.getAttribute('aria-label')).toBe('Fork');
    expect(forkBtn.textContent?.trim()).toBe('Fork');

    // Click fork on the initially active variant (v0)
    await fireEvent.click(forkBtn);
    expect(mocks.forkSession).toHaveBeenCalledWith('session-1', 'v0');
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Forked into a new chat');

    // Navigate to variant v1 and click fork
    await fireEvent.click(screen.getByRole('button', { name: 'Next response' }));
    await fireEvent.click(forkBtn);
    expect(mocks.forkSession).toHaveBeenCalledWith('session-1', 'v1');
  });

  it.each([
    { type: 'user_message' as const, isStreaming: false },
    { type: 'content' as const, isStreaming: false },
    { type: 'content' as const, isStreaming: true },
  ])(
    'renders consecutive equations directly in $type (streaming=$isStreaming)',
    async ({ type, isStreaming }) => {
      const source = String.raw`$$ T=\sqrt{a^3} $$ $$ T=\sqrt{(0.3870)^3} $$ $$ T=0.24078\text{ years} $$`;
      const { container } = render(FeedEntry, {
        props: {
          entry: { ...entry(), type, text: source, metadata: { sessionId: 'session-1' } },
          isSelected: false,
          isExpanded: false,
          isStreaming,
          onSelect: vi.fn(),
          onToggleGroup: vi.fn(),
          onDelete: mocks.onDelete,
        },
      });
      await waitFor(() =>
        expect(container.querySelectorAll('.markdown-content .katex-display')).toHaveLength(3),
      );
      expect(container.querySelector('.katex-error')).toBeNull();
      expect(
        Array.from(container.querySelectorAll('annotation'), (node) => node.textContent),
      ).toEqual([
        String.raw`T=\sqrt{a^3}`,
        String.raw`T=\sqrt{(0.3870)^3}`,
        String.raw`T=0.24078\text{ years}`,
      ]);
    },
  );
});
