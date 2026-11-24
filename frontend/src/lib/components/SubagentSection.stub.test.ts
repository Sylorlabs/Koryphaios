import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { SubagentTranscript, TranscriptPart } from '@koryphaios/shared';
import ToolActivity from './ToolActivity.svelte';
import type { FeedEntryLocal } from '$lib/types';
import { partsToFeedEntries } from '$lib/stores/transcript-turns';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('$lib/api.svelte', () => ({
  apiFetch: mocks.apiFetch,
  parseJsonResponse: async (res: Response) => res.json(),
}));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/stores/sessions.svelte', () => ({ sessionStore: { activeSessionId: 'chat' } }));

const transcript: SubagentTranscript = {
  name: 'Explore',
  task: 'Find every caller of parseConfig.',
  turns: [
    { role: 'user', text: 'Search the repo.', createdAt: Date.UTC(2026, 0, 1, 10, 50) },
    { role: 'assistant', parts: [{ kind: 'text', text: 'Found **one** caller.', startedAt: 3 }] },
  ],
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubRow(): FeedEntryLocal {
  const parts: TranscriptPart[] = [
    {
      kind: 'tool',
      callId: 'task-1',
      name: 'Task',
      input: { description: 'explore' },
      startedAt: 1,
      endedAt: 2,
      output: 'Done.',
      timeUnknown: true,
      // What the API ships instead of the embedded transcript.
      subagentStub: {
        name: 'Explore',
        model: 'claude-haiku',
        turnCount: 2,
        ref: { messageId: 'm1', path: [0] },
      },
    },
  ];
  return partsToFeedEntries({
    sessionId: 'chat',
    messageId: 'm1',
    parts,
    agentName: 'Kory',
    glowClass: '',
  })[0];
}

describe('SubagentSection lazy transcript', () => {
  it('renders the stub header, fetches the transcript on first expand, and caches it', async () => {
    mocks.apiFetch.mockResolvedValue(jsonResponse({ ok: true, data: { subagent: transcript } }));
    const { container } = render(ToolActivity, { entry: stubRow() });

    const summary = screen.getByRole('button', {
      name: /Sub-agent · Explore · 2 turns · claude-haiku/,
    });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Search the repo.');

    await fireEvent.click(summary);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/messages/chat/subagent/m1?path=0');

    const region = await screen.findByRole('region', { name: 'Explore sub-agent transcript' });
    expect(region.textContent).toContain('Find every caller of parseConfig.');
    expect(region.textContent).toContain('Search the repo.');
    expect(region.querySelector('.markdown-content strong')?.textContent).toBe('one');

    // Collapse and re-open: the fetched transcript is kept, not re-requested.
    await fireEvent.click(summary);
    await fireEvent.click(summary);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('region').textContent).toContain('Search the repo.');
  });

  it('shows a retry path when the transcript cannot be loaded', async () => {
    mocks.apiFetch.mockResolvedValueOnce(jsonResponse({ ok: false, error: 'nope' }, 404));
    render(ToolActivity, { entry: stubRow() });

    await fireEvent.click(screen.getByRole('button', { name: /Sub-agent · Explore/ }));
    await waitFor(() => expect(screen.getByText(/Couldn't load/)).toBeTruthy());

    mocks.apiFetch.mockResolvedValueOnce(
      jsonResponse({ ok: true, data: { subagent: transcript } }),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(screen.getByRole('region').textContent).toContain('Search the repo.'),
    );
  });
});
