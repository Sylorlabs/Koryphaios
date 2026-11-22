import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  IMPLEMENTED_PROVIDERS,
  PROVIDER_AUTH_MODES,
  PROVIDER_ENV_VARS,
  ProviderName,
  providerSupport,
  type KoryphaiosConfig,
} from '@koryphaios/shared';
import { ProviderName as CompatibilityProviderName } from '../../../../shared/src/providers';
import { isValidProvider } from '../../../../shared/src/providers/ProviderNames';
import { ProviderNameSchema } from '../../validation/schemas';
import { catalogRefreshTier } from '../catalog-refresh';
import { providerDefaultBaseUrl } from '../constants';
import { OpenAIProvider } from '../openai';
import { PROVIDER_CONFIGS, PROVIDER_CONFIG_MAP } from '../provider-configs';
import { getProviderDisplay } from '../provider-display';
import { ProviderRegistry } from '../registry';

const BASE_URL = 'https://api.reflection.ai/openai/v1';
const TEST_KEY = 'synthetic-reflection-key';
const originalFetch = globalThis.fetch;
const originalDisableCli = process.env.KORY_DISABLE_CLI_AUTODETECT;
const originalApiKey = process.env.REFLECTION_API_KEY;

function config(providers: KoryphaiosConfig['providers'] = {}): KoryphaiosConfig {
  return { server: { port: 3001, host: '127.0.0.1' }, providers };
}

beforeEach(() => {
  process.env.KORY_DISABLE_CLI_AUTODETECT = '1';
  delete process.env.REFLECTION_API_KEY;
  globalThis.fetch = (async () => Response.json({ object: 'list', data: [] })) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDisableCli === undefined) delete process.env.KORY_DISABLE_CLI_AUTODETECT;
  else process.env.KORY_DISABLE_CLI_AUTODETECT = originalDisableCli;
  if (originalApiKey === undefined) delete process.env.REFLECTION_API_KEY;
  else process.env.REFLECTION_API_KEY = originalApiKey;
});

describe('Reflection AI registration', () => {
  it('registers the stable ID across shared definitions and API validation', () => {
    expect(ProviderName.Beam).toBe('beam');
    expect(CompatibilityProviderName.Beam).toBe('beam');
    expect(isValidProvider('beam')).toBe(true);
    expect(IMPLEMENTED_PROVIDERS).toContain('beam');
    expect(ProviderNameSchema.parse('beam')).toBe('beam');
    expect(ProviderNameSchema.safeParse('reflection').success).toBe(false);
    expect(PROVIDER_AUTH_MODES.beam).toBe('api_key');
    expect(PROVIDER_ENV_VARS.beam).toEqual({ apiKey: 'REFLECTION_API_KEY' });
    expect(PROVIDER_CONFIGS.filter((entry) => entry.name === 'beam')).toHaveLength(1);
    expect(PROVIDER_CONFIG_MAP.get('beam')).toEqual({
      name: 'beam',
      baseUrl: BASE_URL,
      authMode: 'api_key',
      envKeys: ['REFLECTION_API_KEY'],
    });
    expect(providerDefaultBaseUrl('beam')).toBe(BASE_URL);
    expect(catalogRefreshTier('beam')).toBe('cheap');
    expect(providerSupport('beam')).toMatchObject({
      tier: 'preview',
      capabilities: ['chat'],
      evidence: 'openai-compatible-contract',
    });
  });

  it('exposes the API-key and endpoint fields with official display metadata', () => {
    const registry = new ProviderRegistry(config());
    expect(registry.getAvailableProviderTypes()).toContainEqual({
      name: 'beam',
      authMode: 'api_key',
    });
    expect(getProviderDisplay('beam')).toMatchObject({
      label: 'Reflection AI',
      iconPath: '/provider-icons/reflection.svg',
      deployment: 'api',
      credentialUrl: 'https://platform.reflection.ai/api-keys',
    });
    expect(registry.getStatus().find((entry) => entry.name === 'beam')).toMatchObject({
      label: 'Reflection AI',
      authMode: 'api_key',
      supportsApiKey: true,
      supportsAuthToken: false,
      requiresBaseUrl: false,
      endpointUrl: BASE_URL,
      modelCatalogUrl: `${BASE_URL}/models`,
      authenticated: false,
      allAvailableModels: [],
    });
    expect(registry.get('beam')).toBeUndefined();
  });

  it('resolves REFLECTION_API_KEY into the generic OpenAI provider after opt-in', async () => {
    process.env.REFLECTION_API_KEY = TEST_KEY;
    const registry = new ProviderRegistry(config({ beam: { name: 'beam', disabled: false } }));
    const provider = registry.get('beam');
    expect(provider?.constructor).toBe(OpenAIProvider);
    expect(provider?.config).toMatchObject({ name: 'beam', apiKey: TEST_KEY, baseUrl: BASE_URL });
    await provider!.refreshModels(true);
    expect(provider!.listModels()).toEqual([]);
  });

  for (const baseUrl of [undefined, 'https://reflection-proxy.example/openai/v1']) {
    it(`verifies Bearer credentials through ${baseUrl ? 'an explicit endpoint' : 'the default endpoint'}`, async () => {
      const requests: Request[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return Response.json({ object: 'list', data: [{ id: 'synthetic-beam-model' }] });
      }) as typeof fetch;
      const registry = new ProviderRegistry(config());
      expect((await registry.verifyConnection('beam', { apiKey: TEST_KEY, baseUrl })).success).toBe(
        true,
      );
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe(`${baseUrl ?? BASE_URL}/models`);
      expect(requests[0].method).toBe('GET');
      expect(requests[0].headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`);
    });
  }

  it('preserves an explicit endpoint in runtime configuration and status', async () => {
    const baseUrl = 'https://reflection-proxy.example/openai/v1';
    const registry = new ProviderRegistry(
      config({ beam: { name: 'beam', apiKey: TEST_KEY, baseUrl, disabled: false } }),
    );
    const provider = registry.get('beam');
    expect(provider?.constructor).toBe(OpenAIProvider);
    expect(provider?.config.baseUrl).toBe(baseUrl);
    await provider!.refreshModels(true);
    expect(registry.getStatus().find((entry) => entry.name === 'beam')).toMatchObject({
      endpointUrl: baseUrl,
      modelCatalogUrl: `${baseUrl}/models`,
    });
  });

  it('rejects missing or refused credentials', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({ error: { message: 'Invalid API key' } }, { status: 401 });
    }) as typeof fetch;
    const registry = new ProviderRegistry(config());
    expect((await registry.verifyConnection('beam', {})).success).toBe(false);
    expect(calls).toBe(0);
    expect((await registry.verifyConnection('beam', { apiKey: TEST_KEY })).success).toBe(false);
    expect(calls).toBe(1);
  });

  it('does not treat an empty catalog as verified model access', async () => {
    const registry = new ProviderRegistry(config());
    expect((await registry.verifyConnection('beam', { apiKey: TEST_KEY })).success).toBe(false);
  });
});
