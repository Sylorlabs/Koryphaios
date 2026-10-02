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

import { feedStore } from './feed.svelte';
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
    feedStore.clearFeed();
    feedStore.activateSessionFeed(SID);
  });

  it('keeps text on one row when a tool call lands mid-sentence', () => {
    feedStore.accumulateFeedEntry(content('Launching Codex — checking its ', 100));
    feedStore.addFeedEntry(toolCall('tc1', 'read_file', 110));
    feedStore.accumulateFeedEntry(content('layout and start command.', 120));

    const rows = feedStore.feed;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      type: 'content',
      text: 'Launching Codex — checking its layout and start command.',
    });
    expect(rows[1].type).toBe('tool_call');
  });

  it('keeps reasoning on one row across tool activity', () => {
    feedStore.accumulateFeedEntry({
      timestamp: 100,
      type: 'thinking',
      agentId: AGENT,
      agentName: 'Kory',
      glowClass: '',
      text: 'first ',
      thinkingStartedAt: 100,
      metadata: { sessionId: SID },
    });
    feedStore.addFeedEntry(toolCall('tc1', 'grep', 110));
    feedStore.accumulateFeedEntry({
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
    expect(thinking).toHaveLength(1);
    expect(thinking[0].text).toBe('first second');
  });

  it('starts a new row for the next user turn', () => {
    feedStore.addUserMessage(SID, 'launch codex for me');
    feedStore.accumulateFeedEntry(content('Checking its layout.', 100));
    feedStore.addUserMessage(SID, 'and now something else');
    feedStore.accumulateFeedEntry(content('On it.', 200));

    const content1 = feedStore.feed.filter((entry) => entry.type === 'content');
    expect(content1).toHaveLength(2);
    expect(content1.map((entry) => entry.text)).toEqual(['Checking its layout.', 'On it.']);
  });

  it('does not merge another agent into the same row', () => {
    feedStore.accumulateFeedEntry(content('Manager text', 100));
    feedStore.accumulateFeedEntry(content('Worker text', 110, 'worker-1'));
    feedStore.accumulateFeedEntry(content(' more manager', 120));

    const content1 = feedStore.feed.filter((entry) => entry.type === 'content');
    expect(content1).toHaveLength(2);
    expect(content1[0].text).toBe('Manager text more manager');
    expect(content1[1].text).toBe('Worker text');
  });

  it('opens a new row after the turn is closed', () => {
    feedStore.accumulateFeedEntry(content('Done.', 100));
    feedStore.closeStreamTurn(AGENT);
    feedStore.accumulateFeedEntry(content('A later continuation.', 200));

    const content1 = feedStore.feed.filter((entry) => entry.type === 'content');
    expect(content1.map((entry) => entry.text)).toEqual(['Done.', 'A later continuation.']);
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
