import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/svelte';
import type { WSMessage } from '@koryphaios/shared';
import type { MessageDisplayBoundary } from '$lib/utils/message-variants';

const state = vi.hoisted(() => ({
  activeSessionId: '',
  contextResponse: undefined as Promise<unknown> | undefined,
  lastUsage: null as Record<string, unknown> | null,
  boundary: undefined as MessageDisplayBoundary | undefined,
}));
vi.mock('./sessions.svelte', () => ({
  sessionStore: {
    get activeSessionId() {
      return state.activeSessionId;
    },
    getMessageDisplayBoundary: () => state.boundary,
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
  apiFetch: vi.fn(async (path: string) => {
    if (path.includes('/context')) {
      return state.contextResponse ?? { ok: true, lastUsage: state.lastUsage, data: [] };
    }
    return { ok: true, data: path.includes('/timetravel') ? { timeline: [] } : [] };
  }),
  parseJsonResponse: async (response: unknown) => response,
}));
vi.mock('./run-state.svelte', () => ({
  runStateStore: {
    states: new Map(),
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
import { agentStore } from './agents.svelte';
import { toolPresentation } from '$lib/utils/tool-presentation';

const toolCall = {
  id: 'call-1',
  name: 'bash',
  input: { command: 'bun run check', workdir: '/workspace' },
};
const toolResult = {
  callId: toolCall.id,
  name: toolCall.name,
  output: 'Checks passed',
  isError: false,
  durationMs: 75,
};
let savedEvents: WSMessage[] = [];

// Simulate the server's durable replay contract: only an enabled subscription
// receives the saved log, and reconnects resume after the supplied cursor.
class TestWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();
  send = vi.fn((data: string) => {
    const request = JSON.parse(data);
    if (request.type !== 'subscribe_session' || request.replayHistory === false) return;
    for (const event of savedEvents) {
      if (event.sessionId !== request.sessionId) continue;
      if (request.epoch === event.epoch && event.sequence! <= (request.sequence ?? 0)) continue;
      this.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ ...event, replayed: true }),
        }),
      );
    }
  });
  open() {
    this.readyState = TestWebSocket.OPEN;
    this.onopen?.();
  }
}

function appendEvent(type: WSMessage['type'], payload: unknown) {
  const sequence = savedEvents.length + 1;
  savedEvents.push({
    type,
    payload,
    sessionId: state.activeSessionId,
    epoch: 1,
    sequence,
    timestamp: sequence * 100,
  });
}

function history() {
  return [
    { id: 'user-1', role: 'user', content: 'Check the project', createdAt: 50 },
    { id: 'answer-1', role: 'assistant', content: 'The checks passed.', createdAt: 500 },
  ];
}

async function connectSocket() {
  wsStore.connect();
  await waitFor(() => expect(wsStore.connection).toBeTruthy());
  return wsStore.connection as unknown as TestWebSocket;
}

function subscriptions(socket: TestWebSocket) {
  return socket.send.mock.calls
    .map(([data]) => JSON.parse(data))
    .filter((request) => request.type === 'subscribe_session');
}

let sessionCounter = 0;
describe('transcript recovery after reload and reconnect', () => {
  beforeEach(() => {
    state.activeSessionId = `transcript-recovery-${++sessionCounter}`;
    state.contextResponse = undefined;
    state.lastUsage = null;
    state.boundary = undefined;
    savedEvents = [];
    appendEvent('stream.thinking', {
      agentId: 'kory-manager',
      thinking: 'Inspect the project first.',
    });
    appendEvent('stream.tool_call', { agentId: 'kory-manager', toolCall });
    appendEvent('stream.tool_result', { agentId: 'kory-manager', toolResult });
    appendEvent('stream.delta', { agentId: 'kory-manager', content: 'The checks passed.' });
    vi.stubGlobal('WebSocket', TestWebSocket);
  });

  afterEach(() => {
    wsStore.disconnect();
    wsStore.unsubscribeFromSession(state.activeSessionId);
    vi.unstubAllGlobals();
  });

  it.each(['before', 'after'])(
    'restores tools and reasoning when HTTP history lands %s replay',
    async (order) => {
      wsStore.activateSessionFeed(state.activeSessionId);
      const socket = await connectSocket();
      if (order === 'before') await wsStore.loadSessionMessages(state.activeSessionId, history());
      // The session loader can subscribe while the socket is still connecting.
      wsStore.subscribeToSession(state.activeSessionId);
      socket.open();
      expect(subscriptions(socket)).toEqual([
        expect.objectContaining({ sessionId: state.activeSessionId }),
      ]);
      expect(subscriptions(socket)[0].replayHistory).not.toBe(false);

      await wsStore.loadSessionMessages(state.activeSessionId, history());
      // A later same-session history refresh must also retain recovered evidence.
      await wsStore.loadSessionMessages(state.activeSessionId, history());
      expect(feedStore.feed.map((entry) => entry.type)).toEqual([
        'user_message',
        'thinking',
        'tool_result',
        'content',
      ]);
      expect(feedStore.feed.find((entry) => entry.type === 'thinking')).toMatchObject({
        text: 'Inspect the project first.',
        thinkingFinalized: true,
      });
      expect(feedStore.feed.find((entry) => entry.type === 'tool_result')).toMatchObject({
        metadata: { toolCall, toolResult },
      });
      expect(
        agentStore
          .getAgentThreadEntries(state.activeSessionId, 'kory-manager')
          .map((entry) => entry.type),
      ).toEqual(['thinking', 'tool_result', 'content']);
    },
  );

  it('defers startup replay until the active feed has been activated', async () => {
    feedStore.activateSessionFeed('');
    const socket = await connectSocket();
    socket.open();
    expect(subscriptions(socket)).toEqual([]);

    wsStore.activateSessionFeed(state.activeSessionId);
    wsStore.subscribeToSession(state.activeSessionId);
    await wsStore.loadSessionMessages(state.activeSessionId, history());
    expect(feedStore.feed.map((entry) => entry.type)).toEqual([
      'user_message',
      'thinking',
      'tool_result',
      'content',
    ]);
  });

  it('resumes from the applied cursor and recovers tools and errors missed during a disconnect', async () => {
    wsStore.activateSessionFeed(state.activeSessionId);
    const first = await connectSocket();
    first.open();
    await wsStore.loadSessionMessages(state.activeSessionId, history());
    first.readyState = 3;
    first.onclose?.({ code: 1006, reason: 'connection lost' });

    const pendingCall = { id: 'call-2', name: 'read_file', input: { path: 'src/app.ts' } };
    appendEvent('stream.tool_call', { agentId: 'kory-manager', toolCall: pendingCall });
    appendEvent('system.error', { error: 'Provider connection interrupted.' });
    const second = await connectSocket();
    second.open();
    expect(subscriptions(second)[0]).toMatchObject({ epoch: 1, sequence: 4 });
    expect(subscriptions(second)[0].replayHistory).not.toBe(false);
    await wsStore.loadSessionMessages(state.activeSessionId, history());

    expect(feedStore.feed.filter((entry) => entry.type === 'thinking')).toHaveLength(1);
    expect(feedStore.feed.filter((entry) => entry.type === 'tool_result')).toHaveLength(1);
    expect(feedStore.feed.find((entry) => entry.type === 'tool_call')).toMatchObject({
      metadata: { toolCall: pendingCall },
    });
    expect(feedStore.feed.find((entry) => entry.type === 'error')?.text).toBe(
      'Provider connection interrupted.',
    );
  });

  it('preserves known context when a history refresh has no persisted usage yet', async () => {
    wsStore.activateSessionFeed(state.activeSessionId);
    wsStore.beginManagerContextPreview(state.activeSessionId, 'openai', 'model-1', 200_000);
    agentStore.seedManagerUsage(state.activeSessionId, {
      used: 80_000,
      max: 200_000,
      contextKnown: true,
      provider: 'openai',
      model: 'model-1',
    });
    await wsStore.loadSessionMessages(state.activeSessionId, history());
    expect(agentStore.getContextUsage()).toMatchObject({
      used: 80_000,
      max: 200_000,
      isReliable: true,
    });
  });

  it('restores registered MCP identities with archived tool history', async () => {
    wsStore.activateSessionFeed(state.activeSessionId);
    state.contextResponse = Promise.resolve({
      ok: true, lastUsage: null,
      mcpServers: [{ name: 'Research_team', tools: ['lookup_topic'] }],
      data: [{ id: 'registry-tool', ts: 300, label: 'mcp_Research_team_lookup_topic', content: 'found' }],
    });
    await wsStore.loadSessionMessages(state.activeSessionId, history());
    const archived = feedStore.feed.find((entry) => entry.id === 'arch-registry-tool');
    expect(archived).toBeDefined();
    expect(toolPresentation(archived!)).toMatchObject({ mcpIdentity: 'Research_team MCP · lookup_topic' });
  });

  it.each(['before', 'after'])(
    'retains Antigravity usage replayed %s history while the composer is starting', async (order) => {
      wsStore.activateSessionFeed(state.activeSessionId);
      wsStore.clearManagerContextPreview(state.activeSessionId);
      appendEvent('stream.usage', {
        agentId: 'kory-manager', provider: 'antigravity', model: 'gemini-3-1-pro',
        tokensIn: 88_000, tokensOut: 1_000, tokensUsed: 89_000,
        usageKnown: true, estimated: true, contextKnown: true, contextWindow: 1_048_576,
      });
      const socket = await connectSocket();
      if (order === 'before') await wsStore.loadSessionMessages(state.activeSessionId, history());
      wsStore.subscribeToSession(state.activeSessionId);
      socket.open();
      await wsStore.loadSessionMessages(state.activeSessionId, history());
      expect(agentStore.getContextUsage().isReliable).toBe(false);
      wsStore.beginManagerContextPreview(state.activeSessionId, 'antigravity', 'gemini-3-1-pro', 1_048_576);
      expect(agentStore.getContextUsage()).toMatchObject({ used: 89_000, max: 1_048_576, estimated: true });
    },
  );

  it('keeps foreground context bound while another chat streams and finishes in the background', async () => {
    wsStore.activateSessionFeed(state.activeSessionId);
    wsStore.beginManagerContextPreview(state.activeSessionId, 'openai', 'model-1', 200_000);
    agentStore.seedManagerUsage(state.activeSessionId, {
      used: 80_000,
      max: 200_000,
      contextKnown: true,
      provider: 'openai',
      model: 'model-1',
    });
    const socket = await connectSocket();
    const events: Array<[WSMessage['type'], unknown]> = [
      ['stream.thinking', { agentId: 'kory-manager', thinking: 'Background reasoning.' }],
      ['stream.delta', { agentId: 'kory-manager', content: 'Background answer.' }],
      ['stream.tool_call', { agentId: 'kory-manager', toolCall }],
      ['agent.status', { agentId: 'kory-manager', status: 'streaming' }],
      ['stream.clear_content', { agentId: 'kory-manager' }],
      ['stream.complete', { agentId: 'kory-manager' }],
    ];
    for (const [index, [type, payload]] of events.entries()) {
      socket.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type,
            payload,
            sessionId: `${state.activeSessionId}-background`,
            epoch: 1,
            sequence: index + 1,
            timestamp: 100,
            replayed: true,
          }),
        }),
      );
      expect(agentStore.getAgent(state.activeSessionId, 'kory-manager')?.sessionId).toBe(state.activeSessionId);
      expect(agentStore.getContextUsage()).toMatchObject({
        used: 80_000,
        max: 200_000,
        isReliable: true,
      });
    }
  });

  it('does not let an older archive snapshot replace a live context update during history loading', async () => {
    wsStore.activateSessionFeed(state.activeSessionId);
    wsStore.beginManagerContextPreview(state.activeSessionId, 'openai', 'model-1', 200_000);
    let resolveContext!: (response: unknown) => void;
    state.contextResponse = new Promise((resolve) => {
      resolveContext = resolve;
    });
    const loading = wsStore.loadSessionMessages(state.activeSessionId, history());
    await waitFor(() =>
      expect(feedStore.feed.some((entry) => entry.id === 'hist-answer-1')).toBe(true),
    );
    agentStore.updateUsage(
      state.activeSessionId,
      'kory-manager',
      {
        agentId: 'kory-manager',
        provider: 'openai',
        model: 'model-1',
        tokensIn: 89_000,
        tokensOut: 1_000,
        tokensUsed: 90_000,
        usageKnown: true,
        contextKnown: true,
        contextWindow: 200_000,
      },
    );
    resolveContext({
      ok: true,
      data: [],
      lastUsage: {
        used: 20_000,
        max: 200_000,
        contextKnown: true,
        provider: 'openai',
        model: 'model-1',
      },
    });
    await loading;
    expect(agentStore.getContextUsage()).toMatchObject({
      used: 90_000,
      max: 200_000,
      isReliable: true,
    });
  });

  it('restores saved startup context as soon as the exact model selection is pinned', async () => {
    wsStore.activateSessionFeed(state.activeSessionId);
    wsStore.clearManagerContextPreview(state.activeSessionId);
    state.lastUsage = {
      used: 70_000,
      max: 200_000,
      contextKnown: true,
      provider: 'openai',
      model: 'model-1',
    };
    await wsStore.loadSessionMessages(state.activeSessionId, history());
    expect(agentStore.getContextUsage().isReliable).toBe(false);
    wsStore.beginManagerContextPreview(state.activeSessionId, 'openai', 'model-1', undefined);
    expect(agentStore.getContextUsage()).toMatchObject({
      used: 70_000,
      max: 200_000,
      isReliable: true,
    });
  });

  it('does not restore a startup snapshot for a different selected provider', async () => {
    wsStore.activateSessionFeed(state.activeSessionId);
    wsStore.clearManagerContextPreview(state.activeSessionId);
    state.lastUsage = {
      used: 70_000,
      max: 200_000,
      contextKnown: true,
      provider: 'openai',
      model: 'model-1',
    };
    await wsStore.loadSessionMessages(state.activeSessionId, history());
    wsStore.beginManagerContextPreview(state.activeSessionId, 'anthropic', 'model-2', 100_000);
    expect(agentStore.getContextUsage()).toMatchObject({
      used: 0,
      max: 100_000,
      isReliable: false,
      provider: 'anthropic',
    });
  });

  it('invalidates old occupancy when authoritative history proves the branch changed', async () => {
    wsStore.activateSessionFeed(state.activeSessionId);
    wsStore.beginManagerContextPreview(state.activeSessionId, 'openai', 'model-1', 200_000);
    state.boundary = {
      activeMessageId: 'answer-1',
      conversationRevision: 2,
      providerConversationRevision: 0,
      authoritative: true,
    };
    await wsStore.loadSessionMessages(state.activeSessionId, history());
    agentStore.seedManagerUsage(state.activeSessionId, {
      used: 80_000,
      max: 200_000,
      contextKnown: true,
      provider: 'openai',
      model: 'model-1',
    });
    state.boundary = { ...state.boundary, providerConversationRevision: 1 };
    await wsStore.loadSessionMessages(state.activeSessionId, history());
    expect(agentStore.getContextUsage()).toMatchObject({
      used: 0,
      max: 200_000,
      isReliable: false,
    });
  });
});
