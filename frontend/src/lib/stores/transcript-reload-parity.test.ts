// Reload parity (docs/architecture/transcript-integrity.md, enforcement list).
// One recorded manager turn is applied live through the real websocket handler,
// then the same events are folded by the shared reducer into persisted parts,
// served back as the assistant message, and reloaded. The rows must match.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/svelte';
import type { FeedEntry } from '$lib/types';
import type { TranscriptPart, WSMessage } from '@koryphaios/shared';
import { reduceTurnEvents, turnEventFromWSMessage } from '@koryphaios/shared';
import { parseMessageDisplayProjection, type DisplayMessage } from '$lib/utils/message-variants';

const state = vi.hoisted(() => ({
  activeSessionId: '',
  apiFetch: vi.fn(),
  fetchMessages: vi.fn(),
}));

vi.mock('./sessions.svelte', () => ({
  sessionStore: {
    get activeSessionId() {
      return state.activeSessionId;
    },
    getMessageDisplayBoundary: () => undefined,
    getMessagePageInfo: () => undefined,
    fetchMessages: (...args: unknown[]) => state.fetchMessages(...args),
  },
}));
vi.mock('./auth.svelte', () => ({
  authStore: { ensureSession: async () => true, token: 'test-token' },
}));
vi.mock('$lib/utils/api-url', () => ({
  apiUrl: (path: string) => path,
  getWsUrl: () => 'ws://localhost/ws',
}));
vi.mock('$lib/api.svelte', () => ({
  apiFetch: (path: string, init?: RequestInit) => state.apiFetch(path, init),
  parseJsonResponse: async (response: Response) => response.json(),
}));
vi.mock('./run-state.svelte', () => ({
  runStateStore: {
    applyEvent: () => true,
    getAgentStatusForSession: () => 'idle',
    isRunning: () => false,
    isWaiting: () => false,
    isBusy: () => false,
  },
}));
vi.mock('./providers.svelte', () => ({ providersStore: {}, loadProvidersFromApi: vi.fn() }));
vi.mock('./notes.svelte', () => ({ notesStore: {} }));
vi.mock('./goals.svelte', () => ({ goalStore: {} }));
vi.mock('./checklists.svelte', () => ({ checklistStore: {} }));

import { wsStore } from './websocket.svelte';
import { feedStore } from './feed.svelte';

class TestWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();
  send = vi.fn();
}

const TURN = 'turn-1';
const command = { id: 'call-1', name: 'read_file', input: { path: 'a.ts' } };
const commandResult = {
  callId: 'call-1',
  name: 'read_file',
  output: 'export {}',
  isError: false,
  durationMs: 30,
};
const STREAMED_TEXT = 'Done. Changed a.ts.';

/** The recorded manager event stream for one turn, in emission order. */
function turnEvents(sessionId: string): WSMessage[] {
  const at = (sequence: number, type: WSMessage['type'], payload: Record<string, unknown>) =>
    ({
      type,
      payload: { agentId: 'kory-manager', messageId: TURN, ...payload },
      sessionId,
      timestamp: sequence * 100,
      epoch: 1,
      sequence,
    }) as WSMessage;
  return [
    at(1, 'stream.thinking', { thinking: 'Plan the change. ' }),
    at(2, 'stream.thinking', { thinking: 'Read the file first.' }),
    at(3, 'stream.tool_call', { toolCall: command }),
    at(4, 'stream.tool_result', { toolResult: commandResult }),
    at(5, 'stream.thinking', { thinking: 'Now answer.' }),
    at(6, 'stream.delta', { content: 'Done. ' }),
    at(7, 'stream.delta', { content: 'Changed a.ts.' }),
    at(8, 'stream.complete', {}),
  ];
}

/** Persisted parts: the shared reducer folded over exactly the emitted events. */
function persistedParts(events: readonly WSMessage[]): TranscriptPart[] {
  return reduceTurnEvents(
    events.map((event) => turnEventFromWSMessage(event)).filter((event) => event !== null),
  );
}

/** The fields a reader sees. Message-level metadata (variants, cost) rides on the
 *  persisted text row by design and is not part of the rendering comparison. */
function rendered(rows: readonly FeedEntry[]) {
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    agentId: row.agentId,
    timestamp: row.timestamp,
    text: row.text,
    thinkingStartedAt: row.thinkingStartedAt,
    durationMs: row.durationMs,
    thinkingFinalized: row.thinkingFinalized,
    toolCall: row.metadata?.toolCall,
    toolResult: row.metadata?.toolResult,
  }));
}

function serverMessages(parts: TranscriptPart[], content: string): DisplayMessage[] {
  const payload = [
    { id: 'user-1', role: 'user', content: 'Refactor a.ts', createdAt: 50 },
    { id: TURN, role: 'assistant', content, createdAt: 400, parts },
  ];
  // Round-trip through JSON, as the messages API does, before parsing.
  return parseMessageDisplayProjection(JSON.parse(JSON.stringify(payload))).messages;
}

function receive(message: WSMessage) {
  wsStore.connection!.onmessage!(
    new MessageEvent('message', { data: JSON.stringify(message) }),
  );
}

function ancillary(path: string): Response {
  if (path.includes('/timetravel')) {
    return new Response(JSON.stringify({ ok: true, data: { timeline: [] } }));
  }
  return new Response(JSON.stringify({ ok: true, lastUsage: null, data: [] }));
}

let sessionCounter = 0;

describe('transcript reload parity', () => {
  let sessionId = '';

  beforeEach(async () => {
    sessionId = `parity-${++sessionCounter}`;
    state.activeSessionId = sessionId;
    state.apiFetch.mockReset();
    state.apiFetch.mockImplementation((path: string) => Promise.resolve(ancillary(path)));
    state.fetchMessages.mockReset();
    vi.stubGlobal('WebSocket', TestWebSocket);
    wsStore.connect();
    await waitFor(() => expect(wsStore.connection).toBeTruthy());
    feedStore.activateSessionFeed(sessionId);
  });

  afterEach(() => {
    wsStore.disconnect();
    vi.unstubAllGlobals();
  });

  function liveTurnRows(): FeedEntry[] {
    return feedStore.feed.filter((row) => row.metadata?.turnMessageId === TURN);
  }

  it('reloads the same rows, in order and text, that the live stream produced', async () => {
    const userRowId = feedStore.addUserMessage(sessionId, 'Refactor a.ts');
    feedStore.bindMessageIdentity(sessionId, userRowId!, 'user-1');
    const events = turnEvents(sessionId);
    events.forEach((event) => receive(event));

    const live = rendered(liveTurnRows());
    expect(live.map((row) => [row.id, row.type])).toEqual([
      ['turn-turn-1-0', 'thinking'],
      ['turn-turn-1-1', 'tool_result'],
      ['turn-turn-1-2', 'thinking'],
      ['turn-turn-1-3', 'content'],
    ]);
    expect(live[3].text).toBe(STREAMED_TEXT);

    state.fetchMessages.mockImplementation(async () =>
      serverMessages(persistedParts(events), STREAMED_TEXT),
    );
    const messages = await state.fetchMessages(sessionId);
    expect(await feedStore.loadSessionMessages(sessionId, messages)).toBe(true);

    const reloaded = feedStore.feed.filter((row) => row.metadata?.turnMessageId === TURN);
    expect(rendered(reloaded)).toEqual(live);
    // Live user row is replaced by its persisted row; the assistant turn is not duplicated.
    expect(feedStore.feed.map((row) => row.type)).toEqual([
      'user_message',
      'thinking',
      'tool_result',
      'thinking',
      'content',
    ]);
  });

  it('keeps the rendered (grouped) feed in step with in-place streaming patches', () => {
    // Events 6 and 7 both extend the answer row; 7 takes the in-place fast path.
    turnEvents(sessionId).forEach((event) => receive(event));
    const grouped = feedStore.groupedFeed.filter(
      (row) => row.metadata?.turnMessageId === TURN && row.type === 'content',
    );
    expect(grouped).toHaveLength(1);
    expect(grouped[0].text).toBe(STREAMED_TEXT);
    expect(feedStore.groupedFeed.map((row) => row.id)).toContain('turn-turn-1-0');
  });

  it('does not duplicate streamed text when the same events are replayed (reconnect)', () => {
    const events = turnEvents(sessionId);
    events.forEach((event) => receive(event));
    const before = rendered(liveTurnRows());
    events.forEach((event) => receive({ ...event, replayed: true }));

    expect(rendered(liveTurnRows())).toEqual(before);
    const answer = feedStore.feed.filter((row) => row.type === 'content');
    expect(answer).toHaveLength(1);
    expect(answer[0].text).toBe(STREAMED_TEXT);
  });

  it('shows a background chat turn when that chat is opened mid-turn', async () => {
    const background = `${sessionId}-background`;
    // The reader stays on `sessionId` while the other chat streams.
    const events = turnEvents(background);
    events.slice(0, 5).forEach((event) => receive(event));
    expect(feedStore.feed.some((row) => row.metadata?.sessionId === background)).toBe(false);

    state.activeSessionId = background;
    feedStore.activateSessionFeed(background);
    expect(await feedStore.loadSessionMessages(background, [
      { id: 'user-1', role: 'user', content: 'Refactor a.ts', createdAt: 50 },
    ])).toBe(true);

    expect(feedStore.feed.map((row) => [row.type, row.text])).toEqual([
      ['user_message', 'Refactor a.ts'],
      ['thinking', 'Plan the change. Read the file first.'],
      ['tool_result', 'Tool result (30ms): export {}'],
      ['thinking', 'Now answer.'],
    ]);
  });

  it('shows the persisted text when the response was withheld or deferred', async () => {
    const events = turnEvents(sessionId);
    events.forEach((event) => receive(event));
    expect(liveTurnRows().at(-1)?.text).toBe(STREAMED_TEXT);

    const persisted = persistedParts(events).map((part) =>
      part.kind === 'text' ? { ...part, text: 'Refactor complete.' } : part,
    );
    const messages = serverMessages(persisted, 'Refactor complete.');
    expect(await feedStore.loadSessionMessages(sessionId, messages)).toBe(true);

    const answer = feedStore.feed.filter((row) => row.type === 'content');
    expect(answer.map((row) => row.text)).toEqual(['Refactor complete.']);
    expect(feedStore.feed.some((row) => row.text === STREAMED_TEXT)).toBe(false);
  });
});
