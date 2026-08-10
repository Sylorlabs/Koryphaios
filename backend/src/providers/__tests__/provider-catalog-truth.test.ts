import { describe, expect, it } from 'bun:test';
import type { ProviderConfig, ProviderName } from '@koryphaios/shared';
import { PROVIDER_CONFIGS, PROVIDER_CONFIG_MAP } from '../provider-configs';
import { ProviderRegistry, UNSUPPORTED_CHAT_PROVIDER_NAMES } from '../registry';

const EXPECTED_NON_CHAT_PROVIDERS: ProviderName[] = [
  'replicate',
  'modal',
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
];

describe('built-in provider catalog truth', () => {
  it('every provider config has a name, baseUrl, and authMode', () => {
    for (const cfg of PROVIDER_CONFIGS) {
      expect(typeof cfg.name).toBe('string');
      expect(typeof cfg.baseUrl).toBe('string');
      expect(cfg.authMode).toBeDefined();
    }
  });

  it('uses the official Poe gateway contract', () => {
    expect(PROVIDER_CONFIG_MAP.get('poe')).toMatchObject({
      baseUrl: 'https://api.poe.com/v1',
      envKeys: ['POE_API_KEY'],
    });
  });

  it('provider names are unique', () => {
    const names = PROVIDER_CONFIGS.map((p) => p.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('blocks every audited non-chat API from the generic chat adapter', async () => {
    expect([...UNSUPPORTED_CHAT_PROVIDER_NAMES].sort()).toEqual(
      [...EXPECTED_NON_CHAT_PROVIDERS].sort(),
    );
    const registry = Object.create(ProviderRegistry.prototype) as ProviderRegistry;
    Object.assign(registry, {
      providerConfigs: new Map(),
      verificationRecords: new Map(),
      customProviderIds: new Set(),
    });
    const createProvider = (
      registry as unknown as { createProvider(name: ProviderName, config: ProviderConfig): unknown }
    ).createProvider.bind(registry);
    for (const name of EXPECTED_NON_CHAT_PROVIDERS) {
      const config: ProviderConfig = {
        name,
        apiKey: 'test-key-that-must-not-enable-chat',
        baseUrl: PROVIDER_CONFIG_MAP.get(name)?.baseUrl ?? 'https://example.invalid/v1',
        disabled: false,
      };
      expect(createProvider(name, config), `${name} must not get a chat provider`).toBeNull();
      const verification = await registry.verifyConnection(name, {
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
      });
      expect(verification.success).toBe(false);
      expect(verification.error).toContain('not available as a chat provider');
      const connection = await registry.setCredentials(name, {
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
      });
      expect(connection.success).toBe(false);
      expect(connection.error).toBe(verification.error);
    }
  });

  it('reports blocked modalities and mutation-capable adapters as unavailable, not ready', () => {
    const registry = Object.create(ProviderRegistry.prototype) as ProviderRegistry;
    const createProvider = (
      registry as unknown as { createProvider(name: ProviderName, config: ProviderConfig): unknown }
    ).createProvider.bind(registry);
    Object.assign(registry, { customProviderIds: new Set() });
    const julesConfig: ProviderConfig = {
      name: 'jules',
      apiKey: 'present-but-not-approved',
      disabled: false,
    };
    const kiloConfig: ProviderConfig = {
      name: 'kilocode',
      authToken: 'detected-cli-login',
      disabled: false,
    };
    const replicateConfig: ProviderConfig = {
      name: 'replicate',
      apiKey: 'present-but-not-a-chat-contract',
      baseUrl: PROVIDER_CONFIG_MAP.get('replicate')?.baseUrl,
      disabled: false,
    };
    Object.assign(registry, {
      providers: new Map([
        ['jules', createProvider('jules', julesConfig)],
        ['kilocode', createProvider('kilocode', kiloConfig)],
      ]),
      providerConfigs: new Map([
        ['jules', julesConfig],
        ['kilocode', kiloConfig],
        ['replicate', replicateConfig],
      ]),
      circuitStates: new Map(),
      customProviderIds: new Set(),
      verificationRecords: new Map(),
    });
    const statuses = registry.getStatus();
    for (const name of ['jules', 'kilocode', 'replicate'] as const) {
      const status = statuses.find((entry) => entry.name === name);
      expect(status?.authenticated).toBe(false);
      expect(status?.supportsApiKey).toBe(false);
      expect(status?.supportsAuthToken).toBe(false);
      expect(status?.requiresBaseUrl).toBe(false);
      expect(status?.configurationBlocked).toBe(true);
      expect(status?.error).toBeTruthy();
    }
  });
});
