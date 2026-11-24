import { describe, expect, test } from 'bun:test';
import {
  FALLBACK_CHAIN_MAX_STEPS,
  fallbackHopNoticeText,
  fallbackStepKey,
  normalizeFallbackChain,
  normalizeFallbackChainSettings,
  normalizeFallbackStep,
  normalizeFallbackSteps,
  reduceTurnEvents,
  turnEventFromWSMessage,
} from './index';

describe('fallback chain normalization', () => {
  test('current step shape keeps provider, reasoning and label', () => {
    expect(
      normalizeFallbackStep({ provider: 'openai', model: 'gpt-5', reasoningLevel: 'high', label: ' Fast ' }),
    ).toEqual({ provider: 'openai', model: 'gpt-5', reasoningLevel: 'high', label: 'Fast' });
  });

  test('legacy provider:model input is split on the first colon', () => {
    expect(normalizeFallbackStep({ model: 'anthropic:sonnet', reasoningLevel: 'low' })).toEqual({
      provider: 'anthropic',
      model: 'sonnet',
      reasoningLevel: 'low',
    });
  });

  test('a bare legacy model keeps an empty provider, resolved by model id at runtime', () => {
    expect(normalizeFallbackStep({ model: 'llama3' })).toEqual({ provider: '', model: 'llama3' });
    expect(fallbackStepKey({ provider: '', model: 'llama3' })).toBe('llama3');
  });

  test('malformed steps are dropped and an unknown reasoning level is ignored', () => {
    expect(normalizeFallbackStep({ provider: 'openai', model: '  ' })).toBeUndefined();
    expect(normalizeFallbackStep(null)).toBeUndefined();
    expect(
      normalizeFallbackStep({ provider: 'openai', model: 'gpt-5', reasoningLevel: 'extreme' }),
    ).toEqual({ provider: 'openai', model: 'gpt-5' });
  });

  test('a chain is capped at 50 steps', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ provider: 'openai', model: `m${i}` }));
    expect(normalizeFallbackSteps(many)).toHaveLength(FALLBACK_CHAIN_MAX_STEPS);
  });

  test('a chain fills default triggers and turn-return policy', () => {
    const chain = normalizeFallbackChain({ steps: [{ provider: 'openai', model: 'gpt-5' }] });
    expect(chain.triggers).toEqual({ usageLimit: true, rateLimit: true, providerError: true, timeout: true });
    expect(chain.returnToPrimary).toBe('next_turn');
    expect(chain.steps).toHaveLength(1);
  });

  test('explicit trigger toggles survive normalization', () => {
    const chain = normalizeFallbackChain({
      steps: [],
      triggers: { usageLimit: false, rateLimit: true, providerError: false, timeout: true },
      returnToPrimary: 'never',
    });
    expect(chain.triggers).toEqual({ usageLimit: false, rateLimit: true, providerError: false, timeout: true });
    expect(chain.returnToPrimary).toBe('never');
  });

  test('per-role settings keep only known roles', () => {
    const settings = normalizeFallbackChainSettings({
      default: { steps: [{ provider: 'openai', model: 'gpt-5' }] },
      manager: null,
      rogue: { steps: [] },
    });
    expect(Object.keys(settings)).toEqual(['default']);
  });
});

describe('fallback hop transcript notice', () => {
  const hop = {
    type: 'session.fallback.hop',
    timestamp: 10,
    payload: {
      sessionId: 's1',
      messageId: 'm1',
      fromModel: 'opus',
      toModel: 'sonnet',
      reason: 'usage_limit',
      stepIndex: 0,
    },
  };

  test('maps the hop event to a notice turn event with fallback detail', () => {
    const event = turnEventFromWSMessage(hop);
    expect(event).toEqual({
      type: 'notice',
      tone: 'info',
      text: fallbackHopNoticeText({ fromModel: 'opus', toModel: 'sonnet', reason: 'usage_limit', stepIndex: 0 }),
      timestamp: 10,
      fallback: { fromModel: 'opus', toModel: 'sonnet', reason: 'usage_limit', stepIndex: 0 },
    });
  });

  test('a notice sits between the text before and after the hop, never duplicating text', () => {
    const before = turnEventFromWSMessage({ type: 'stream.delta', timestamp: 1, payload: { content: 'Hello ' } });
    const after = turnEventFromWSMessage({ type: 'stream.delta', timestamp: 20, payload: { content: 'world' } });
    const parts = reduceTurnEvents([before!, turnEventFromWSMessage(hop)!, after!]);
    expect(parts.map((part) => part.kind)).toEqual(['text', 'notice', 'text']);
    const text = parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('');
    expect(text).toBe('Hello world');
  });

  test('a malformed hop payload maps to nothing', () => {
    expect(turnEventFromWSMessage({ type: 'session.fallback.hop', timestamp: 1, payload: { sessionId: 's1' } })).toBeNull();
  });
});
