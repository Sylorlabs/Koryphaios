import { afterEach, describe, expect, it } from 'bun:test';
import type { ModelDef } from '@koryphaios/shared';
import {
  __resetModelsDevCacheForTesting,
  applyModelsDevMetadata,
  modelsDevKeysFor,
  warmModelsDevCache,
} from '../models-dev';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetModelsDevCacheForTesting();
});

function def(id: string, provider: string): ModelDef {
  return {
    id,
    name: id,
    provider: provider as ModelDef['provider'],
    contextWindow: 0,
    maxOutputTokens: 4_096,
    supportsStreaming: true,
  };
}

/** Seed the module catalog with a synthetic models.dev payload. */
async function seedCatalog(): Promise<void> {
  const catalog = {
    openai: {
      models: {
        'gpt-5.5': {
          id: 'gpt-5.5',
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
          limit: { context: 400_000, output: 128_000 },
        },
      },
    },
    anthropic: {
      models: {
        'claude-opus-5': {
          id: 'claude-opus-5',
          reasoning: true,
          reasoning_options: [{ type: 'toggle' }],
          limit: { context: 1_000_000, output: 128_000 },
          modalities: { input: ['text', 'image'], output: ['text'] },
        },
        // Written with dashes; the lab's own spelling for the same model.
        'claude-sonnet-5-5': {
          id: 'claude-sonnet-5-5',
          reasoning: true,
          reasoning_options: [
            { type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] },
          ],
          limit: { context: 1_000_000, output: 128_000 },
        },
      },
    },
    moonshotai: {
      models: {
        'kimi-k2.6': {
          id: 'kimi-k2.6',
          reasoning: true,
          limit: { context: 262_144, output: 65_536 },
        },
      },
    },
    unorouter: {
      models: {
        'unorouter-house': {
          id: 'unorouter-house',
          reasoning: false,
          limit: { context: 128_000, output: 8_192 },
        },
      },
    },
    // A third-party gateway that re-keys a lab model under the lab's own
    // namespace with DIFFERENT (stale) numbers. models.dev's full-catalog scan
    // must never let this override what the named lab reports.
    'stale-gateway': {
      models: {
        'anthropic/claude-sonnet-5.5': {
          id: 'anthropic/claude-sonnet-5.5',
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
          limit: { context: 200_000, output: 32_000 },
        },
      },
    },
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(catalog), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  __resetModelsDevCacheForTesting();
  await warmModelsDevCache();
}

describe('models.dev fallback chain', () => {
  it('routes multi-lab gateways through the common upstream labs', () => {
    for (const gateway of [
      'experientiallabs',
      'commandcode',
      'github-models',
      'cline',
    ]) {
      const keys = modelsDevKeysFor(gateway);
      expect(keys).toContain('openai');
      expect(keys).toContain('anthropic');
      expect(keys).toContain('google');
    }
  });

  it('prefers the lab a namespaced id names, over any gateway opinion of it', async () => {
    // Regression: the full-catalog scan is first-wins, so a gateway that
    // re-keys `anthropic/claude-sonnet-5.5` with stale numbers used to win over
    // the anthropic lab's own entry. An id that names its lab must resolve
    // against that lab and stay honestly unknown on a miss, never inherit
    // another lab's claim.
    await seedCatalog();
    const keys = modelsDevKeysFor('cline');
    const [model] = applyModelsDevMetadata(
      'cline',
      [def('anthropic/claude-sonnet-5.5', 'cline')],
      keys,
    );
    expect(model.reasoningLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(model.contextWindow).toBe(1_000_000);
    expect(model.maxOutputTokens).toBe(128_000);
  });

  it('matches a lab entry whose id uses a different version separator', async () => {
    // `claude-sonnet-5.5` (gateway spelling) and `claude-sonnet-5-5` (the lab's
    // own) are the same model; only the separator differs.
    await seedCatalog();
    const [model] = applyModelsDevMetadata(
      'cline',
      [def('anthropic/claude-sonnet-5.5', 'cline')],
      modelsDevKeysFor('cline'),
    );
    expect(model.reasoningLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('resolves colon-qualified route variants against the same lab', async () => {
    // `claude-sonnet-5.5:batch` is the batch route of a model the lab knows.
    await seedCatalog();
    const [model] = applyModelsDevMetadata(
      'cline',
      [def('anthropic/claude-sonnet-5.5:batch', 'cline')],
      modelsDevKeysFor('cline'),
    );
    expect(model.reasoningLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(model.contextWindow).toBe(1_000_000);
  });

  it('leaves a named-lab model unknown when the lab has no entry', async () => {
    // Honest unknown beats a wrong answer: the stale gateway does have a
    // `anthropic/…` key, and it must still not be consulted.
    await seedCatalog();
    const [model] = applyModelsDevMetadata(
      'cline',
      [def('anthropic/claude-never-heard-of-it', 'cline')],
      modelsDevKeysFor('cline'),
    );
    expect(model.reasoningLevels).toBeUndefined();
    expect(model.contextWindow).toBe(0);
  });

  it('still scans the whole catalog for ids that name no known lab', async () => {
    await seedCatalog();
    const keys = modelsDevKeysFor('cline');
    const [gpt] = applyModelsDevMetadata('cline', [def('gpt-5.5', 'cline')], keys);
    expect(gpt.reasoningLevels).toEqual(['low', 'medium', 'high']);
    expect(gpt.contextWindow).toBe(400_000);
  });

  it('keeps direct single-key mappings intact', () => {
    expect(modelsDevKeysFor('openai')).toEqual(['openai']);
    expect(modelsDevKeysFor('unorouter')).toEqual([
      'unorouter', 'openai', 'anthropic', 'google', 'xai', 'deepseek', 'groq', 'mistral',
    ]);
    // Vyce AI publishes bare upstream ids with no limits or effort ladder, so
    // it resolves through the cross-lab keys like the other resale gateways.
    expect(modelsDevKeysFor('vyceai')).toEqual([
      'openai', 'anthropic', 'google', 'xai', 'deepseek', 'groq', 'mistral',
    ]);
    expect(modelsDevKeysFor('mistral')).toEqual(['mistral']);
    expect(modelsDevKeysFor('qwen')).toEqual(['alibaba']);
    expect(modelsDevKeysFor('kimicode')).toEqual(['moonshotai']);
  });

  it('gives local servers no cross-lab keys', () => {
    expect(modelsDevKeysFor('local')).toEqual([]);
  });

  it('enriches gateway models via lab keys then the full-catalog scan', async () => {
    await seedCatalog();
    const keys = modelsDevKeysFor('commandcode');
    const [gpt, kimi] = applyModelsDevMetadata(
      'commandcode',
      [def('gpt-5.5', 'commandcode'), def('kimi-k2.6', 'commandcode')],
      keys,
    );
    // Plan C (common-lab keys): gpt-5.5 matches the openai lab entry.
    expect(gpt).toMatchObject({
      contextWindow: 400_000,
      contextVerified: true,
      maxOutputTokens: 128_000,
      canReason: true,
      reasoningLevels: ['low', 'medium', 'high'],
    });
    // Full-catalog scan: kimi-k2.6 lives only under moonshotai.
    expect(kimi).toMatchObject({
      contextWindow: 262_144,
      contextVerified: true,
      canReason: true,
    });
  });

  it('prefers UnoRouter metadata, then enriches routed upstream ids', async () => {
    await seedCatalog();
    const [native, routed] = applyModelsDevMetadata(
      'unorouter',
      [def('unorouter-house', 'unorouter'), def('gpt-5.5', 'unorouter')],
      modelsDevKeysFor('unorouter'),
    );
    expect(native).toMatchObject({ contextWindow: 128_000, contextVerified: true });
    expect(routed).toMatchObject({
      contextWindow: 400_000,
      contextVerified: true,
      reasoningLevels: ['low', 'medium', 'high'],
    });
  });

  it('enriches direct-key providers from their own catalog', async () => {
    await seedCatalog();
    const [model] = applyModelsDevMetadata(
      'unorouter',
      [def('unorouter-house', 'unorouter')],
      modelsDevKeysFor('unorouter'),
    );
    expect(model).toMatchObject({ contextWindow: 128_000, contextVerified: true });
  });

  it('leaves single-lab misses and local servers honestly unknown', async () => {
    await seedCatalog();
    // Single-lab providers never cross-match: an unknown openai id stays unknown.
    const [openaiUnknown] = applyModelsDevMetadata(
      'openai',
      [def('gpt-99-fictional', 'openai')],
      modelsDevKeysFor('openai'),
    );
    expect(openaiUnknown.contextVerified).toBeUndefined();
    expect(openaiUnknown.contextWindow).toBe(0);
    // Local servers are excluded from cross-lab guessing entirely, so a
    // self-hosted model never inherits a lab's trusted context window.
    const [local] = applyModelsDevMetadata(
      'local',
      [def('gpt-5.5', 'local')],
      modelsDevKeysFor('local'),
    );
    expect(local.contextVerified).toBeUndefined();
    expect(local.contextWindow).toBe(0);
  });

  it('never overwrites live-verified route numbers with catalog numbers', async () => {
    await seedCatalog();
    // A gateway serving gpt-5.5 under a smaller route limit: the route's own
    // verified window and tier list win, so sessions compact against the real
    // limit instead of dying on it. Missing fields still fill from catalog.
    const live: ModelDef = {
      ...def('gpt-5.5', 'commandcode'),
      name: 'Route GPT-5.5',
      contextWindow: 24576,
      contextVerified: true,
      maxOutputTokens: 4096,
      reasoningLevels: ['low'],
    };
    const [model] = applyModelsDevMetadata('commandcode', [live], modelsDevKeysFor('commandcode'));
    expect(model).toMatchObject({
      name: 'Route GPT-5.5',
      contextWindow: 24576,
      contextVerified: true,
      reasoningLevels: ['low'],
    });
    expect(model.maxOutputTokens).toBe(128_000);
  });
});
