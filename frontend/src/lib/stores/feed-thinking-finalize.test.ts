import { describe, expect, it, vi } from 'vitest';

vi.mock('./sessions.svelte', () => ({
  sessionStore: { activeSessionId: 'reason-1' },
}));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/api.svelte', () => ({
  apiFetch: vi.fn(),
  parseJsonResponse: vi.fn(),
}));

import { feedStore } from './feed.svelte';
import type { FeedEntry } from '$lib/types';

function thinkingRow(agentId: string, startedAt: number, sessionId: string): Omit<FeedEntry, 'id'> {
  return {
    timestamp: startedAt,
    type: 'thinking',
    agentId,
    agentName: 'Kory',
    glowClass: '',
    text: 'considering…',
    thinkingStartedAt: startedAt,
    metadata: { sessionId },
  };
}

function feedEntryById(entries: FeedEntry[], text: string): FeedEntry {
  const match = entries.find((entry) => entry.text === text);
  if (!match) throw new Error(`no feed entry with text ${text}`);
  return match;
}

describe('reasoning timers stop when the run ends, not seconds later', () => {
  it('freezes a live block in the visible feed', () => {
    feedStore.activateSessionFeed('reason-1');
    feedStore.beginThinking('kory-manager', 1000);
    feedStore.accumulateFeedEntry({
      ...thinkingRow('kory-manager', 1000, 'reason-1'),
      thinkingStartedAt: feedStore.getThinkingStart('kory-manager', 1000),
    });

    feedStore.finalizeThinking('kory-manager', 4600, 'reason-1');

    const entry = feedStore.feed[0];
    expect(entry.thinkingFinalized).toBe(true);
    expect(entry.durationMs).toBe(3600);
  });

  it('freezes the block of a session that finished while another chat was open', () => {
    feedStore.activateSessionFeed('reason-2');
    feedStore.beginThinking('kory-manager', 2000);
    feedStore.accumulateFeedEntry({
      ...thinkingRow('kory-manager', 2000, 'reason-2'),
      thinkingStartedAt: feedStore.getThinkingStart('kory-manager', 2000),
    });

    // The reader switches away, then the run completes in the background.
    feedStore.activateSessionFeed('reason-3');
    feedStore.finalizeThinking('kory-manager', 5000, 'reason-2');

    // Reopening the chat must show a finished stopwatch, not a live one, and
    // it must not borrow the reader's current chat's reasoning rows.
    feedStore.activateSessionFeed('reason-2');
    const entry = feedEntryById(feedStore.feed, 'considering…');
    expect(entry.thinkingFinalized).toBe(true);
  });

  it('freezes a background transcript at the server duration of its own lane', () => {
    feedStore.activateSessionFeed('reason-visible');
    // A run that started in this chat and is now only reachable through its
    // cached transcript: written straight into that session's lane.
    feedStore.addFeedEntryForSession('reason-2b', {
      ...thinkingRow('kory-manager', 2000, 'reason-2b'),
      text: 'background reasoning',
    });

    // A terminal event for that session lands while another chat is open.
    feedStore.finalizeThinking('kory-manager', 5000, 'reason-2b');

    feedStore.activateSessionFeed('reason-2b');
    const entry = feedEntryById(feedStore.feed, 'background reasoning');
    expect(entry.thinkingFinalized).toBe(true);
    expect(entry.durationMs).toBe(3000);
  });

  it('leaves another lane’s reasoning alone', () => {
    feedStore.activateSessionFeed('reason-visible-2');
    feedStore.addFeedEntryForSession('reason-2c', {
      ...thinkingRow('kory-manager', 2000, 'reason-2c'),
      text: 'other lane',
    });

    feedStore.finalizeThinking('kory-manager', 5000, 'reason-2b');

    feedStore.activateSessionFeed('reason-2c');
    expect(feedStore.feed[0].thinkingFinalized).toBeUndefined();
  });

  it('seals a still-running block when the reader leaves the chat', () => {
    feedStore.activateSessionFeed('reason-4');
    feedStore.beginThinking('kory-manager', 7000);
    feedStore.accumulateFeedEntry({
      ...thinkingRow('kory-manager', 7000, 'reason-4'),
      text: 'left mid-thought',
      thinkingStartedAt: feedStore.getThinkingStart('kory-manager', 7000),
    });

    feedStore.activateSessionFeed('reason-5');

    feedStore.activateSessionFeed('reason-4');
    const entry = feedEntryById(feedStore.feed, 'left mid-thought');
    // Sealed: reopening the chat never shows a stopwatch climbing from a start
    // timestamp whose origin the reader can no longer see. The frozen value is
    // the last server timestamp observed for the block, never a client clock
    // differenced against a server start.
    expect(entry.thinkingFinalized).toBe(true);
    expect(entry.durationMs).toBe(0);
  });

  it('freezes at the last server duration when Stop has no server end timestamp', () => {
    feedStore.activateSessionFeed('reason-stop');
    feedStore.beginThinking('kory-manager', 1000);
    feedStore.accumulateFeedEntry({
      ...thinkingRow('kory-manager', 1000, 'reason-stop'),
      thinkingStartedAt: feedStore.getThinkingStart('kory-manager', 1000),
    });
    feedStore.accumulateFeedEntry({
      ...thinkingRow('kory-manager', 2400, 'reason-stop'),
      thinkingStartedAt: 1000,
    });

    feedStore.finalizeSessionThinking('reason-stop');

    const entry = feedEntryById(feedStore.feed, 'considering…');
    expect(entry.thinkingFinalized).toBe(true);
    expect(entry.durationMs).toBe(1400);
  });

  it('re-opens a sealed block when live reasoning resumes after a reconnect', () => {
    feedStore.activateSessionFeed('reason-6');
    feedStore.beginThinking('kory-manager', 1000);
    // Replay seals history on arrival…
    feedStore.accumulateFeedEntry({
      ...thinkingRow('kory-manager', 1000, 'reason-6'),
      thinkingStartedAt: 1000,
      thinkingFinalized: true,
      durationMs: 0,
    });
    expect(feedStore.feed[0].thinkingFinalized).toBe(true);

    // …and the live tail of the same turn continues afterwards.
    feedStore.accumulateFeedEntry({
      ...thinkingRow('kory-manager', 3200, 'reason-6'),
      thinkingStartedAt: 1000,
    });

    const entry = feedStore.feed[0];
    expect(entry.thinkingFinalized).toBe(false);
    expect(entry.durationMs).toBe(2200);
  });

  it('does not re-open a sealed block from another replayed delta', () => {
    feedStore.activateSessionFeed('reason-7');
    feedStore.accumulateFeedEntry({
      ...thinkingRow('kory-manager', 1000, 'reason-7'),
      thinkingStartedAt: 1000,
      thinkingFinalized: true,
      durationMs: 0,
    });
    feedStore.accumulateFeedEntry({
      ...thinkingRow('kory-manager', 2500, 'reason-7'),
      thinkingStartedAt: 1000,
      thinkingFinalized: true,
      durationMs: 0,
    });

    const entry = feedStore.feed[0];
    expect(entry.thinkingFinalized).toBe(true);
    expect(entry.durationMs).toBe(1500);
  });
});
