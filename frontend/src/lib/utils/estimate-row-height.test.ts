import { describe, expect, it } from 'vitest';
import { estimateFeedHeight } from './estimate-row-height';
import type { FeedEntryLocal, FeedEntryType } from '$lib/types';

// The transcript's height — and therefore its scroll extent — is the sum of
// every row's height, and every row that has not been rendered yet is placed
// from an estimate. A bad estimate does not merely misplace one row: it puts
// the error into the total, where it is felt as the extent moving under a
// reader who is only scrolling.
//
// These are the properties the estimates have to hold. The exact pixel values
// are typography-derived and may be retuned; what must not change is that a row
// grows with its content, and that a row whose rendering is clamped is
// estimated as clamped.

function entry(
  type: FeedEntryType,
  text = '',
  extra: Partial<FeedEntryLocal> = {},
): FeedEntryLocal {
  return {
    id: `row-${type}-${text.length}`,
    timestamp: 0,
    type,
    agentId: 'a',
    agentName: 'a',
    glowClass: '',
    text,
    ...extra,
  };
}

describe('estimateFeedHeight', () => {
  it('grows a prose row with its text', () => {
    const short = estimateFeedHeight(entry('content', 'ok'));
    const medium = estimateFeedHeight(entry('content', 'x'.repeat(600)));
    const long = estimateFeedHeight(entry('content', 'x'.repeat(3000)));

    expect(short).toBeLessThan(medium);
    expect(medium).toBeLessThan(long);
    // A short answer is a couple of lines, not the 120px a flat guess gave it.
    expect(short).toBeLessThan(80);
  });

  it('grows a user bubble with its text', () => {
    expect(estimateFeedHeight(entry('user_message', 'hi'))).toBeLessThan(
      estimateFeedHeight(entry('user_message', 'x'.repeat(3000))),
    );
  });

  it('reads a collapsed reasoning panel as a header, however long its text', () => {
    // Collapsed, the text is not rendered. Estimating from it put hundreds of
    // phantom pixels into the transcript height per collapsed thought.
    const short = estimateFeedHeight(entry('thinking', 'brief', { isCollapsed: true }));
    const long = estimateFeedHeight(entry('thinking', 'x'.repeat(8000), { isCollapsed: true }));

    expect(long).toBe(short);
    expect(long).toBeLessThan(80);
  });

  it('grows an opened reasoning panel, up to its clamp', () => {
    const opened = (text: string) =>
      estimateFeedHeight(entry('thinking', text, { isCollapsed: false }));

    expect(opened('')).toBeLessThan(opened('x'.repeat(2000)));
    // `max-height: 18rem` on the panel: past that it scrolls internally.
    expect(opened('x'.repeat(200000))).toBeLessThanOrEqual(CLAMPED_PANEL_ROW);
  });

  it('estimates a sub-agent group as clamped however much it contains', () => {
    const group = (children: number, textLength: number) =>
      estimateFeedHeight(
        entry('agent_group', '', {
          entries: Array.from({ length: children }, (_, i) =>
            entry('tool_call', 'y'.repeat(textLength), { id: `child-${i}` }),
          ),
        }),
      );

    const small = group(2, 100);
    const large = group(40, 2000);
    expect(small).toBeLessThan(large);
    // `max-h-56` on the activity panel: past that it scrolls internally, so the
    // row cannot keep growing with the worker's transcript.
    expect(large).toBeLessThanOrEqual(CLAMPED_PANEL_ROW);
  });

  it('never returns a non-positive height', () => {
    for (const type of [
      'user_message',
      'content',
      'thinking',
      'tool_call',
      'tool_result',
      'tool_group',
      'agent_group',
      'compaction',
      'routing',
    ] as FeedEntryType[]) {
      expect(estimateFeedHeight(entry(type))).toBeGreaterThan(0);
      expect(estimateFeedHeight(entry(type, 'x'.repeat(50000)))).toBeGreaterThan(0);
    }
  });
});

/** Loose ceiling for a row whose content panel scrolls internally. */
const CLAMPED_PANEL_ROW = 600;
