import { describe, expect, test } from 'bun:test';
import { parseAntigravityStreamLine } from '../antigravity';

describe('Antigravity stream-json parser', () => {
  test('streams agent response deltas without waiting for process exit', () => {
    expect(
      parseAntigravityStreamLine(
        JSON.stringify({
          event: 'step_update',
          step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Hello' },
        }),
      ),
    ).toEqual([{ type: 'content_delta', content: 'Hello' }]);
  });

  test('emits authoritative final usage for accounting and Billing', () => {
    expect(
      parseAntigravityStreamLine(
        JSON.stringify({
          event: 'result',
          result: {
            status: 'SUCCESS',
            usage: { input_tokens: 18_867, output_tokens: 18, cache_read_tokens: 4_000 },
          },
        }),
      ),
    ).toEqual([
      {
        type: 'usage_update',
        tokensIn: 18_867,
        tokensOut: 18,
        tokensCache: 4_000,
        tokensCacheRead: 4_000,
      },
    ]);
  });

  test('does not leak stream protocol or malformed lines into chat', () => {
    expect(parseAntigravityStreamLine('{not-json')).toEqual([]);
    expect(parseAntigravityStreamLine(JSON.stringify({ event: 'init' }))).toEqual([]);
  });

  test('reports the CLI authentication reason instead of a bare ERROR status', () => {
    const events = parseAntigravityStreamLine(
      JSON.stringify({
        event: 'result',
        result: { status: 'ERROR', error: 'authentication failed or timed out' },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0].error).toContain('Antigravity authentication failed');
    expect(events[0].error).toContain('authentication failed or timed out');
    expect(events[0].errorTransient).toBe(false);
  });

  test('marks upstream 503 errors retryable before truncating the reason', () => {
    const events = parseAntigravityStreamLine(
      JSON.stringify({
        event: 'result',
        result: {
          status: 'ERROR',
          error: `Eligibility check failed: ${'detail '.repeat(50)}UNAVAILABLE (code 503): The service is currently unavailable.`,
        },
      }),
    );
    expect(events[0].errorTransient).toBe(true);
    expect(events[0].error).toContain('temporary upstream service error');
    expect(events[0].error!.length).toBeLessThan(450);
  });

  test('redacts credentials in result errors and retains useful model failures', () => {
    const events = parseAntigravityStreamLine(
      JSON.stringify({
        event: 'result',
        result: {
          status: 'ERROR',
          error: 'invalid model selection; access_token=synthetic-secret-value',
        },
      }),
    );
    expect(events[0].error).toContain('invalid model selection');
    expect(events[0].error).not.toContain('synthetic-secret-value');
    expect(events[0].errorTransient).toBe(false);
  });

  test('retains a useful fallback when an older CLI supplies no error reason', () => {
    const events = parseAntigravityStreamLine(
      JSON.stringify({
        event: 'result',
        result: { status: 'ERROR' },
      }),
    );
    expect(events[0].type).toBe('error');
    expect(events[0].error).toContain('Turn ended with status ERROR');
    expect(events[0].errorTransient).toBe(false);
  });
});
