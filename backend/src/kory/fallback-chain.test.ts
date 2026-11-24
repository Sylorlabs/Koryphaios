import { describe, expect, test } from 'bun:test';
import type { FallbackChain, FallbackStep } from '@koryphaios/shared';
import { normalizeFallbackChain } from '@koryphaios/shared';
import {
  beginFallbackTurnState,
  classifyFallbackFailure,
  decideFallbackHop,
  FALLBACK_RESET_COOLDOWN_MS,
  fallbackReasonEnabled,
  formatFallbackExhaustedSummary,
  onFallbackChainExhausted,
  registerFallbackChainExhaustedHandler,
  resolveFallbackChain,
  type FallbackTurnState,
} from './fallback-chain';
import { checkFallbackSteps } from './fallback-chain-check';
import { normalizeFallbackStepInput, normalizeFallbackStepsInput } from './fallback-chain-input';

const NOW = 1_000_000;

function chainOf(steps: FallbackStep[], overrides: Partial<FallbackChain> = {}): FallbackChain {
  return normalizeFallbackChain({ steps, ...overrides });
}

function stateFor(chain: FallbackChain): FallbackTurnState {
  return beginFallbackTurnState({ role: 'manager', chain, now: NOW }).state;
}

/** Only the named providers are connected; every route resolves to its own provider handle. */
function connected(names: readonly string[]) {
  return (step: FallbackStep) => {
    const provider = step.provider || 'auto';
    if (!names.includes(provider)) return undefined;
    return { model: step.model, provider: { name: provider }, providerName: provider };
  };
}

const STEP_A: FallbackStep = { provider: 'openai', model: 'gpt-5' };
const STEP_B: FallbackStep = { provider: 'anthropic', model: 'sonnet' };
const PRIMARY = { model: 'opus', provider: 'anthropic' };

describe('classifyFallbackFailure', () => {
  test('usage cap text is a usage limit even when wrapped as a 500', () => {
    expect(classifyFallbackFailure('Internal error: Free usage limit reached', 500)).toBe(
      'usage_limit',
    );
  });

  test('429 and rate wording are rate limits', () => {
    expect(classifyFallbackFailure('Too many requests', 429)).toBe('rate_limit');
    expect(classifyFallbackFailure('rate limit exceeded for requests per minute')).toBe(
      'rate_limit',
    );
  });

  test('timeouts are timeouts, by error name or text', () => {
    const idle = Object.assign(new Error('Stream idle timeout after 60000ms'), {
      name: 'TimeoutError',
    });
    expect(classifyFallbackFailure(idle)).toBe('timeout');
    expect(classifyFallbackFailure('The request timed out')).toBe('timeout');
  });

  test('any other provider failure is a provider error', () => {
    expect(classifyFallbackFailure('upstream returned 502 bad gateway', 502)).toBe(
      'provider_error',
    );
    expect(classifyFallbackFailure('The model returned an empty response.')).toBe('provider_error');
  });

  test('auth failures never classify, so they never hop', () => {
    expect(classifyFallbackFailure('Unauthorized', 401)).toBeUndefined();
    expect(classifyFallbackFailure('forbidden', 403)).toBeUndefined();
    expect(classifyFallbackFailure('Invalid API key provided')).toBeUndefined();
    expect(classifyFallbackFailure('Please sign in to continue')).toBeUndefined();
    expect(classifyFallbackFailure('token expired, run codex login')).toBeUndefined();
  });

  test('triggers gate each reason independently', () => {
    const triggers = { usageLimit: false, rateLimit: true, providerError: true, timeout: false };
    expect(fallbackReasonEnabled('usage_limit', triggers)).toBe(false);
    expect(fallbackReasonEnabled('rate_limit', triggers)).toBe(true);
    expect(fallbackReasonEnabled('timeout', triggers)).toBe(false);
  });
});

describe('resolveFallbackChain precedence', () => {
  const roleChains = {
    default: chainOf([STEP_A]),
    worker: chainOf([STEP_B]),
  };

  test('a per-chat override beats the role chain and the default', () => {
    const chain = resolveFallbackChain({
      sessionOverride: chainOf([{ provider: 'openai', model: 'chat-pick' }]),
      roleChains,
      role: 'worker',
    });
    expect(chain.steps.map((step) => step.model)).toEqual(['chat-pick']);
  });

  test('a role chain beats the default when there is no override', () => {
    expect(resolveFallbackChain({ roleChains, role: 'worker' }).steps).toEqual([STEP_B]);
  });

  test('the default applies to a role with no chain of its own', () => {
    expect(resolveFallbackChain({ roleChains, role: 'critic' }).steps).toEqual([STEP_A]);
  });

  test('no configuration means an empty chain', () => {
    expect(resolveFallbackChain({ role: 'manager' }).steps).toEqual([]);
  });
});

describe('decideFallbackHop', () => {
  const chain = chainOf([STEP_A, STEP_B]);

  test('a usage limit hops to the first connected step and records it', () => {
    const decision = decideFallbackHop({
      state: stateFor(chain),
      failure: { message: 'usage limit reached' },
      current: PRIMARY,
      now: NOW,
      resolve: connected(['openai', 'anthropic']),
    });
    expect(decision.kind).toBe('hop');
    if (decision.kind !== 'hop') return;
    expect(decision.stepIndex).toBe(0);
    expect(decision.hop).toEqual({
      fromModel: 'opus',
      fromProvider: 'anthropic',
      toModel: 'gpt-5',
      toProvider: 'openai',
      reason: 'usage_limit',
      stepIndex: 0,
      at: NOW,
    });
    expect(decision.state.activeIndex).toBe(0);
  });

  test.each([
    ['rate limit', 'Too many requests', 'rate_limit'],
    ['provider error', 'bad gateway', 'provider_error'],
    ['timeout', 'request timed out', 'timeout'],
  ] as const)('a %s hops with its reason recorded', (_label, message, reason) => {
    const decision = decideFallbackHop({
      state: stateFor(chain),
      failure: { message },
      current: PRIMARY,
      now: NOW,
      resolve: connected(['openai']),
    });
    expect(decision.kind).toBe('hop');
    if (decision.kind === 'hop') expect(decision.hop.reason).toBe(reason);
  });

  test('an auth failure never hops and leaves the state untouched', () => {
    const state = stateFor(chain);
    const decision = decideFallbackHop({
      state,
      failure: { message: 'Invalid API key', status: 401 },
      current: PRIMARY,
      now: NOW,
      resolve: connected(['openai', 'anthropic']),
    });
    expect(decision.kind).toBe('none');
    expect(decision.state).toEqual(state);
  });

  test('a disabled trigger does not hop', () => {
    const disabled = chainOf([STEP_A], {
      triggers: { usageLimit: false, rateLimit: true, providerError: true, timeout: true },
    });
    const decision = decideFallbackHop({
      state: stateFor(disabled),
      failure: { message: 'usage limit reached' },
      current: PRIMARY,
      now: NOW,
      resolve: connected(['openai']),
    });
    expect(decision.kind).toBe('none');
  });

  test('a second failure after a hop moves to the next step', () => {
    const first = decideFallbackHop({
      state: stateFor(chain),
      failure: { message: 'rate limit' },
      current: PRIMARY,
      now: NOW,
      resolve: connected(['openai', 'anthropic']),
    });
    if (first.kind !== 'hop') throw new Error('expected a hop');
    const second = decideFallbackHop({
      state: first.state,
      failure: { message: 'rate limit' },
      current: { model: 'gpt-5', provider: 'openai' },
      now: NOW,
      resolve: connected(['openai', 'anthropic']),
    });
    expect(second.kind).toBe('hop');
    if (second.kind === 'hop') {
      expect(second.stepIndex).toBe(1);
      expect(second.hop.fromModel).toBe('gpt-5');
    }
  });

  test('a disconnected step is skipped at runtime and recorded', () => {
    const decision = decideFallbackHop({
      state: stateFor(chain),
      failure: { message: 'usage limit reached' },
      current: PRIMARY,
      now: NOW,
      resolve: connected(['anthropic']),
    });
    expect(decision.kind).toBe('hop');
    if (decision.kind === 'hop') {
      expect(decision.stepIndex).toBe(1);
      expect(decision.state.skipped).toEqual(['openai:gpt-5']);
    }
  });

  test('an exhausted chain reports every hop in its summary', () => {
    const first = decideFallbackHop({
      state: stateFor(chain),
      failure: { message: 'usage limit reached' },
      current: PRIMARY,
      now: NOW,
      resolve: connected(['openai', 'anthropic']),
    });
    if (first.kind !== 'hop') throw new Error('expected a hop');
    const second = decideFallbackHop({
      state: first.state,
      failure: { message: 'rate limit' },
      current: { model: 'gpt-5', provider: 'openai' },
      now: NOW,
      resolve: connected(['openai', 'anthropic']),
    });
    if (second.kind !== 'hop') throw new Error('expected a hop');
    const exhausted = decideFallbackHop({
      state: second.state,
      failure: { message: 'provider error' },
      current: { model: 'sonnet', provider: 'anthropic' },
      now: NOW,
      resolve: connected(['openai', 'anthropic']),
    });
    expect(exhausted.kind).toBe('exhausted');
    if (exhausted.kind !== 'exhausted') return;
    expect(exhausted.info.hops).toHaveLength(2);
    expect(exhausted.info.lastError).toBe('provider error');
    expect(exhausted.info.summary).toBe(
      'Fallback chain exhausted after 2 hops of 2 steps: opus (primary) -> gpt-5 (usage limit) -> sonnet (rate limit).',
    );
  });

  test('a chain whose every step is disconnected is exhausted with no hop', () => {
    const decision = decideFallbackHop({
      state: stateFor(chain),
      failure: { message: 'usage limit reached' },
      current: PRIMARY,
      now: NOW,
      resolve: connected([]),
    });
    expect(decision.kind).toBe('exhausted');
    if (decision.kind === 'exhausted') {
      expect(decision.info.summary).toBe(
        'Fallback chain skipped: no step is connected (openai:gpt-5, anthropic:sonnet).',
      );
    }
  });

  test('an empty chain with no failure route does nothing', () => {
    const decision = decideFallbackHop({
      state: stateFor(chainOf([])),
      failure: { message: 'usage limit reached' },
      current: PRIMARY,
      now: NOW,
      resolve: connected(['openai']),
    });
    expect(decision.kind).toBe('none');
  });

  test('never and after_reset carry a sticky step; next_turn does not', () => {
    const hopWith = (returnToPrimary: FallbackChain['returnToPrimary']) => {
      const decision = decideFallbackHop({
        state: stateFor(chainOf([STEP_A], { returnToPrimary })),
        failure: { message: 'usage limit reached' },
        current: PRIMARY,
        now: NOW,
        resolve: connected(['openai']),
      });
      if (decision.kind !== 'hop') throw new Error('expected a hop');
      return decision.sticky;
    };
    expect(hopWith('next_turn')).toBeUndefined();
    expect(hopWith('never')).toMatchObject({
      role: 'manager',
      activeIndex: 0,
      stepKey: 'openai:gpt-5',
    });
    expect(hopWith('after_reset')?.resetAfter).toBe(NOW + FALLBACK_RESET_COOLDOWN_MS);
  });
});

describe('beginFallbackTurnState', () => {
  const sticky = {
    role: 'manager' as const,
    activeIndex: 1,
    stepKey: 'anthropic:sonnet',
    hoppedAt: NOW,
  };

  test('next_turn always starts on the primary route', () => {
    const began = beginFallbackTurnState({
      role: 'manager',
      chain: chainOf([STEP_A, STEP_B]),
      sticky,
      now: NOW,
    });
    expect(began.state.activeIndex).toBe(-1);
    expect(began.sticky).toBeUndefined();
  });

  test('never starts on the sticky step', () => {
    const began = beginFallbackTurnState({
      role: 'manager',
      chain: chainOf([STEP_A, STEP_B], { returnToPrimary: 'never' }),
      sticky,
      now: NOW + 10 * FALLBACK_RESET_COOLDOWN_MS,
    });
    expect(began.state.activeIndex).toBe(1);
  });

  test('after_reset starts on the sticky step until the cooldown passes', () => {
    const chain = chainOf([STEP_A, STEP_B], { returnToPrimary: 'after_reset' });
    const withReset = { ...sticky, resetAfter: NOW + 100 };
    expect(
      beginFallbackTurnState({ role: 'manager', chain, sticky: withReset, now: NOW }).state
        .activeIndex,
    ).toBe(1);
    expect(
      beginFallbackTurnState({ role: 'manager', chain, sticky: withReset, now: NOW + 101 }).state
        .activeIndex,
    ).toBe(-1);
  });

  test('a sticky index past the end of a shortened chain is ignored', () => {
    const began = beginFallbackTurnState({
      role: 'manager',
      chain: chainOf([STEP_A], { returnToPrimary: 'never' }),
      sticky,
      now: NOW,
    });
    expect(began.state.activeIndex).toBe(-1);
  });
});

describe('exhaustion hook', () => {
  test('subscribers receive the exhausted info and a throwing subscriber is isolated', () => {
    const seen: string[] = [];
    const unsubscribeBad = registerFallbackChainExhaustedHandler(() => {
      throw new Error('subscriber failure');
    });
    const unsubscribe = registerFallbackChainExhaustedHandler((sessionId, info) => {
      seen.push(`${sessionId}:${info.lastReason}:${info.summary}`);
    });
    onFallbackChainExhausted('s1', {
      role: 'manager',
      hops: [],
      lastReason: 'usage_limit',
      lastError: 'usage limit reached',
      stepCount: 1,
      summary: 'done',
    });
    unsubscribe();
    unsubscribeBad();
    onFallbackChainExhausted('s1', {
      role: 'manager',
      hops: [],
      lastReason: 'usage_limit',
      lastError: 'x',
      stepCount: 1,
      summary: 'after unsubscribe',
    });
    expect(seen).toEqual(['s1:usage_limit:done']);
  });

  test('an empty hop list yields an empty summary', () => {
    expect(formatFallbackExhaustedSummary([], 'opus', 2)).toBe('');
  });
});

describe('legacy and current step input', () => {
  test('a legacy provider:model step is split with the provider-key rules', () => {
    expect(
      normalizeFallbackStepInput({ model: 'custom:alpha:model-x', reasoningLevel: 'high' }),
    ).toEqual({
      provider: 'custom:alpha',
      model: 'model-x',
      reasoningLevel: 'high',
    });
  });

  test('a current step keeps its explicit provider even when the model has a colon', () => {
    expect(normalizeFallbackStepInput({ provider: 'ollama', model: 'llama3:8b' })).toEqual({
      provider: 'ollama',
      model: 'llama3:8b',
    });
  });

  test('a list keeps only valid steps', () => {
    expect(
      normalizeFallbackStepsInput([{ model: '' }, { model: 'anthropic:sonnet' }, 'nope']),
    ).toEqual([{ provider: 'anthropic', model: 'sonnet' }]);
    expect(normalizeFallbackStepsInput(undefined)).toEqual([]);
  });
});

describe('save-time step checks', () => {
  const lookup = {
    isChatProvider: (name: string) => name !== 'voyageai',
    isConnected: (name: string) => name === 'openai',
    listModelIds: (name: string) => (name === 'openai' ? ['gpt-5'] : undefined),
  };

  test('a disconnected provider is saved with a provider_disconnected status', () => {
    const result = checkFallbackSteps([{ provider: 'anthropic', model: 'sonnet' }], lookup);
    expect(result).toEqual({ ok: true, statuses: ['provider_disconnected'] });
  });

  test('a ready connected model passes', () => {
    expect(checkFallbackSteps([{ provider: 'openai', model: 'gpt-5' }], lookup)).toEqual({
      ok: true,
      statuses: ['ready'],
    });
  });

  test('a connected provider with an unknown model is rejected', () => {
    const result = checkFallbackSteps([{ provider: 'openai', model: 'not-a-model' }], lookup);
    expect(result).toMatchObject({ ok: false, stepIndex: 0 });
    if (!result.ok) expect(result.error).toContain('not a chat model offered by openai');
  });

  test('a provider that cannot chat is rejected', () => {
    const result = checkFallbackSteps([{ provider: 'voyageai', model: 'voyage-3' }], lookup);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain('cannot run chat turns');
  });
});
