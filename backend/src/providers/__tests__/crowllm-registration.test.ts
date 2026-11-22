import { describe, expect, it } from 'bun:test';
import {
  IMPLEMENTED_PROVIDERS,
  PROVIDER_AUTH_MODES,
  PROVIDER_ENV_VARS,
  ProviderName,
  providerSupport,
} from '@koryphaios/shared';
import { ProviderName as CompatibilityProviderName } from '../../../../shared/src/providers';
import { isValidProvider } from '../../../../shared/src/providers/ProviderNames';
import { ProviderNameSchema } from '../../validation/schemas';
import { getVerifyUrl } from '../api-endpoints';
import { catalogRefreshTier } from '../catalog-refresh';
import { providerDefaultBaseUrl } from '../constants';
import { PROVIDER_CONFIG_MAP } from '../provider-configs';
import { getProviderDisplay } from '../provider-display';

const BASE_URL = 'https://crowllm.com/v1';

describe('CrowLLM registration', () => {
  it('registers the stable ID across shared definitions and API validation', () => {
    expect(ProviderName.CrowLLM).toBe('crowllm');
    expect(CompatibilityProviderName.CrowLLM).toBe('crowllm');
    expect(isValidProvider('crowllm')).toBe(true);
    expect(IMPLEMENTED_PROVIDERS).toContain('crowllm');
    expect(ProviderNameSchema.parse('crowllm')).toBe('crowllm');
    expect(ProviderNameSchema.safeParse('crow').success).toBe(false);
    expect(PROVIDER_AUTH_MODES.crowllm).toBe('api_key');
    expect(PROVIDER_ENV_VARS.crowllm).toEqual({ apiKey: 'CROWLLM_API_KEY' });
    expect(PROVIDER_CONFIG_MAP.get('crowllm')).toEqual({
      name: 'crowllm',
      baseUrl: BASE_URL,
      authMode: 'api_key',
      envKeys: ['CROWLLM_API_KEY'],
    });
    expect(providerDefaultBaseUrl('crowllm')).toBe(BASE_URL);
    expect(catalogRefreshTier('crowllm')).toBe('cheap');
    expect(providerSupport('crowllm')).toMatchObject({
      tier: 'preview',
      capabilities: ['chat', 'gateway'],
      evidence: 'openai-compatible-contract',
    });
  });

  it('exposes display metadata and verifies through the public model catalog', () => {
    expect(getProviderDisplay('crowllm')).toMatchObject({
      label: 'CrowLLM',
      iconPath: '/provider-icons/crowllm.svg',
      deployment: 'api',
      credentialUrl: 'https://crowllm.com/keys',
    });
    expect(getVerifyUrl('crowllm')).toBe(`${BASE_URL}/models`);
    expect(getVerifyUrl('crowllm', 'https://crowllm.example/v1')).toBe(
      'https://crowllm.example/v1/models',
    );
  });
});
