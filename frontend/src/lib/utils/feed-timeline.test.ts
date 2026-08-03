import { describe, expect, test } from 'bun:test';
import type { FeedEntryLocal } from '$lib/types';
import {
  finalizeThinkingEntries,
  mergeFeedTimeline,
  omitArchivedToolDuplicates,
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

  test('prefers a richer live tool result over its archived reload fallback', () => {
    const archived = [
      entry('arch-a', 200, 'tool_result', 'archive-a'),
      entry('arch-b', 300, 'tool_result', 'archive-b'),
    ];
    const live = [entry('live-a', 201, 'tool_result', 'archive-a')];

    expect(omitArchivedToolDuplicates(archived, live).map((item) => item.id)).toEqual(['arch-b']);
  });

  test('freezes worker reasoning when its next action arrives', () => {
    const thinking = { ...entry('thinking', 150, 'thinking'), thinkingStartedAt: 100 };
    const [finalized] = finalizeThinkingEntries([thinking], 'kory-manager', 350);

    expect(finalized.thinkingFinalized).toBe(true);
    expect(finalized.durationMs).toBe(250);
  });
});
