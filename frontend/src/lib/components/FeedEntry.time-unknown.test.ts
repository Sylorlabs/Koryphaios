import { render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { FeedEntryLocal } from '$lib/types';

vi.mock('$lib/api.svelte', () => ({
  apiFetch: vi.fn(),
  parseJsonResponse: async (response: Response) => response.json(),
}));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/stores/sessions.svelte', () => ({
  sessionStore: { activeSessionId: 'session-1', sessions: [], fetchMessages: vi.fn() },
}));
vi.mock('$lib/stores/websocket.svelte', () => ({
  wsStore: {
    loadSessionMessages: vi.fn(),
    setEntryVisibility: vi.fn(),
    rewind: vi.fn(),
    rewindPreviewLoadingHash: '',
  },
}));
vi.mock('$lib/stores/project.svelte', () => ({ projectStore: { currentPath: '/tmp/project' } }));
vi.mock('$lib/stores/auth.svelte', () => ({ authStore: { token: undefined } }));
vi.mock('$lib/stores/agent-settings.svelte', () => ({
  agentSettingsStore: { settings: { reasoningExpandedByDefault: false } },
}));
vi.mock('$lib/stores/toast.svelte', () => ({
  toastStore: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import FeedEntry from './FeedEntry.svelte';
import { parseMessageDisplayProjection } from '$lib/utils/message-variants';
import { partsToFeedEntries } from '$lib/stores/transcript-turns';

const CREATED_AT = new Date(2026, 0, 1, 22, 50).getTime();
const CLOCK = new Date(CREATED_AT).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function entry(overrides: Partial<FeedEntryLocal>): FeedEntryLocal {
  return {
    id: 'row-1',
    timestamp: CREATED_AT,
    type: 'user_message',
    agentId: 'user',
    agentName: 'You',
    glowClass: '',
    text: 'Imported question',
    metadata: {},
    ...overrides,
  };
}

function renderEntry(value: FeedEntryLocal) {
  return render(FeedEntry, {
    props: {
      entry: value,
      isSelected: false,
      isExpanded: false,
      onSelect: vi.fn(),
      onToggleGroup: vi.fn(),
      onDelete: vi.fn(),
    },
  });
}

describe('FeedEntry message time', () => {
  it('shows the clock time for a row with a recorded time', () => {
    const { container } = renderEntry(entry({}));
    expect(container.textContent).toContain(CLOCK);
    expect(container.textContent).not.toContain('Time unknown');
  });

  it('shows "Time unknown" instead of a clock time when the source recorded none', () => {
    const { container } = renderEntry(entry({ timeUnknown: true }));
    expect(container.textContent).toContain('Time unknown');
    expect(container.textContent).not.toContain(CLOCK);
  });

  it('carries timeUnknown from the messages API through the parts expansion', () => {
    const { messages } = parseMessageDisplayProjection(
      JSON.parse(
        JSON.stringify([
          { id: 'u1', role: 'user', content: 'q', createdAt: CREATED_AT, timeUnknown: true },
          {
            id: 'a1',
            role: 'assistant',
            content: 'answer',
            createdAt: CREATED_AT,
            timeUnknown: true,
            parts: [{ kind: 'text', text: 'answer', startedAt: CREATED_AT }],
          },
          { id: 'a2', role: 'assistant', content: 'dated', createdAt: CREATED_AT },
        ]),
      ),
    );
    expect(messages.map((message) => message.timeUnknown)).toEqual([true, true, undefined]);

    const [row] = partsToFeedEntries({
      sessionId: 's',
      messageId: messages[1].id,
      parts: messages[1].parts!,
      agentName: 'Kory',
      glowClass: '',
      timeUnknown: messages[1].timeUnknown === true,
    });
    expect(row.timeUnknown).toBe(true);
    const { container } = renderEntry(row);
    expect(container.textContent).toContain('Time unknown');
    expect(container.textContent).not.toContain(CLOCK);
  });
});
