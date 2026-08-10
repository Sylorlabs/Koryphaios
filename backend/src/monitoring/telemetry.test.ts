import { describe, expect, it } from 'bun:test';
import { withSpan } from './telemetry';

describe('telemetry span execution', () => {
  it('executes the wrapped operation exactly once', async () => {
    let calls = 0;

    const result = await withSpan('single-execution-proof', async () => {
      calls += 1;
      return 'complete';
    });

    expect(result).toBe('complete');
    expect(calls).toBe(1);
  });

  it('propagates failures without retrying the operation', async () => {
    let calls = 0;

    await expect(
      withSpan('single-failure-proof', async () => {
        calls += 1;
        throw new Error('synthetic telemetry failure');
      }),
    ).rejects.toThrow('synthetic telemetry failure');

    expect(calls).toBe(1);
  });
});
