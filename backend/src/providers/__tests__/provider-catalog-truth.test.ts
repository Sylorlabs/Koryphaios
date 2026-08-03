import { describe, expect, it } from 'bun:test';
import { PROVIDER_CONFIGS, PROVIDER_CONFIG_MAP } from '../provider-configs';
import { ProviderRegistry } from '../registry';

const NON_CHAT_SERVICES = [
  'replicate',
  'luma',
  'fal',
  'elevenlabs',
  'deepgram',
  'gladia',
  'assemblyai',
  'lmnt',
  'voyageai',
  'mixedbread',
  'mem0',
  'letta',
  'blackforestlabs',
  'klingai',
  'prodia',
] as const;

describe('built-in provider catalog truth', () => {
  it('does not advertise specialist APIs as chat-completion providers', () => {
    const names = new Set(PROVIDER_CONFIGS.map((provider) => provider.name));
    for (const name of NON_CHAT_SERVICES) expect(names.has(name)).toBe(false);
  });

  it('does not advertise GitLab Duo internal chat as public BYOK inference', () => {
    expect(PROVIDER_CONFIG_MAP.has('gitlab')).toBe(false);
  });

  it('holds back GitHub Models until its separate catalog contract is implemented', () => {
    expect(PROVIDER_CONFIG_MAP.has('github-models')).toBe(false);
  });

  it('uses the official Poe, Vercel, and Helicone gateway contracts', () => {
    expect(PROVIDER_CONFIG_MAP.get('poe')).toMatchObject({
      baseUrl: 'https://api.poe.com/v1',
      envKeys: ['POE_API_KEY'],
    });
    expect(PROVIDER_CONFIG_MAP.get('vercel')).toMatchObject({
      baseUrl: 'https://ai-gateway.vercel.sh/v1',
      envKeys: ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN'],
    });
    expect(PROVIDER_CONFIG_MAP.get('helicone')).toMatchObject({
      baseUrl: 'https://ai-gateway.helicone.ai/v1',
      envKeys: ['HELICONE_API_KEY'],
    });
  });

  it('requires user-scoped inference URLs for Cloudflare and Modal', () => {
    expect(PROVIDER_CONFIG_MAP.get('cloudflare')).toMatchObject({
      baseUrl: '',
      envUrlKey: 'CLOUDFLARE_AI_BASE_URL',
    });
    expect(PROVIDER_CONFIG_MAP.get('modal')).toMatchObject({
      baseUrl: '',
      envUrlKey: 'MODAL_ENDPOINT_URL',
    });
  });

  it('carries canonical provider base URLs into runtime provider configs', () => {
    const registry = new ProviderRegistry();
    const buildProviderConfig = (registry as unknown as {
      buildProviderConfig(name: string): { baseUrl?: string };
    }).buildProviderConfig.bind(registry);

    expect(buildProviderConfig('poe').baseUrl).toBe('https://api.poe.com/v1');
    expect(buildProviderConfig('qwen').baseUrl).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    expect(buildProviderConfig('cloudflare').baseUrl).toBe('');
    expect(buildProviderConfig('modal').baseUrl).toBe('');
  });
});
