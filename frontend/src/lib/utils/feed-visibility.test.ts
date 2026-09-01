import { describe, expect, it } from 'vitest';
import type { FeedEntry } from '$lib/types';
import { applyFeedVisibility, feedTargetKeysForEntry } from './feed-visibility';

function entry(overrides: Partial<FeedEntry> = {}): FeedEntry {
  return {
    id: 'entry',
    timestamp: 1,
    type: 'system',
    agentId: 'kory-manager',
    agentName: 'Kory',
    glowClass: '',
    text: 'durable row',
    metadata: { sessionId: 'session-1' },
    ...overrides,
  };
}

describe('durable feed visibility', () => {
  it('derives exact replay identities for messages, archives, threads, clients, and events', () => {
    const keys = feedTargetKeysForEntry(
      entry({
        metadata: {
          sessionId: 'session-1',
          messageId: 'message_1',
          clientEntryId: 'client_error_1',
          threadEntryId: 'thread_1',
          eventEpoch: 3,
          sequenceStart: 12,
          sequenceEnd: 15,
          toolResult: { archiveId: 'archive_1' },
        },
      }),
    );

    expect(keys).toEqual(
      expect.arrayContaining([
        'message:message_1',
        'client:client_error_1',
        'thread:thread_1',
        'archive:archive_1',
        'event:3:12:15',
      ]),
    );
  });

  it('suppresses only the overlapping ordered event card after replay', () => {
    const deleted = entry({
      id: 'deleted-event',
      metadata: { sessionId: 'session-1', eventEpoch: 2, sequenceStart: 10, sequenceEnd: 14 },
    });
    const survives = entry({
      id: 'next-event',
      metadata: { sessionId: 'session-1', eventEpoch: 2, sequenceStart: 15, sequenceEnd: 15 },
    });

    expect(
      applyFeedVisibility([deleted, survives], [
        { targetKey: 'event:2:12:13', visibility: 'deleted' },
      ]).map((candidate) => candidate.id),
    ).toEqual(['next-event']);
  });

  it('removes an empty group when every child is deleted', () => {
    const group = entry({
      id: 'tool-group',
      type: 'tool_group',
      entries: [
        entry({
          id: 'child-a',
          metadata: { sessionId: 'session-1', eventEpoch: 1, sequenceStart: 1, sequenceEnd: 1 },
        }),
        entry({
          id: 'child-b',
          metadata: { sessionId: 'session-1', eventEpoch: 1, sequenceStart: 2, sequenceEnd: 2 },
        }),
      ],
    });

    expect(
      applyFeedVisibility([group], [
        { targetKey: 'event:1:1:1', visibility: 'deleted' },
        { targetKey: 'event:1:2:2', visibility: 'deleted' },
      ]),
    ).toEqual([]);
  });

  it('keeps a hidden row in the transcript and clears stale local hide state after Show', () => {
    const clientError = entry({
      id: 'client-error',
      type: 'error',
      userHidden: true,
      metadata: { sessionId: 'session-1', clientEntryId: 'client_error_1' },
    });

    const hidden = applyFeedVisibility([clientError], [
      { targetKey: 'client:client_error_1', visibility: 'hidden' },
    ]);
    expect(hidden).toHaveLength(1);
    expect(hidden[0]?.userHidden).toBe(true);

    const shown = applyFeedVisibility(hidden, []);
    expect(shown[0]?.userHidden).toBe(false);
  });
});
