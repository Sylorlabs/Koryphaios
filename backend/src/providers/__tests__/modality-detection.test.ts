import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ModelDef } from '@koryphaios/shared';

interface ProviderStub {
  listModels(): ModelDef[];
}

const state: {
  configs: Record<string, { apiKey?: string; disabled?: boolean; label?: string }>;
  providers: Record<string, ProviderStub>;
} = { configs: {}, providers: {} };

mock.module('../../context', () => ({
  getContext: () => ({
    providers: {
      getConfigs: () => state.configs,
      get: (name: string) => state.providers[name],
    },
  }),
}));

const { detectMediaProviders, emitsModality } = await import('../modality-detection');

function model(id: string, outputModalities?: string[]): ModelDef {
  return {
    id,
    name: id,
    provider: 'openrouter',
    contextWindow: 8192,
    maxOutputTokens: 1024,
    ...(outputModalities ? { outputModalities } : {}),
  } as ModelDef;
}

/** A provider that the detection module must never treat as a media producer. */
function textOnly(): ProviderStub {
  return { listModels: () => [model('gpt-5', ['text'])] };
}

beforeEach(() => {
  state.configs = {};
  state.providers = {};
});

describe('detectMediaProviders', () => {
  test('a text-only catalog yields no image models', () => {
    state.configs.openrouter = { apiKey: 'sk-test' };
    state.providers.openrouter = textOnly();

    const [entry] = detectMediaProviders('image');
    expect(entry?.provider).toBe('openrouter');
    expect(entry?.models).toEqual([]);
    // The catalog does publish modalities, so it is classifiable — the caller
    // must not fall back to its own declared list for it.
    expect(entry?.reportsModalities).toBe(true);
  });

  test('a video model is never offered as an image model', () => {
    state.configs.openrouter = { apiKey: 'sk-test' };
    state.providers.openrouter = {
      listModels: () => [model('veo-3', ['text', 'video']), model('gemini-image', ['image'])],
    };

    const [entry] = detectMediaProviders('image');
    expect(entry?.models.map((m) => m.id)).toEqual(['gemini-image']);
  });

  test('an image model is never offered as a video model', () => {
    state.configs.openrouter = { apiKey: 'sk-test' };
    state.providers.openrouter = {
      listModels: () => [model('veo-3', ['video']), model('gemini-image', ['image'])],
    };

    const [entry] = detectMediaProviders('video');
    expect(entry?.models.map((m) => m.id)).toEqual(['veo-3']);
  });

  test('modalities are matched case-insensitively', () => {
    state.configs.google = { apiKey: 'g-test' };
    state.providers.google = { listModels: () => [model('imagen-4', ['IMAGE'])] };

    const [entry] = detectMediaProviders('image');
    expect(entry?.models.map((m) => m.id)).toEqual(['imagen-4']);
  });

  test('a disabled provider is skipped', () => {
    state.configs.disabled = { apiKey: 'sk-test', disabled: true };
    state.providers.disabled = { listModels: () => [model('gemini-image', ['image'])] };

    expect(detectMediaProviders('image')).toEqual([]);
  });

  test('a throwing or missing catalog degrades to no models instead of throwing', () => {
    state.configs.throwing = { apiKey: 'sk-test' };
    state.providers.throwing = {
      listModels: () => {
        throw new Error('catalog is down');
      },
    };
    state.configs.missing = { apiKey: 'sk-test' };

    expect(() => detectMediaProviders('image')).not.toThrow();
    expect(detectMediaProviders('image')).toEqual([]);
  });

  test('a provider with no reported modalities is flagged as unclassified', () => {
    state.configs.local = { label: 'Local endpoint', baseUrl: 'http://127.0.0.1:1234/v1' };
    state.providers.local = { listModels: () => [model('sd-turbo')] };

    const [entry] = detectMediaProviders('image');
    expect(entry).toMatchObject({
      provider: 'local',
      label: 'Local endpoint',
      models: [],
      configured: true,
      reportsModalities: false,
    });
  });

  test('emitsModality requires the exact reported modality', () => {
    expect(emitsModality(model('x', ['text', 'image']), 'image')).toBe(true);
    expect(emitsModality(model('x', ['text', 'image']), 'video')).toBe(false);
    expect(emitsModality(model('x'), 'image')).toBe(false);
  });
});
