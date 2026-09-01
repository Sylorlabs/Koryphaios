import { describe, expect, it } from 'bun:test';
import type { ProviderConfig, ProviderName } from '@koryphaios/shared';
import { PROVIDER_CONFIGS, PROVIDER_CONFIG_MAP } from '../provider-configs';
import {
  DEDICATED_CAPABILITY_PROVIDER_NAMES,
  ProviderRegistry,
  UNSUPPORTED_CHAT_PROVIDER_NAMES,
} from '../registry';

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

  it('uses the official TokenRouter gateway contract', () => {
    expect(PROVIDER_CONFIG_MAP.get('tokenrouter')).toMatchObject({
      baseUrl: 'https://api.tokenrouter.io/v1',
      envKeys: ['TOKENROUTER_API_KEY'],
    });
  });

  it('migrates TokenRouter configs persisted with the retired gateway host', () => {
    const registry = Object.create(ProviderRegistry.prototype) as ProviderRegistry;
    Object.assign(registry, {
      config: {
        server: { port: 3001, host: '127.0.0.1' },
        providers: {
          tokenrouter: {
            name: 'tokenrouter',
            baseUrl: 'https://tokenrouter.me/v1',
            disabled: true,
          },
        },
      },
    });
    const buildProviderConfig = (
      registry as unknown as {
        buildProviderConfig(name: ProviderName): ProviderConfig;
      }
    ).buildProviderConfig.bind(registry);

    expect(buildProviderConfig('tokenrouter').baseUrl).toBe('https://api.tokenrouter.io/v1');
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
      if (DEDICATED_CAPABILITY_PROVIDER_NAMES.has(name)) continue;
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

  it('reports dedicated voice adapters as configurable without exposing a chat adapter', () => {
    const registry = Object.create(ProviderRegistry.prototype) as ProviderRegistry;
    const config: ProviderConfig = {
      name: 'deepgram',
      apiKey: 'configured-key',
      baseUrl: PROVIDER_CONFIG_MAP.get('deepgram')?.baseUrl,
      disabled: false,
    };
    Object.assign(registry, {
      providers: new Map(),
      providerConfigs: new Map([['deepgram', config]]),
      circuitStates: new Map(),
      customProviderIds: new Set(),
      verificationRecords: new Map([
        ['deepgram', { state: 'verified', checkedAt: Date.now(), scope: 'credential' }],
      ]),
    });

    const status = registry.getStatus().find((entry) => entry.name === 'deepgram');
    expect(status).toMatchObject({
      authenticated: true,
      adapterAvailable: false,
      supportsApiKey: true,
    });
    expect(status?.configurationBlocked).toBeUndefined();
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
    const replicateConfig: ProviderConfig = {
      name: 'replicate',
      apiKey: 'present-but-not-a-chat-contract',
      baseUrl: PROVIDER_CONFIG_MAP.get('replicate')?.baseUrl,
      disabled: false,
    };
    Object.assign(registry, {
      providers: new Map([['jules', createProvider('jules', julesConfig)]]),
      providerConfigs: new Map([
        ['jules', julesConfig],
        ['replicate', replicateConfig],
      ]),
      circuitStates: new Map(),
      customProviderIds: new Set(),
      verificationRecords: new Map(),
    });
    const statuses = registry.getStatus();
    for (const name of ['jules', 'replicate'] as const) {
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
