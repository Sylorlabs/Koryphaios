import { describe, expect, test } from 'bun:test';
import { isRunRef, isRunRevisionRef } from './RunRefs';

describe('run references', () => {
  test('accepts stable run correlation without duplicating lifecycle state', () => {
    expect(isRunRef({ sessionId: 'session', runId: 'run' })).toBe(true);
    expect(isRunRevisionRef({ sessionId: 'session', runId: 'run', revision: 2 })).toBe(true);
    expect(isRunRevisionRef({ sessionId: 'session', runId: 'run', revision: -1 })).toBe(false);
    expect(isRunRef({ sessionId: 'session', runId: '' })).toBe(false);
  });
});
