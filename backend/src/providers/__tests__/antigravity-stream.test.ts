import { describe, expect, test } from 'bun:test';
import { parseAntigravityStreamLine } from '../antigravity';

describe('Antigravity stream-json parser', () => {
  test('streams agent response deltas without waiting for process exit', () => {
    expect(parseAntigravityStreamLine(JSON.stringify({
      event: 'step_update',
      step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Hello' },
    }))).toEqual([{ type: 'content_delta', content: 'Hello' }]);
  });

  test('emits authoritative final usage for accounting and Billing', () => {
    expect(parseAntigravityStreamLine(JSON.stringify({
      event: 'result',
      result: {
        status: 'SUCCESS',
        usage: { input_tokens: 18_867, output_tokens: 18, cache_read_tokens: 4_000 },
      },
    }))).toEqual([{
      type: 'usage_update',
      tokensIn: 18_867,
      tokensOut: 18,
      tokensCache: 4_000,
    }]);
  });

  test('does not leak stream protocol or malformed lines into chat', () => {
    expect(parseAntigravityStreamLine('{not-json')).toEqual([]);
    expect(parseAntigravityStreamLine(JSON.stringify({ event: 'init' }))).toEqual([]);
  });
});
