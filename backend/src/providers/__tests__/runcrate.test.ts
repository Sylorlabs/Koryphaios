import { describe, expect, it } from 'vitest';
import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { RuncrateProvider } from '../runcrate';

/**
 * Row shapes below are copied from the live public catalog at
 * https://api.runcrate.ai/v1/models (121 rows, read 2026-11-16). Keeping the
 * real shapes means the parsing is tested against what Runcrate actually
 * serves, not a convenient fabrication.
 */
const qwenRow = {
  id: 'Qwen/Qwen3.6-27B',
  object: 'model',
  owned_by: 'Qwen',
  name: 'Qwen3.6 27B',
  input_modalities: ['text', 'image'],
  output_modalities: ['text'],
  context_length: 262144,
  max_output_length: 81920,
  pricing: {
    prompt: '0.000000336',
    completion: '0.00000336',
    input_cache_read: '0.000000336',
    input_cache_write: '0.000000336',
  },
  supported_features: ['tools', 'json_mode', 'structured_outputs', 'reasoning', 'logprobs'],
};

const whisperRow = {
  id: 'openai/whisper-large-v3',
  name: 'Whisper Large v3',
  input_modalities: ['audio'],
  output_modalities: ['text'],
  context_length: 0,
  max_output_length: 0,
  pricing: { prompt: '0.0004725', completion: '0.0004725' },
  supported_features: ['json_mode'],
};

const fluxRow = {
  id: 'black-forest-labs/FLUX.1-krea-dev',
  name: 'FLUX.1 Krea Dev',
  input_modalities: ['text'],
  output_modalities: ['image'],
  context_length: 0,
  max_output_length: 0,
  pricing: { prompt: '0.03125', completion: '0.03125', image: '0.03125' },
  supported_features: [],
};

const gptOssFreeRow = {
  id: 'openai/gpt-oss-120b',
  name: 'gpt-oss 120B',
  input_modalities: ['text'],
  output_modalities: ['text'],
  context_length: 131072,
  max_output_length: 117964,
  pricing: {
    prompt: '0.00000003885',
    completion: '0.0000001785',
    input_cache_read: '0.000000019425',
  },
  supported_features: ['tools', 'json_mode', 'structured_outputs', 'reasoning'],
  free_tier: true,
  free_allowance: { requires: 'github', paid_discount_pct: 50 },
};

function makeProvider(): RuncrateProvider {
  return new RuncrateProvider({ name: 'runcrate', baseUrl: '' } as unknown as ProviderConfig);
}

class ExposedProvider extends RuncrateProvider {
  enrich(raw: unknown, def: ModelDef): ModelDef {
    return this.enrichDiscoveredModel(raw, def);
  }

  isChat(raw: unknown, id: string): boolean {
    return this.isChatModelCandidate(raw, id);
  }
}

function bareDef(id: string): ModelDef {
  return { apiModelId: id, name: id, provider: 'runcrate' } as unknown as ModelDef;
}

describe('Runcrate catalog mapping', () => {
  it('takes the row’s real window, output limit, modalities and features', () => {
    const provider = new ExposedProvider({ name: 'runcrate', baseUrl: '' } as never);
    const def = provider.enrich(qwenRow, bareDef(qwenRow.id));
    expect(def.name).toBe('Qwen3.6 27B');
    expect(def.contextWindow).toBe(262144);
    expect(def.contextVerified).toBe(true);
    expect(def.maxOutputTokens).toBe(81920);
    expect(def.vision).toBe(true);
    expect(def.functionCall).toBe(true);
    expect(def.canReason).toBe(true);
    // USD per token in the catalog → USD per million in the picker.
    expect(def.costPerMInputTokens).toBeCloseTo(0.336, 6);
    expect(def.costPerMOutputTokens).toBeCloseTo(3.36, 6);
    expect(def.creditsLabel).toBe('$0.336 in / $3.36 out per 1M');
  });

  it('invents no window, limit or price when the row states none', () => {
    const provider = new ExposedProvider({ name: 'runcrate', baseUrl: '' } as never);
    const def = provider.enrich({ id: 'x/y' }, bareDef('x/y'));
    expect(def.contextWindow).toBeUndefined();
    expect(def.contextVerified).toBeFalsy();
    expect(def.maxOutputTokens).toBeUndefined();
    expect(def.costPerMInputTokens).toBeUndefined();
    expect(def.costPerMOutputTokens).toBeUndefined();
    expect(def.canReason).toBeFalsy();
  });

  it('treats free_tier as an allowance, never as a zero price', () => {
    const provider = new ExposedProvider({ name: 'runcrate', baseUrl: '' } as never);
    const def = provider.enrich(gptOssFreeRow, bareDef(gptOssFreeRow.id));
    expect(def.costPerMInputTokens).toBeCloseTo(0.03885, 6);
    expect(def.costPerMOutputTokens).toBeCloseTo(0.1785, 6);
    expect(def.creditsLabel).not.toMatch(/free/i);
  });

  it('keeps non-chat catalog rows out of the picker', () => {
    const provider = new ExposedProvider({ name: 'runcrate', baseUrl: '' } as never);
    expect(provider.isChat(qwenRow, qwenRow.id)).toBe(true);
    // Text output but audio input and no tool support: an ASR model.
    expect(provider.isChat(whisperRow, whisperRow.id)).toBe(false);
    // Image generation is not a chat model even though its prompt is text.
    expect(provider.isChat(fluxRow, fluxRow.id)).toBe(false);
    expect(
      provider.isChat({ id: 'BAAI/bge-m3', output_modalities: ['embeddings'] }, 'BAAI/bge-m3'),
    ).toBe(false);
  });

  it('requires an rc_live_ key and points at the key page without one', () => {
    const bare = makeProvider();
    expect(bare.isAvailable()).toBe(false);
    expect(bare.getModelDiscoveryError()).toContain('rc_live_');
    const keyed = new RuncrateProvider({
      name: 'runcrate',
      baseUrl: '',
      apiKey: 'rc_live_test',
    } as unknown as ProviderConfig);
    expect(keyed.isAvailable()).toBe(true);
    expect(keyed.getModelDiscoveryError()).toBeUndefined();
  });
});
