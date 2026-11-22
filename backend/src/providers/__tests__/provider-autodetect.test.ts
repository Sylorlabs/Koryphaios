import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KoryphaiosConfig } from '@koryphaios/shared';
import { ProviderRegistry } from '../registry';
import { providerEnvNamesForHydration } from '../provider-autodetect';
import { syncProviderConfigsToConfig } from '../../runtime/config';
import { loadProviderSecrets } from '../../security/secret-store';

process.env.NODE_ENV = 'test';
setDefaultTimeout(30000);

function minimalConfig(providers: KoryphaiosConfig['providers'] = {}): KoryphaiosConfig {
  return {
    providers,
    agents: {
      manager: { model: 'claude-sonnet-4-5' },
      coder: { model: 'claude-sonnet-4-5' },
      task: { model: 'o4-mini' },
    },
    server: { port: 3000, host: 'localhost' },
    dataDirectory: '.koryphaios-test',
  };
}

const realFetch = globalThis.fetch;

// Snapshot every env var that could supply connection material so the host's
// real exports can never leak a provider into the pass.
const ISOLATED_ENV_NAMES = [
  ...providerEnvNamesForHydration(),
  'KORY_DISABLE_CLI_AUTODETECT',
  'KORY_DISABLE_PROVIDER_AUTODETECT',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
];
const savedEnv = new Map<string, string | undefined>();
const requestedUrls: string[] = [];

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requestedUrls.push(url);
    return handler(url);
  }) as typeof fetch;
}

beforeEach(() => {
  requestedUrls.length = 0;
  for (const name of ISOLATED_ENV_NAMES) {
    savedEnv.set(name, process.env[name]);
    delete process.env[name];
  }
  // AWS file-path overrides the SDK/credential scan understands: no real
  // ~/.aws content may leak into the Bedrock candidate check.
  process.env.AWS_SHARED_CREDENTIALS_FILE = join(tmpdir(), 'kory-autodetect-no-aws-credentials');
  process.env.AWS_CONFIG_FILE = join(tmpdir(), 'kory-autodetect-no-aws-config');
  // Keep the CLI auto-enable path inert while the registry constructs; tests
  // delete the flag before invoking autoDetectProviders.
  process.env.KORY_DISABLE_CLI_AUTODETECT = '1';
  stubFetch(() => new Response('not found', { status: 404 }));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const name of ISOLATED_ENV_NAMES) {
    const prev = savedEnv.get(name);
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
  savedEnv.clear();
});

describe('provider auto-detection', () => {
  it('connects a provider whose env API key verifies', async () => {
    process.env.OPENAI_API_KEY = 'sk-autodetect-test';
    stubFetch((url) =>
      url === 'https://api.openai.com/v1/models'
        ? Response.json({ data: [{ id: 'synthetic-gpt' }] })
        : new Response('not found', { status: 404 }),
    );
    const registry = new ProviderRegistry(minimalConfig());
    delete process.env.KORY_DISABLE_CLI_AUTODETECT;

    expect(await registry.autoDetectProviders()).toBe(true);

    const status = registry.getStatus().find((entry) => entry.name === 'openai');
    expect(status?.enabled).toBe(true);
    expect(status?.connectionState).toBe('verified');
    expect(status?.autoDetectedSource).toBe('OPENAI_API_KEY');
    const config = registry.getConfigs().openai;
    expect(config?.disabled).toBe(false);
    expect(config?.autoDetected).toBe(true);
  });

  it('leaves the provider disabled when the env key fails verification', async () => {
    process.env.OPENAI_API_KEY = 'sk-autodetect-bad';
    stubFetch(() => Response.json({ error: { message: 'Invalid key' } }, { status: 401 }));
    const registry = new ProviderRegistry(minimalConfig());
    delete process.env.KORY_DISABLE_CLI_AUTODETECT;

    expect(await registry.autoDetectProviders()).toBe(false);

    const config = registry.getConfigs().openai;
    expect(config?.disabled).toBe(true);
    // The failed probe must not retain the env credential in config.
    expect(config?.apiKey).toBeUndefined();
    expect(config?.autoDetected).toBeUndefined();
    const status = registry.getStatus().find((entry) => entry.name === 'openai');
    expect(status?.enabled).toBe(false);
    expect(status?.autoDetectedSource).toBeUndefined();
  });

  it('never probes a provider the user disabled in config', async () => {
    process.env.OPENAI_API_KEY = 'sk-autodetect-test';
    const registry = new ProviderRegistry(
      minimalConfig({ openai: { name: 'openai', disabled: true } }),
    );
    delete process.env.KORY_DISABLE_CLI_AUTODETECT;

    await registry.autoDetectProviders(true);

    expect(requestedUrls.some((url) => url.includes('api.openai.com'))).toBe(false);
    expect(registry.getConfigs().openai?.disabled).toBe(true);
  });

  it('does not reconnect after an in-session disconnect, even when forced', async () => {
    process.env.OPENAI_API_KEY = 'sk-autodetect-test';
    stubFetch((url) =>
      url === 'https://api.openai.com/v1/models'
        ? Response.json({ data: [{ id: 'synthetic-gpt' }] })
        : new Response('not found', { status: 404 }),
    );
    const registry = new ProviderRegistry(minimalConfig());
    delete process.env.KORY_DISABLE_CLI_AUTODETECT;

    expect(await registry.autoDetectProviders()).toBe(true);
    registry.removeApiKey('openai');
    await registry.autoDetectProviders(true);

    const config = registry.getConfigs().openai;
    expect(config?.disabled).toBe(true);
    expect(registry.get('openai')).toBeUndefined();
    const status = registry.getStatus().find((entry) => entry.name === 'openai');
    expect(status?.autoDetectedSource).toBeUndefined();
  });

  it('connects a running Ollama server and reports its URL as the source', async () => {
    stubFetch((url) => {
      if (url === 'http://localhost:11434/api/tags') {
        return Response.json({ models: [{ name: 'synthetic-llama' }] });
      }
      if (url === 'http://localhost:11434/v1/models') {
        return Response.json({ data: [{ id: 'synthetic-llama' }] });
      }
      return new Response('not found', { status: 404 });
    });
    const registry = new ProviderRegistry(minimalConfig());
    delete process.env.KORY_DISABLE_CLI_AUTODETECT;

    expect(await registry.autoDetectProviders()).toBe(true);

    const config = registry.getConfigs().ollama;
    expect(config?.disabled).toBe(false);
    expect(config?.baseUrl).toBe('http://localhost:11434');
    expect(config?.autoDetected).toBe(true);
    const status = registry.getStatus().find((entry) => entry.name === 'ollama');
    expect(status?.connectionState).toBe('verified');
    expect(status?.autoDetectedSource).toBe('Local server · http://localhost:11434');
  });

  it('leaves Ollama disabled when the server refuses the connection', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    const registry = new ProviderRegistry(minimalConfig());
    delete process.env.KORY_DISABLE_CLI_AUTODETECT;

    expect(await registry.autoDetectProviders()).toBe(false);
    expect(registry.getConfigs().ollama?.disabled).toBe(true);
    expect(
      registry.getStatus().find((entry) => entry.name === 'ollama')?.autoDetectedSource,
    ).toBeUndefined();
  });

  it('does nothing when KORY_DISABLE_CLI_AUTODETECT is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-autodetect-test';
    const registry = new ProviderRegistry(minimalConfig());

    expect(await registry.autoDetectProviders()).toBe(false);
    expect(requestedUrls).toEqual([]);
    expect(registry.getConfigs().openai?.disabled).toBe(true);
  });

  it('never persists auto-detected material when syncing provider configs', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-autodetect-persist-'));
    try {
      syncProviderConfigsToConfig(root, {
        openai: {
          name: 'openai',
          apiKey: 'sk-x',
          disabled: false,
          autoDetected: true,
          selectedModels: ['gpt-x'],
          lastVerifiedAt: 1,
          lastVerificationScope: 'credential',
          lastVerificationState: 'verified',
        },
      });

      const file = JSON.parse(readFileSync(join(root, 'koryphaios.json'), 'utf8')) as {
        providers: Record<string, Record<string, unknown>>;
      };
      // Preferences survive; discovered material and state do not.
      expect(file.providers.openai).toEqual({
        name: 'openai',
        selectedModels: ['gpt-x'],
      });
      expect(loadProviderSecrets(root).openai).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
