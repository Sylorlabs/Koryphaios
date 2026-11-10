import { describe, expect, it } from 'bun:test';
import { cancelLLMJobsForSession } from './llm-worker';

describe('LLM worker cancellation', () => {
  it('cancels only in-flight jobs owned by the requested session', async () => {
    const sessionA = new AbortController();
    const sessionB = new AbortController();
    const requests = new Map([
      ['job-a', { sessionId: 'session-a', controller: sessionA }],
      ['job-b', { sessionId: 'session-b', controller: sessionB }],
    ]);

    await expect(cancelLLMJobsForSession('session-a', requests)).resolves.toBe(1);
    expect(sessionA.signal.aborted).toBe(true);
    expect(sessionB.signal.aborted).toBe(false);
    expect([...requests.keys()]).toEqual(['job-b']);
  });
});
