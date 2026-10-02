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

  test('fixed window flushes a continuous stream instead of waiting for a pause', async () => {
    const published: Array<{ at: number; message: WSMessage }> = [];
    const coalescer = new StreamCoalescer((msg) =>
      published.push({ at: Date.now(), message: msg }),
    );
    try {
      const start = Date.now();
      // 12 chunks every 20ms: with a debounce this would publish nothing until
      // the ~240ms pause at the end; with a fixed window the first batch must
      // flush within ~100ms and no content may be lost or reordered.
      for (let i = 0; i < 12; i++) {
        coalescer.enqueue(delta('s1', 'a1', `t${i} `));
        await Bun.sleep(20);
      }
      const firstLatency = published.length > 0 ? published[0].at - start : Infinity;
      expect(published.length).toBeGreaterThanOrEqual(1);
      expect(firstLatency).toBeLessThan(100);

      coalescer.flushAll();
      const full = published
        .map((p) => (p.message.payload as { content: string }).content)
        .join('');
      expect(full).toBe(Array.from({ length: 12 }, (_, i) => `t${i} `).join(''));
    } finally {
      coalescer.dispose();
    }
  });

  test('later tokens never defer an open batch indefinitely', async () => {
    const published: WSMessage[] = [];
    const coalescer = new StreamCoalescer((msg) => published.push(msg));
    try {
      coalescer.enqueue(delta('s1', 'a1', 'a'));
      // Keep the batch "hot" with steady tokens past several window lengths.
      for (let i = 0; i < 5; i++) {
        await Bun.sleep(20);
        coalescer.enqueue(delta('s1', 'a1', 'b'));
      }
      // The batch opened ~100ms ago with a 16ms fixed window: it must have
      // flushed on its timer despite the constant arrivals.
      expect(published.length).toBeGreaterThanOrEqual(1);
    } finally {
      coalescer.dispose();
    }
  });
});
