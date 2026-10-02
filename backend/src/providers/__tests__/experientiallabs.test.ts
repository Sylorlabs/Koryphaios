import { afterEach, describe, expect, it } from 'bun:test';
import type { ProviderConfig } from '@koryphaios/shared';
import { ExperientialLabsProvider } from '../openai';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function config(): ProviderConfig {
  return {
    name: 'experientiallabs',
    apiKey: 'xpl_synthetic-test-key',
    baseUrl: 'https://api.experientiallabs.ai/v1',
    disabled: false,
  } as ProviderConfig;
}

function catalogRow(overrides: Record<string, unknown> = {}) {
  return {
    model: {
      slug: 'claude-fable-5.1',
      display_name: 'Claude Fable 5.1',
      context_window: 1_000_000,
      max_output_tokens: 128_000,
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      supported_params: { stop: true, tools: true, reasoning: true, structured_outputs: true },
    },
    providers: [
      {
        provider: 'experiential_cloud',
        billing_source: 'host_managed',
        input_nano_usd_per_million: 10_000_000_000,
        cached_input_nano_usd_per_million: 250_000_000,
        output_nano_usd_per_million: 50_000_000_000,
        pricing_source: 'provider-docs',
        capabilities: {
          supports_reasoning: true,
          supported_reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          maximum_output_tokens: 128_000,
        },
      },
    ],
    ...overrides,
  };
}

/** Route /v1/models to the slug list and /api/models to the rich catalog. */
function mockGateway(slugs: Array<Record<string, unknown>>, rows: unknown[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ models: rows, total: rows.length }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ object: 'list', data: slugs }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('ExperientialLabsProvider catalog merge', () => {
  it('merges the public catalog row into the callable slug', async () => {
    mockGateway([{ id: 'claude-fable-5.1' }], [catalogRow()]);
    const provider = new ExperientialLabsProvider(config());
    await provider.refreshModels(true);
    const models = provider.listModels();
    expect(models.map((m) => m.id)).toEqual(['claude-fable-5.1']);
    expect(models[0]).toMatchObject({
      name: 'Claude Fable 5.1',
      contextWindow: 1_000_000,
      contextVerified: true,
      maxOutputTokens: 128_000,
      vision: true,
      supportsAttachments: true,
      canReason: true,
      reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      costPerMInputTokens: 10,
      costPerMOutputTokens: 50,
      costPerMInputCached: 0.25,
    });
  });

  it('keeps provider-reported effort tiers it has never seen instead of dropping them', async () => {
    const row = catalogRow();
    row.providers = [
      {
        ...(row.providers as Array<Record<string, unknown>>)[0],
        capabilities: {
          supports_reasoning: true,
          supported_reasoning_efforts: ['low', 'medium', 'ultra'],
          maximum_output_tokens: 128_000,
        },
      },
    ];
    mockGateway([{ id: 'claude-fable-5.1' }], [row]);
    const provider = new ExperientialLabsProvider(config());
    await provider.refreshModels(true);
    const model = provider.listModels()[0];
    expect(model.canReason).toBe(true);
    expect(model.reasoningLevels).toEqual(['low', 'medium', 'ultra']);
  });

  it('keeps callable slugs with no catalog row as generic models', async () => {
    mockGateway([{ id: 'my-custom-local' }], [catalogRow()]);
    const provider = new ExperientialLabsProvider(config());
    await provider.refreshModels(true);
    const models = provider.listModels();
    expect(models.map((m) => m.id)).toEqual(['my-custom-local']);
    expect(models[0].contextVerified).toBeUndefined();
  });

  it('ignores estimate-only pricing instead of attributing guessed costs', async () => {
    const row = catalogRow();
    row.providers = [
      {
        ...(row.providers as Array<Record<string, unknown>>)[0],
        pricing_source: 'estimate',
      },
    ];
    mockGateway([{ id: 'claude-fable-5.1' }], [row]);
    const provider = new ExperientialLabsProvider(config());
    await provider.refreshModels(true);
    const model = provider.listModels()[0];
    // Estimate-only rows are display-only: costs stay at the generic unknown
    // default instead of attributing guessed prices.
    expect(model.costPerMInputTokens).toBe(0);
    expect(model.costPerMOutputTokens).toBe(0);
    // Capability metadata is still real and still ingested.
    expect(model.contextWindow).toBe(1_000_000);
    expect(model.reasoningLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('filters non-chat slugs from the callable list', async () => {
    mockGateway([{ id: 'whisper-large-v3' }, { id: 'claude-fable-5.1' }], [catalogRow()]);
    const provider = new ExperientialLabsProvider(config());
    await provider.refreshModels(true);
    expect(provider.listModels().map((m) => m.id)).toEqual(['claude-fable-5.1']);
  });

  it('leaves the catalog empty rather than throwing when the gateway is unreachable', async () => {
    globalThis.fetch = (async () => {
      throw new Error('connection refused');
    }) as typeof fetch;
    const provider = new ExperientialLabsProvider(config());
    await provider.refreshModels(true);
    expect(provider.listModels()).toEqual([]);
  });
});
