import { describe, expect, test } from 'vitest';
import type { FeedEntryLocal } from '$lib/types';
import {
  finalizeThinkingEntries,
  mergeFeedTimeline,
  omitArchivedToolDuplicates,
  operationalEntriesForReload,
  withoutAnalyzingThoughts,
} from './feed-timeline';

function entry(
  id: string,
  timestamp: number,
  type: FeedEntryLocal['type'],
  archiveId?: string,
): FeedEntryLocal {
  return {
    id,
    timestamp,
    type,
    agentId: 'kory-manager',
    agentName: 'Kory',
    glowClass: '',
    text: id,
    metadata: archiveId ? { toolResult: { archiveId } } : undefined,
  };
}

describe('feed timeline reconciliation', () => {
  test('places live reasoning and tools before the persisted answer that followed them', () => {
    const history = [entry('user', 100, 'user_message'), entry('answer', 400, 'content')];
    const live = [entry('thinking', 200, 'thinking'), entry('tool', 300, 'tool_result')];

    expect(mergeFeedTimeline(history, live).map((item) => item.id)).toEqual([
      'user',
      'thinking',
      'tool',
      'answer',
    ]);
  });

  test('keeps persisted turn boundaries causal when separate lanes share a timestamp', () => {
    const answer = {
      ...entry('answer', 200, 'content'),
      metadata: { messageId: 'assistant-1' },
    };
    const user = {
      ...entry('user', 200, 'user_message'),
      metadata: { messageId: 'user-1' },
    };
    const thinking = entry('thinking', 200, 'thinking');

    expect(mergeFeedTimeline([answer, user], [thinking]).map((item) => item.id)).toEqual([
      'user',
      'thinking',
      'answer',
    ]);
  });

  test('uses canonical sequence even when wall-clock timestamps disagree', () => {
    const answer = {
      ...entry('answer', 100, 'content'),
      metadata: { eventEpoch: 1, sequenceStart: 4 },
    };
    const tool = {
      ...entry('tool', 900, 'tool_result'),
      metadata: { eventEpoch: 1, sequenceStart: 3 },
    };

    expect(mergeFeedTimeline([answer], [tool]).map((item) => item.id)).toEqual(['tool', 'answer']);
  });

  test('collapses a live row observed in more than one refresh lane', () => {
    const liveThought = entry('thought-1', 200, 'thought');

    expect(mergeFeedTimeline([liveThought], [liveThought]).map((item) => item.id)).toEqual([
      'thought-1',
    ]);
  });

  test('prefers a richer live tool result over its archived reload fallback', () => {
    const archived = [
      entry('arch-a', 200, 'tool_result', 'archive-a'),
      entry('arch-b', 300, 'tool_result', 'archive-b'),
    ];
    const live = [entry('live-a', 201, 'tool_result', 'archive-a')];

    expect(omitArchivedToolDuplicates(archived, live).map((item) => item.id)).toEqual(['arch-b']);
  });

  test('keeps reasoning and tools through a later message-history refresh', () => {
    const persistedAnswer = {
      ...entry('answer', 400, 'content'),
      metadata: { messageId: 'assistant-1' },
    };
    const operational = [entry('thought', 200, 'thought'), entry('tool', 300, 'tool_result')];

    expect(
      operationalEntriesForReload([persistedAnswer, ...operational]).map((item) => item.id),
    ).toEqual(['thought', 'tool']);
  });

  test('retains sequenced live content long enough to transfer its canonical anchor', () => {
    const replayed = {
      ...entry('live-answer', 300, 'content'),
      metadata: { messageId: 'assistant-1', eventEpoch: 1, sequenceStart: 9 },
    };
    const persisted = {
      ...entry('persisted-answer', 300, 'content'),
      metadata: { messageId: 'assistant-1' },
    };

    expect(operationalEntriesForReload([replayed, persisted]).map((item) => item.id)).toEqual([
      'live-answer',
    ]);
  });

  test('removes stale analyzing rows after cancellation even when their tracked id was lost', () => {
    const stale = {
      ...entry('stale-analysis', 200, 'thought'),
      metadata: { phase: 'analyzing' },
    };
    const stopped = entry('stopped', 300, 'system');

    expect(withoutAnalyzingThoughts([stale, stopped], null).map((item) => item.id)).toEqual([
      'stopped',
    ]);
  });

  test('freezes worker reasoning when its next action arrives', () => {
    const thinking = { ...entry('thinking', 150, 'thinking'), thinkingStartedAt: 100 };
    const [finalized] = finalizeThinkingEntries([thinking], 'kory-manager', 350);

    expect(finalized.thinkingFinalized).toBe(true);
    expect(finalized.durationMs).toBe(250);
  });
});
