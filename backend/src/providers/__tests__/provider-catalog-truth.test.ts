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
      baseUrl: 'https://api.tokenrouter.com/v1',
      envKeys: ['TOKENROUTER_API_KEY'],
    });
  });

  it('ignores a persisted provider entry whose built-in name no longer exists', () => {
    const registry = new ProviderRegistry({
      providers: {
        'retired-provider': {
          name: 'retired-provider',
          apiKey: 'stale-key',
          disabled: false,
        },
      },
      server: { port: 3001, host: '127.0.0.1' },
    } as any);
    expect(registry.getStatus().find((entry) => entry.name === 'retired-provider')).toBeUndefined();
    expect(registry.get('retired-provider' as ProviderName)).toBeUndefined();
  });

  it('preserves the configured origin of a custom provider across registry hydration', () => {
    const registry = Object.create(ProviderRegistry.prototype) as ProviderRegistry;
    Object.assign(registry, {
      config: {
        server: { port: 3001, host: '127.0.0.1' },
        providers: {
          'custom:retired-gateway': {
            name: 'custom:retired-gateway',
            custom: true,
            kind: 'openai',
            baseUrl: 'https://gateway.example.com/v1',
            disabled: false,
          },
        },
      },
    });
    const buildProviderConfig = (
      registry as unknown as {
        buildProviderConfig(name: ProviderName): ProviderConfig;
      }
    ).buildProviderConfig.bind(registry);

    expect(buildProviderConfig('custom:retired-gateway').baseUrl).toBe('https://gateway.example.com/v1');
  });

  it('uses the official UnoRouter gateway contract', () => {
    expect(PROVIDER_CONFIG_MAP.get('unorouter')).toMatchObject({
      baseUrl: 'https://api.unorouter.com/v1',
      authMode: 'api_key',
      envKeys: ['UNOROUTER_API_KEY'],
    });
  });

  it('uses the official Experiential Labs gateway contract', () => {
    expect(PROVIDER_CONFIG_MAP.get('experientiallabs')).toMatchObject({
      baseUrl: 'https://api.experientiallabs.ai/v1',
      authMode: 'api_key',
      envKeys: ['EXPERIENTIALLABS_API_KEY', 'EXPLABS_API_KEY'],
    });
  });

  it('uses the official Vyce AI OpenAI-compatible gateway contract', () => {
    expect(PROVIDER_CONFIG_MAP.get('vyceai')).toMatchObject({
      baseUrl: 'https://vyceai.com/v1',
      authMode: 'api_key',
      envKeys: ['VYCEAI_API_KEY', 'VYCE_AI_API_KEY'],
    });
  });

  it('uses the official Command Code OpenAI-compatible gateway contract', () => {
    expect(PROVIDER_CONFIG_MAP.get('commandcode')).toMatchObject({
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      authMode: 'api_key',
      envKeys: ['COMMAND_CODE_API_KEY'],
    });
  });

  it('uses the official WorkBuddy TokenHub gateway contract', () => {
    expect(PROVIDER_CONFIG_MAP.get('workbuddy')).toMatchObject({
      baseUrl: 'https://tokenhub-intl.tencentcloudmaas.com/v1',
      envKeys: ['WORKBUDDY_API_KEY'],
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

    expect(buildProviderConfig('tokenrouter').baseUrl).toBe('https://api.tokenrouter.com/v1');
  });

  it('migrates TokenRouter configs persisted with the retired .io default host', () => {
    // Older builds shipped api.tokenrouter.io as the default and may have
    // persisted it; it must be treated as "no explicit override" too.
    const registry = Object.create(ProviderRegistry.prototype) as ProviderRegistry;
    Object.assign(registry, {
      config: {
        server: { port: 3001, host: '127.0.0.1' },
        providers: {
          tokenrouter: {
            name: 'tokenrouter',
            baseUrl: 'https://api.tokenrouter.io/v1',
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

    expect(buildProviderConfig('tokenrouter').baseUrl).toBe('https://api.tokenrouter.com/v1');
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

  it('reports media and memory capability adapters as configurable without a chat adapter', () => {
    // These providers have no chat-completions contract, so they must stay
    // absent from the chat picker while still being verifiable and configurable
    // through their dedicated capability adapter.
    const registry = Object.create(ProviderRegistry.prototype) as ProviderRegistry;
    const configs = new Map<ProviderName, ProviderConfig>();
    for (const name of [
      'replicate',
      'luma',
      'klingai',
      'prodia',
      'lmnt',
      'voyageai',
      'mem0',
      'letta',
    ] as const) {
      configs.set(name, {
        name,
        apiKey: 'configured-key',
        baseUrl: PROVIDER_CONFIG_MAP.get(name)?.baseUrl,
        disabled: false,
      });
    }
    Object.assign(registry, {
      providers: new Map(),
      providerConfigs: configs,
      circuitStates: new Map(),
      customProviderIds: new Set(),
      verificationRecords: new Map(
        [...configs.keys()].map((name) => [
          name,
          { state: 'verified', checkedAt: Date.now(), scope: 'credential' },
        ]),
      ),
    });

    const statuses = registry.getStatus();
    for (const name of configs.keys()) {
      const status = statuses.find((entry) => entry.name === name);
      expect(status, name).toMatchObject({
        authenticated: true,
        adapterAvailable: false,
        supportsApiKey: true,
      });
      // Configurable through its capability adapter, not blocked.
      expect(status?.configurationBlocked, name).toBeUndefined();
    }
  });
});
