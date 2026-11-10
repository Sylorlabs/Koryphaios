import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ activeSessionId: 'tool-completion' }));

vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/api.svelte', () => ({
  apiFetch: vi.fn(),
  parseJsonResponse: vi.fn(),
}));
vi.mock('./sessions.svelte', () => ({
  sessionStore: {
    get activeSessionId() {
      return state.activeSessionId;
    },
    getMessageDisplayBoundary: () => undefined,
    fetchMessages: vi.fn(),
  },
}));
vi.mock('./run-state.svelte', () => ({
  runStateStore: {
    getAgentStatusForSession: vi.fn(() => 'idle'),
    isRunning: vi.fn(() => false),
    isWaiting: vi.fn(() => false),
  },
}));

import { feedStore } from './feed.svelte';
import { agentStore } from './agents.svelte';

const AGENT = 'kory-manager';

function toolCallEntry(callId: string, sessionId: string, name = 'bash') {
  return {
    timestamp: 100,
    type: 'tool_call' as const,
    agentId: AGENT,
    agentName: 'Kory',
    glowClass: '',
    text: '',
    metadata: {
      sessionId,
      toolCall: { id: callId, name, input: { command: 'ls' } },
    },
  };
}

const RESULT = { callId: 'tc1', name: 'bash', output: 'ok', isError: false, durationMs: 12 };

describe('running tool cards clear on completion', () => {
  beforeEach(() => {
    feedStore.clearFeed(feedStore.sessionId);
  });

  it('flips the live running row into its result row in place', () => {
    const sid = 'complete-in-place';
    state.activeSessionId = sid;
    feedStore.activateSessionFeed(sid);
    feedStore.accumulateFeedEntry(feedStore.sessionId, toolCallEntry('tc1', sid));

    const before = feedStore.feed.map((e) => e.id);
    const done = feedStore.completeToolCall(feedStore.sessionId, 'tc1', 'Tool result (12ms): ok', RESULT, 200);

    expect(done).toBe(true);
    expect(feedStore.feed).toHaveLength(1);
    expect(feedStore.feed.map((e) => e.id)).toEqual(before);
    expect(feedStore.feed[0]).toMatchObject({
      type: 'tool_result',
      text: 'Tool result (12ms): ok',
      timestamp: 200,
    });
    // Call context survives so short labels keep working.
    expect(feedStore.feed[0].metadata).toMatchObject({
      toolCall: { id: 'tc1', name: 'bash' },
      toolResult: RESULT,
    });
  });

  it('leaves other running rows alone and reports unknown ids', () => {
    const sid = 'unknown-id';
    state.activeSessionId = sid;
    feedStore.activateSessionFeed(sid);
    feedStore.accumulateFeedEntry(feedStore.sessionId, toolCallEntry('tc-other', sid));

    expect(feedStore.completeToolCall(feedStore.sessionId, 'tc-missing', 'x', RESULT, 200)).toBe(false);
    expect(feedStore.feed).toHaveLength(1);
    expect(feedStore.feed[0].type).toBe('tool_call');
  });

  it('absorbs a duplicate result instead of adding a second row', () => {
    const sid = 'duplicate-absorb';
    state.activeSessionId = sid;
    feedStore.activateSessionFeed(sid);
    feedStore.accumulateFeedEntry(feedStore.sessionId, toolCallEntry('tc1', sid));

    expect(feedStore.completeToolCall(feedStore.sessionId, 'tc1', 'out', RESULT, 200)).toBe(true);
    expect(feedStore.completeToolCall(feedStore.sessionId, 'tc1', 'out', RESULT, 201)).toBe(true);
    expect(feedStore.feed).toHaveLength(1);
    expect(feedStore.feed[0].type).toBe('tool_result');
  });

  it('flips the agent-thread running row too', () => {
    const sid = 'thread-complete';
    state.activeSessionId = sid;
    feedStore.activateSessionFeed(sid);
    agentStore.accumulateAgentThreadEntry(sid, AGENT, toolCallEntry('tc1', sid));

    const done = agentStore.completeAgentThreadEntry(
      sid,
      AGENT,
      'tc1',
      'Tool result (12ms): ok',
      RESULT,
      200,
    );

    expect(done).toBe(true);
    const rows = agentStore.getAgentThreadEntries(sid, AGENT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'tool_result', text: 'Tool result (12ms): ok' });
  });

  it('reports unknown thread ids without adding rows', () => {
    const sid = 'thread-unknown';
    state.activeSessionId = sid;
    feedStore.activateSessionFeed(sid);

    expect(agentStore.completeAgentThreadEntry(sid, AGENT, 'tc-missing', 'x', RESULT, 200)).toBe(
      false,
    );
    expect(agentStore.getAgentThreadEntries(sid, AGENT)).toHaveLength(0);
  });

  it('keeps a failed grep visible instead of hiding it in explored operations', () => {
    const sid = 'failed-inspection';
    state.activeSessionId = sid;
    feedStore.activateSessionFeed(sid);
    feedStore.accumulateFeedEntry(feedStore.sessionId, toolCallEntry('failed-grep', sid, 'grep'));
    feedStore.completeToolCall(feedStore.sessionId, 'failed-grep', 'Missing pattern', {
      callId: 'failed-grep', name: 'grep', output: 'Missing pattern', isError: true,
    }, 200);
    expect(feedStore.groupedFeed).toHaveLength(1);
    expect(feedStore.groupedFeed[0].type).toBe('tool_result');
    expect(feedStore.groupedFeed[0].metadata?.toolResult).toMatchObject({ isError: true });
  });
});
