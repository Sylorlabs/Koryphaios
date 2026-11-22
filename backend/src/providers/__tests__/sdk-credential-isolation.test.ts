import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { ProviderConfig } from '@koryphaios/shared';
import type { ProviderEvent } from '../types';

// Prevent the prompt-cache dependency from resolving on-disk project config.
// This file runs in its own process through the backend's isolated test runner.
mock.module('../cache-capability-store', () => ({
  readProviderReasoningCacheProbe: () => undefined,
}));
const { AnthropicProvider } = await import('../anthropic');
const { AzureProvider, OpenAIProvider, OpenRouterProvider } =
  await import('../openai');

// Exercise the installed SDKs and their real header construction, with every
// fetch intercepted. No registry, credential store, config files or discovery.
class AnthropicProbe extends AnthropicProvider {
  async probe() {
    return await this.client.models.list();
  }
}
class OpenAIProbe extends OpenAIProvider {
  async probe() {
    return await this.client.models.list();
  }
}
class OpenRouterProbe extends OpenRouterProvider {
  async probe() {
    return await this.client.models.list();
  }
}
class AzureProbe extends AzureProvider {
  async probe() {
    return await this.client.models.list();
  }
}

const ambient = {
  ANTHROPIC_API_KEY: 'synthetic-ambient-anthropic-key',
  ANTHROPIC_AUTH_TOKEN: 'synthetic-ambient-anthropic-token',
  OPENAI_API_KEY: 'synthetic-ambient-openai-key',
  OPENAI_ORG_ID: 'synthetic-ambient-org',
  OPENAI_PROJECT_ID: 'synthetic-ambient-project',
  // Neutralize unrelated SDK environment defaults for deterministic fixtures.
  ANTHROPIC_BASE_URL: undefined,
  OPENAI_BASE_URL: undefined,
  AZURE_OPENAI_API_KEY: undefined,
} satisfies Record<string, string | undefined>;
const savedEnv = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;
let requests: Request[];

beforeEach(() => {
  for (const [key, value] of Object.entries(ambient)) {
    savedEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  requests = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return Response.json({ data: [], has_more: false, object: 'list' });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

function outgoingHeaders(): Headers {
  expect(requests).toHaveLength(1);
  const headers = requests[0]!.headers;
  for (const value of Object.values(ambient)) {
    if (value) expect([...headers.values()].join('\n')).not.toContain(value);
  }
  return headers;
}

describe('outgoing SDK credential isolation', () => {
  for (const name of ['anthropic', 'custom:credential-isolation'] as const) {
    for (const credential of ['apiKey', 'authToken'] as const) {
      test(`Anthropic ${name} uses only the selected ${credential}`, async () => {
        const config: ProviderConfig = {
          name,
          baseUrl: 'https://gateway.invalid',
          custom: name.startsWith('custom:'),
          [credential]: 'synthetic-selected-credential',
        };
        await new AnthropicProbe(config, name).probe();
        const headers = outgoingHeaders();
        expect(headers.get('x-api-key')).toBe(
          credential === 'apiKey' ? 'synthetic-selected-credential' : null,
        );
        expect(headers.get('authorization')).toBe(
          credential === 'authToken' ? 'Bearer synthetic-selected-credential' : null,
        );
      });
    }
  }

  test('Anthropic preserves explicit API-key precedence when both credentials are selected', async () => {
    await new AnthropicProbe({
      name: 'anthropic',
      apiKey: 'synthetic-selected-key',
      authToken: 'synthetic-selected-token',
      baseUrl: 'https://gateway.invalid',
    }).probe();
    const headers = outgoingHeaders();
    expect(headers.get('x-api-key')).toBe('synthetic-selected-key');
    expect(headers.get('authorization')).toBeNull();
  });

  for (const apiKey of [undefined, '']) {
    test(`keyless custom Anthropic omits authentication (${String(apiKey)})`, async () => {
      await new AnthropicProbe({
        name: 'custom:credential-isolation',
        custom: true,
        apiKey,
        baseUrl: 'https://gateway.invalid',
      }).probe();
      const headers = outgoingHeaders();
      expect(headers.get('x-api-key')).toBeNull();
      expect(headers.get('authorization')).toBeNull();
    });
  }

  for (const envKey of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const) {
    test(`missing selected Anthropic credentials cannot fall back to ${envKey}`, async () => {
      delete process.env[
        envKey === 'ANTHROPIC_API_KEY' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY'
      ];
      const provider = new AnthropicProbe({
        name: 'anthropic',
        baseUrl: 'https://gateway.invalid',
      });
      await expect(provider.probe()).rejects.toThrow('Could not resolve authentication method');
      expect(requests).toHaveLength(0);
    });
  }

  for (const name of ['openai', 'custom:credential-isolation', 'groq'] as const) {
    for (const credential of ['apiKey', 'authToken'] as const) {
      test(`OpenAI ${name} uses selected ${credential} without ambient org/project`, async () => {
        await new OpenAIProbe(
          {
            name,
            custom: name.startsWith('custom:'),
            baseUrl: 'https://gateway.invalid/v1',
            [credential]: 'synthetic-selected-credential',
          },
          name,
        ).probe();
        const headers = outgoingHeaders();
        expect(headers.get('authorization')).toBe('Bearer synthetic-selected-credential');
        expect(headers.get('openai-organization')).toBeNull();
        expect(headers.get('openai-project')).toBeNull();
      });
    }
  }

  test('keyless custom OpenAI omits authentication and ambient org/project', async () => {
    await new OpenAIProbe({
      name: 'custom:credential-isolation',
      custom: true,
      baseUrl: 'https://gateway.invalid/v1',
    }).probe();
    const headers = outgoingHeaders();
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('openai-organization')).toBeNull();
    expect(headers.get('openai-project')).toBeNull();
  });

  test('explicit OpenAI key and configured org/project headers retain precedence', async () => {
    await new OpenAIProbe({
      name: 'openai',
      apiKey: 'synthetic-selected-key',
      authToken: 'synthetic-selected-token',
      baseUrl: 'https://gateway.invalid/v1',
      headers: { 'OpenAI-Organization': 'selected-org', 'OpenAI-Project': 'selected-project' },
    }).probe();
    const headers = outgoingHeaders();
    expect(headers.get('authorization')).toBe('Bearer synthetic-selected-key');
    expect(headers.get('openai-organization')).toBe('selected-org');
    expect(headers.get('openai-project')).toBe('selected-project');
  });

  test('OpenRouter override omits ambient org/project and preserves attribution', async () => {
    await new OpenRouterProbe({ name: 'openrouter', apiKey: 'synthetic-router-key' }).probe();
    const headers = outgoingHeaders();
    expect(headers.get('authorization')).toBe('Bearer synthetic-router-key');
    expect(headers.get('openai-organization')).toBeNull();
    expect(headers.get('openai-project')).toBeNull();
    expect(headers.has('http-referer')).toBe(true);
    expect(headers.has('x-openrouter-title')).toBe(true);
  });

  for (const credential of ['apiKey', 'authToken'] as const) {
    test(`Azure override preserves ${credential} without ambient OpenAI org/project`, async () => {
      await new AzureProbe({
        name: 'azure',
        baseUrl: 'https://azure-fixture.invalid',
        deployment: 'fixture',
        [credential]: 'synthetic-azure-credential',
      }).probe();
      const headers = outgoingHeaders();
      expect(headers.get('api-key')).toBe(
        credential === 'apiKey' ? 'synthetic-azure-credential' : null,
      );
      expect(headers.get('authorization')).toBe(
        credential === 'authToken' ? 'Bearer synthetic-azure-credential' : null,
      );
      expect(headers.get('openai-organization')).toBeNull();
      expect(headers.get('openai-project')).toBeNull();
    });
  }

});
