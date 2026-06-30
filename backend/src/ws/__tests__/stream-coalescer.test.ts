import { describe, expect, test } from 'bun:test';
import type { WSMessage } from '@koryphaios/shared';
import { StreamCoalescer } from '../stream-coalescer';

function delta(sessionId: string, agentId: string, content: string): WSMessage {
  return {
    type: 'stream.delta',
    sessionId,
    agentId: 'kory-manager',
    timestamp: Date.now(),
    payload: { agentId, content, model: 'test' },
  };
}

describe('StreamCoalescer', () => {
  test('coalesces stream.delta chunks for the same agent', async () => {
    const published: WSMessage[] = [];
    const coalescer = new StreamCoalescer((msg) => published.push(msg));

    coalescer.enqueue(delta('s1', 'a1', 'Hello '));
    coalescer.enqueue(delta('s1', 'a1', 'world'));

    expect(published.length).toBe(0);
    coalescer.flushAll();
    expect(published.length).toBe(1);
    expect((published[0].payload as { content: string }).content).toBe('Hello world');
  });

  test('truncates oversized tool results', () => {
    const published: WSMessage[] = [];
    const coalescer = new StreamCoalescer((msg) => published.push(msg));
    const huge = 'x'.repeat(10_000);

    coalescer.enqueue({
      type: 'stream.tool_result',
      sessionId: 's1',
      timestamp: Date.now(),
      payload: {
        agentId: 'a1',
        toolResult: { id: 't1', output: huge },
      },
    });

    expect(published.length).toBe(1);
    const output = (published[0].payload as { toolResult: { output: string; truncated?: boolean } })
      .toolResult.output;
    expect(output.length).toBeLessThan(huge.length);
    expect(
      (published[0].payload as { toolResult: { truncated?: boolean } }).toolResult.truncated,
    ).toBe(true);
  });
});