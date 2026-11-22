import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ activeSessionId: 'turn-continuation' }));

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

import { feedStore, getGroupedEntries } from './feed.svelte';
import { agentStore } from './agents.svelte';

const AGENT = 'kory-manager';
const SID = 'turn-continuation';

function content(text: string, timestamp: number, agentId = AGENT) {
  return {
    timestamp,
    type: 'content' as const,
    agentId,
    agentName: 'Kory',
    glowClass: '',
    text,
    metadata: { sessionId: SID },
  };
}

function managerEvent(type: string, payload: Record<string, unknown>, timestamp: number) {
  return {
    type,
    payload: { ...payload, messageId: 'turn-1' },
    timestamp,
    sessionId: SID,
  } as unknown as Parameters<typeof feedStore.applyManagerTurnEvent>[1];
}

function skill(name: string, timestamp: number) {
  return {
    timestamp,
    type: 'skill' as const,
    agentId: AGENT,
    agentName: 'Kory',
    glowClass: '',
    text: name,
    metadata: { sessionId: SID, skillName: name },
  };
}

function toolCall(callId: string, name: string, timestamp: number) {
  return {
    timestamp,
    type: 'tool_call' as const,
    agentId: AGENT,
    agentName: 'Kory',
    glowClass: '',
    text: `Calling tool: ${name}`,
    metadata: { sessionId: SID, toolCall: { id: callId, name, input: {} } },
  };
}

describe('one turn renders as one answer', () => {
  beforeEach(() => {
    state.activeSessionId = SID;
    feedStore.clearFeed(feedStore.sessionId);
    feedStore.activateSessionFeed(SID);
  });

  it('keeps text on one row when a tool call lands mid-sentence', () => {
    feedStore.accumulateFeedEntry(feedStore.sessionId, content('Launching Codex — checking its ', 100));
    feedStore.addFeedEntryForSession(feedStore.sessionId, toolCall('tc1', 'read_file', 110));
    feedStore.accumulateFeedEntry(feedStore.sessionId, content('layout and start command.', 120));

    const rows = feedStore.feed;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      type: 'content',
      text: 'Launching Codex — checking its layout and start command.',
    });
    expect(rows[1].type).toBe('tool_call');
  });

  it('starts a new reasoning row after tool activity', () => {
    feedStore.accumulateFeedEntry(feedStore.sessionId, {
      timestamp: 100,
      type: 'thinking',
      agentId: AGENT,
      agentName: 'Kory',
      glowClass: '',
      text: 'first ',
      thinkingStartedAt: 100,
      metadata: { sessionId: SID },
    });
    feedStore.addFeedEntryForSession(feedStore.sessionId, toolCall('tc1', 'grep', 110));
    feedStore.accumulateFeedEntry(feedStore.sessionId, {
      timestamp: 120,
      type: 'thinking',
      agentId: AGENT,
      agentName: 'Kory',
      glowClass: '',
      text: 'second',
      thinkingStartedAt: 100,
      metadata: { sessionId: SID },
    });

    const thinking = feedStore.feed.filter((entry) => entry.type === 'thinking');
    expect(thinking).toHaveLength(2);
    expect(thinking.map((entry) => entry.text)).toEqual(['first ', 'second']);
    expect(feedStore.feed.map((entry) => entry.type)).toEqual([
      'thinking',
      'tool_call',
      'thinking',
    ]);
  });

  it('starts a new row for the next user turn', () => {
    feedStore.addUserMessage(SID, 'launch codex for me');
    feedStore.accumulateFeedEntry(feedStore.sessionId, content('Checking its layout.', 100));
    feedStore.addUserMessage(SID, 'and now something else');
    feedStore.accumulateFeedEntry(feedStore.sessionId, content('On it.', 200));

    const content1 = feedStore.feed.filter((entry) => entry.type === 'content');
    expect(content1).toHaveLength(2);
    expect(content1.map((entry) => entry.text)).toEqual(['Checking its layout.', 'On it.']);
  });

  it('does not merge another agent into the same row', () => {
    feedStore.accumulateFeedEntry(feedStore.sessionId, content('Manager text', 100));
    feedStore.accumulateFeedEntry(feedStore.sessionId, content('Worker text', 110, 'worker-1'));
    feedStore.accumulateFeedEntry(feedStore.sessionId, content(' more manager', 120));

    const content1 = feedStore.feed.filter((entry) => entry.type === 'content');
    expect(content1).toHaveLength(2);
    expect(content1[0].text).toBe('Manager text more manager');
    expect(content1[1].text).toBe('Worker text');
  });

  it('opens a new row after the turn is closed', () => {
    feedStore.accumulateFeedEntry(feedStore.sessionId, content('Done.', 100));
    feedStore.closeStreamTurn(feedStore.sessionId, AGENT);
    feedStore.accumulateFeedEntry(feedStore.sessionId, content('A later continuation.', 200));

    const content1 = feedStore.feed.filter((entry) => entry.type === 'content');
    expect(content1.map((entry) => entry.text)).toEqual(['Done.', 'A later continuation.']);
  });

  it('keeps a skill row between the turn rows it happened between', () => {
    feedStore.applyManagerTurnEvent(SID, managerEvent('stream.thinking', { thinking: 'plan' }, 100));
    feedStore.applyManagerTurnEvent(SID, managerEvent('stream.delta', { content: 'answer' }, 500));
    feedStore.addFeedEntryForSession(feedStore.sessionId, skill('research', 300));

    // A new tool part re-expands the turn. The skill row landed inside the
    // turn's time range, so it must stay there instead of being pushed below
    // the tool call that ran later.
    feedStore.applyManagerTurnEvent(
      SID,
      managerEvent('stream.tool_call', { toolCall: { id: 'c1', name: 'bash', input: {} } }, 600),
    );

    expect(feedStore.feed.map((entry) => entry.type)).toEqual([
      'thinking',
      'skill',
      'content',
      'tool_call',
    ]);
    expect(feedStore.feed.map((entry) => entry.timestamp)).toEqual([100, 300, 500, 600]);
  });

  it('keeps a grouped worker row at the time of its first step', () => {
    const grouped = getGroupedEntries([
      {
        id: 'worker-1',
        timestamp: 100,
        type: 'system',
        agentId: 'worker-1',
        agentName: 'Worker',
        glowClass: '',
        text: 'step 1',
        metadata: { isSubAgent: true },
      },
      {
        id: 'worker-2',
        timestamp: 300,
        type: 'system',
        agentId: 'worker-1',
        agentName: 'Worker',
        glowClass: '',
        text: 'step 2',
        metadata: { isSubAgent: true },
      },
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0].entries).toHaveLength(2);
    // The group renders at its first step's position; letting its timestamp
    // follow the newest child made the list show 05:00 above a row at 04:40.
    expect(grouped[0].timestamp).toBe(100);
  });

  it('applies the same rule to agent thread transcripts', () => {
    agentStore.accumulateAgentThreadEntry(SID, AGENT, content('Thread text ', 100));
    agentStore.upsertAgentThreadEntry(SID, AGENT, toolCall('tc1', 'bash', 110));
    agentStore.accumulateAgentThreadEntry(SID, AGENT, content('continued.', 120));

    const rows = agentStore.getAgentThreadEntries(SID, AGENT);
    const contentRows = rows.filter((entry) => entry.type === 'content');
    expect(contentRows).toHaveLength(1);
    expect(contentRows[0].text).toBe('Thread text continued.');

    agentStore.closeAgentThreadTurn(SID, AGENT);
    agentStore.accumulateAgentThreadEntry(SID, AGENT, content('Next turn.', 200));
    expect(
      agentStore.getAgentThreadEntries(SID, AGENT).filter((entry) => entry.type === 'content'),
    ).toHaveLength(2);
  });
});
