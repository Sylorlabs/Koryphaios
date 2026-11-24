import { describe, expect, it } from 'vitest';
import type { TranscriptPart } from '@koryphaios/shared';
import { partsToFeedEntries, toolResultText } from './transcript-turns';

const base = {
  sessionId: 'session-1',
  messageId: 'm-1',
  agentName: 'Kory',
  glowClass: 'glow-kory',
};

const parts: TranscriptPart[] = [
  { kind: 'reasoning', text: 'plan', startedAt: 100, endedAt: 150, thinkingTokens: 12 },
  {
    kind: 'tool',
    callId: 'call-1',
    name: 'bash',
    input: { command: 'ls' },
    startedAt: 160,
    output: 'a.ts',
    isError: false,
    durationMs: 40,
    endedAt: 200,
  },
  { kind: 'reasoning', text: 'more', startedAt: 210, endedAt: 220 },
  { kind: 'text', text: 'Done.', startedAt: 230 },
];

describe('partsToFeedEntries', () => {
  it('expands each part into one row in order with deterministic ids', () => {
    const rows = partsToFeedEntries({ ...base, parts });
    expect(rows.map((row) => [row.id, row.type])).toEqual([
      ['turn-m-1-0', 'thinking'],
      ['turn-m-1-1', 'tool_result'],
      ['turn-m-1-2', 'thinking'],
      ['turn-m-1-3', 'content'],
    ]);
    expect(rows.map((row) => row.id)).toEqual(
      partsToFeedEntries({ ...base, parts }).map((row) => row.id),
    );
  });

  it('maps reasoning timing and tokens to the thinking row fields', () => {
    const [first, , second] = partsToFeedEntries({ ...base, parts });
    expect(first).toMatchObject({
      timestamp: 100,
      thinkingStartedAt: 100,
      durationMs: 50,
      thinkingFinalized: true,
      text: 'plan',
      metadata: { thinkingTokens: 12 },
    });
    expect(second).toMatchObject({
      thinkingStartedAt: 210,
      durationMs: 10,
      thinkingFinalized: true,
    });
  });

  it('keeps an open reasoning part live', () => {
    const [row] = partsToFeedEntries({
      ...base,
      parts: [{ kind: 'reasoning', text: 'thinking', startedAt: 5 }],
    });
    expect(row).toMatchObject({ type: 'thinking', thinkingStartedAt: 5, thinkingFinalized: false });
    expect(row.durationMs).toBeUndefined();
  });

  it('renders a running tool as a call row and a finished tool as a result row', () => {
    const rows = partsToFeedEntries({
      ...base,
      parts: [{ kind: 'tool', callId: 'c', name: 'bash', input: { x: 1 }, startedAt: 10 }],
    });
    expect(rows[0]).toMatchObject({
      type: 'tool_call',
      text: 'Calling tool: bash',
      metadata: { toolCall: { id: 'c', name: 'bash', input: { x: 1 } } },
    });
    expect(rows[0].metadata?.toolResult).toBeUndefined();

    const done = partsToFeedEntries({ ...base, parts })[1];
    expect(done).toMatchObject({
      type: 'tool_result',
      timestamp: 200,
      text: 'Tool result (40ms): a.ts',
      metadata: {
        toolCall: { id: 'call-1', name: 'bash', input: { command: 'ls' } },
        toolResult: {
          callId: 'call-1',
          name: 'bash',
          output: 'a.ts',
          isError: false,
          durationMs: 40,
        },
      },
    });
  });

  it('formats failed and unmeasured tool results like the live stream', () => {
    expect(toolResultText('boom', true, 9)).toBe('Tool error: boom');
    expect(toolResultText('ok', false, 0)).toBe('Tool result (time not reported by provider): ok');
  });

  it('tags every row with the turn and session, and puts message metadata on the text row', () => {
    const rows = partsToFeedEntries({
      ...base,
      parts,
      messageMetadata: { messageId: 'm-1', model: 'x', variantGroupId: 'g' },
    });
    for (const row of rows) {
      expect(row.metadata).toMatchObject({ sessionId: 'session-1', turnMessageId: 'm-1' });
    }
    expect(rows[3].metadata).toMatchObject({ messageId: 'm-1', model: 'x', variantGroupId: 'g' });
    expect(rows[0].metadata).not.toHaveProperty('model');
  });

  it('falls back to the last row when the turn has no text part', () => {
    const rows = partsToFeedEntries({
      ...base,
      parts: [{ kind: 'reasoning', text: 'only', startedAt: 1, endedAt: 2 }],
      messageMetadata: { messageId: 'm-1', model: 'x' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ model: 'x', messageId: 'm-1' });
  });

  it('returns no rows for an empty turn or a missing message id', () => {
    expect(partsToFeedEntries({ ...base, parts: [] })).toEqual([]);
    expect(partsToFeedEntries({ ...base, messageId: '', parts })).toEqual([]);
  });
});
