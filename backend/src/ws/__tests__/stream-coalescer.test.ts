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

  test('coalesces stream.thinking chunks without dropping text', () => {
    const published: WSMessage[] = [];
    const coalescer = new StreamCoalescer((msg) => published.push(msg));

    const thinking = (text: string): WSMessage => ({
      type: 'stream.thinking',
      sessionId: 's1',
      agentId: 'kory-manager',
      timestamp: Date.now(),
      payload: { agentId: 'a1', thinking: text },
    });

    coalescer.enqueue(thinking('Let me '));
    coalescer.enqueue(thinking('think about this'));
    coalescer.flushAll();

    expect(published.length).toBe(1);
    const payload = published[0].payload as { thinking: string; content?: string };
    expect(payload.thinking).toBe('Let me think about this');
    expect(payload.content).toBeUndefined();
  });

  test('does not merge chunks across different sessions', () => {
    const published: WSMessage[] = [];
    const coalescer = new StreamCoalescer((msg) => published.push(msg));

    coalescer.enqueue(delta('s1', 'a1', 'chat A'));
    coalescer.enqueue(delta('s2', 'a1', 'chat B'));
    coalescer.flushAll();

    expect(published.length).toBe(2);
    const texts = published.map((m) => (m.payload as { content: string }).content).sort();
    expect(texts).toEqual(['chat A', 'chat B']);
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