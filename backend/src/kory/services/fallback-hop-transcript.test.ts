import { describe, expect, test } from 'bun:test';
import { TurnTranscriptRecorder } from './TurnTranscriptRecorder';
import {
  AgentFallbackChainRequestSchema,
  SessionFallbackChainRequestSchema,
} from '../../validation/schemas';

const MANAGER = 'kory-manager';

function delta(recorder: TurnTranscriptRecorder, content: string, timestamp: number) {
  recorder.observe({
    sessionId: 's1',
    type: 'stream.delta',
    payload: { agentId: MANAGER, content },
    timestamp,
    managerAgentId: MANAGER,
  });
}

describe('fallback hop folds into the persisted turn', () => {
  test('a mid-stream hop keeps the text once, with the notice between the two model segments', () => {
    const recorder = new TurnTranscriptRecorder();
    recorder.beginTurn('s1', 'm1');
    delta(recorder, 'The answer is ', 1);
    recorder.observe({
      sessionId: 's1',
      type: 'session.fallback.hop',
      payload: {
        sessionId: 's1',
        messageId: 'm1',
        fromModel: 'opus',
        toModel: 'gpt-5',
        reason: 'provider_error',
        stepIndex: 0,
      },
      timestamp: 2,
      managerAgentId: MANAGER,
    });
    delta(recorder, '42.', 3);

    const parts = recorder.snapshotParts('s1');
    expect(parts.map((part) => part.kind)).toEqual(['text', 'notice', 'text']);
    const text = parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('');
    expect(text).toBe('The answer is 42.');
    const notice = parts[1];
    expect(notice?.kind === 'notice' && notice.fallback?.toModel).toBe('gpt-5');
  });

  test('a hop naming another turn is not folded into the current one', () => {
    const recorder = new TurnTranscriptRecorder();
    recorder.beginTurn('s1', 'm2');
    recorder.observe({
      sessionId: 's1',
      type: 'session.fallback.hop',
      payload: {
        sessionId: 's1',
        messageId: 'm1',
        fromModel: 'a',
        toModel: 'b',
        reason: 'timeout',
        stepIndex: 0,
      },
      timestamp: 1,
      managerAgentId: MANAGER,
    });
    expect(recorder.snapshotParts('s1')).toEqual([]);
  });

  test('a hop with no active turn is passed through untouched', () => {
    const recorder = new TurnTranscriptRecorder();
    const payload = {
      sessionId: 's1',
      messageId: '',
      fromModel: 'a',
      toModel: 'b',
      reason: 'timeout',
      stepIndex: 0,
    };
    const published = recorder.observe({
      sessionId: 's1',
      type: 'session.fallback.hop',
      payload,
      timestamp: 1,
      managerAgentId: MANAGER,
    });
    expect(published).toBe(payload);
  });
});

describe('fallback chain request validation', () => {
  test('a valid agent-role PUT parses, with a null chain clearing the role', () => {
    expect(
      AgentFallbackChainRequestSchema.safeParse({
        role: 'manager',
        chain: { steps: [{ provider: 'openai', model: 'gpt-5', reasoningLevel: 'high' }] },
      }).success,
    ).toBe(true);
    expect(AgentFallbackChainRequestSchema.safeParse({ role: 'worker', chain: null }).success).toBe(
      true,
    );
  });

  test('an unknown role or reasoning level is rejected', () => {
    expect(
      AgentFallbackChainRequestSchema.safeParse({ role: 'reviewer', chain: null }).success,
    ).toBe(false);
    expect(
      SessionFallbackChainRequestSchema.safeParse({
        chain: { steps: [{ provider: 'openai', model: 'gpt-5', reasoningLevel: 'extreme' }] },
      }).success,
    ).toBe(false);
  });

  test('more than 50 steps is rejected', () => {
    const steps = Array.from({ length: 51 }, (_, i) => ({ provider: 'openai', model: `m${i}` }));
    const result = SessionFallbackChainRequestSchema.safeParse({ chain: { steps } });
    expect(result.success).toBe(false);
  });

  test('a step without a provider is rejected', () => {
    expect(
      SessionFallbackChainRequestSchema.safeParse({
        chain: { steps: [{ provider: '', model: 'gpt-5' }] },
      }).success,
    ).toBe(false);
  });
});
