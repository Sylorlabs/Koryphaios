import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/svelte';
import type { WSMessage } from '@koryphaios/shared';
import { NOTE_TOOL_NAMES } from '@koryphaios/shared';

const state = vi.hoisted(() => ({ activeSessionId: '' }));
vi.mock('./sessions.svelte', () => ({
  sessionStore: {
    get activeSessionId() {
      return state.activeSessionId;
    },
    getMessageDisplayBoundary: () => undefined,
  },
}));
vi.mock('./auth.svelte', () => ({
  authStore: { ensureSession: async () => true, token: 'test-token' },
}));
vi.mock('$lib/utils/api-url', () => ({
  apiUrl: (path: string) => path,
  getWsUrl: () => 'ws://localhost/ws',
}));
vi.mock('$lib/api.svelte', () => ({ apiFetch: vi.fn(), parseJsonResponse: vi.fn() }));
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
import { agentStore } from './agents.svelte';

class TestWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();
  send = vi.fn();
}

let sessionCounter = 0;
const command =
  'bun run verify --filter frontend && bun run verify --filter backend --reporter verbose';
const toolCall = { id: 'call-1', name: 'bash', input: { command, workdir: '/workspace/app' } };
const toolResult = {
  callId: 'call-1',
  name: 'bash',
  output: 'All checks passed',
  isError: false,
  durationMs: 120,
  archiveId: 'cx_1',
};

function receive(
  type: WSMessage['type'],
  payload: unknown,
  sequence: number,
  sessionId = state.activeSessionId,
) {
  wsStore.connection!.onmessage!(
    new MessageEvent('message', {
      data: JSON.stringify({
        type, payload, sessionId, timestamp: sequence * 100, epoch: 1, sequence,
      }),
    }),
  );
}

describe('realtime command completion', () => {
  beforeEach(async () => {
    state.activeSessionId = `command-${++sessionCounter}`;
    feedStore.activateSessionFeed(state.activeSessionId);
    vi.stubGlobal('WebSocket', TestWebSocket);
    wsStore.connect();
    await waitFor(() => expect(wsStore.connection).toBeTruthy());
  });

  afterEach(() => {
    wsStore.disconnect();
    vi.unstubAllGlobals();
  });

  it('updates one row through streamed input and completion in the chat and agent thread', () => {
    receive('stream.tool_call', { agentId: 'kory-manager', toolCall: { ...toolCall, input: {} } }, 1);
    const feedId = feedStore.feed[0].id;
    const threadId = agentStore.getAgentThreadEntries(state.activeSessionId, 'kory-manager')[0].id;
    receive('stream.tool_call', { agentId: 'kory-manager', toolCall }, 2);
    receive('stream.tool_result', { agentId: 'kory-manager', toolResult }, 3);
    receive('stream.tool_result', { agentId: 'kory-manager', toolResult }, 4);

    expect(feedStore.feed).toHaveLength(1);
    expect(feedStore.feed[0]).toMatchObject({
      id: feedId,
      type: 'tool_result',
      metadata: { toolCall, toolResult, sequenceStart: 1, sequenceEnd: 3 },
    });
    const thread = agentStore.getAgentThreadEntries(state.activeSessionId, 'kory-manager');
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({
      id: threadId,
      type: 'tool_result',
      metadata: { toolCall, toolResult },
    });
  });

  it('keeps a Critic spawn in the rail while using one persistent evaluation link', () => {
    receive('agent.spawned', {
      agent: {
        id: 'critic-1', name: 'Critic', role: 'critic', domain: 'critic',
        provider: 'anthropic', model: 'claude-test', glowColor: 'var(--color-accent)',
      },
      task: 'Review the delegated work',
    }, 1);

    expect(agentStore.getAgent(state.activeSessionId, 'critic-1')).toMatchObject({
      identity: { id: 'critic-1', role: 'critic', name: 'Critic' },
      status: 'thinking',
    });
    expect(feedStore.feed).toHaveLength(0);

    receive('stream.tool_call', {
      agentId: 'kory-manager',
      toolCall: { id: 'review-critic-1', name: 'critic_review', input: { agentId: 'critic-1' } },
    }, 2);

    expect(feedStore.feed).toHaveLength(1);
    expect(feedStore.feed[0]).toMatchObject({
      type: 'tool_call',
      metadata: { toolCall: { name: 'critic_review', input: { agentId: 'critic-1' } } },
    });
  });

  it('completes a command in its own cached chat after switching away', () => {
    const sessionId = state.activeSessionId;
    receive('stream.tool_call', { agentId: 'kory-manager', toolCall }, 1);
    const id = feedStore.feed[0].id;
    state.activeSessionId = `${sessionId}-other`;
    feedStore.activateSessionFeed(state.activeSessionId);
    receive('stream.tool_result', { agentId: 'kory-manager', toolResult }, 2, sessionId);
    expect(feedStore.feed).toHaveLength(0);

    state.activeSessionId = sessionId;
    feedStore.activateSessionFeed(sessionId);
    expect(feedStore.feed).toHaveLength(1);
    expect(feedStore.feed[0]).toMatchObject({
      id,
      type: 'tool_result',
      metadata: { toolCall, toolResult },
    });
  });

  it('still shows a result when no matching start was received', () => {
    receive('stream.tool_result', { agentId: 'kory-manager', toolResult }, 1);
    expect(feedStore.feed).toHaveLength(1);
    expect(feedStore.feed[0]).toMatchObject({ type: 'tool_result', metadata: { toolResult } });
  });

  it.each([...NOTE_TOOL_NAMES, 'read_file', 'write_file', 'apply_patch', 'grep', 'web_fetch', 'create_checklist'])
  ('updates %s in place and absorbs late start events', (name) => {
    const call = { id: 'tool-1', name, input: { title: 'Research', noteId: 'n1' } };
    const result = { ...toolResult, callId: call.id, name };
    receive('stream.tool_call', { agentId: 'kory-manager', toolCall: { ...call, input: {} } }, 1);
    const id = feedStore.feed[0].id;
    receive('stream.tool_call', { agentId: 'kory-manager', toolCall: call }, 2);
    receive('stream.tool_result', { agentId: 'kory-manager', toolResult: result }, 3);
    receive('stream.tool_call', { agentId: 'kory-manager', toolCall: { ...call, input: {} } }, 4);
    receive('stream.tool_call', { agentId: 'kory-manager', toolCall: call }, 5);

    expect(feedStore.feed).toHaveLength(1);
    expect(feedStore.feed[0]).toMatchObject({ id, type: 'tool_result', timestamp: 300, metadata: { toolCall: call, toolResult: result } });
    const thread = agentStore.getAgentThreadEntries(state.activeSessionId, 'kory-manager');
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ type: 'tool_result', timestamp: 300, metadata: { toolCall: call, toolResult: result } });
    expect(feedStore.groupedFeed).toHaveLength(1);
    if (name === 'search_notes' || name === 'recall_notes') {
      expect(feedStore.groupedFeed[0].type).toBe('tool_result');
    }
  });

  it('keeps two agents using the same provider call ID independent', () => {
    const call = { id: 'shared-id', name: 'read_note', input: { title: 'Research' } };
    const result = { ...toolResult, callId: call.id, name: call.name };
    receive('stream.tool_call', { agentId: 'worker-a', toolCall: call }, 1);
    receive('stream.tool_call', { agentId: 'worker-b', toolCall: { ...call, input: { title: 'Findings' } } }, 2);
    receive('stream.tool_result', { agentId: 'worker-a', toolResult: result }, 3);
    expect(feedStore.feed).toHaveLength(2);
    expect(feedStore.feed[0]).toMatchObject({ agentId: 'worker-a', type: 'tool_result' });
    expect(feedStore.feed[1]).toMatchObject({ agentId: 'worker-b', type: 'tool_call', metadata: { toolCall: { input: { title: 'Findings' } } } });
    receive('stream.tool_result', { agentId: 'worker-b', toolResult: result }, 4);
    expect(feedStore.feed.map((row) => row.type)).toEqual(['tool_result', 'tool_result']);
  });

  it('attaches late input to an already completed result without adding a running row', () => {
    receive('stream.tool_result', { agentId: 'kory-manager', toolResult }, 1);
    const id = feedStore.feed[0].id;
    receive('stream.tool_call', { agentId: 'kory-manager', toolCall }, 2);
    expect(feedStore.feed).toHaveLength(1);
    expect(feedStore.feed[0]).toMatchObject({ id, type: 'tool_result', timestamp: 100, metadata: { toolCall, toolResult } });
    expect(agentStore.getAgentThreadEntries(state.activeSessionId, 'kory-manager')).toHaveLength(1);
  });
});
