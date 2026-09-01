import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { KoryphaiosConfig, ProviderConfig } from '@koryphaios/shared';
import { clearTokenCache } from '../auth-utils';
import { BedrockProvider, mapBedrockAnthropicTextModels } from '../bedrock';
import { GITLAB_DUO_UNAVAILABLE_ERROR } from '../gitlab';
import { GITHUB_MODELS_CATALOG_URL, GITHUB_MODELS_API_VERSION } from '../github-models';
import { ProviderRegistry } from '../registry';
import { AzureProvider } from '../openai';
import { verifySapAiConnection } from '../sapai';

const config = (providers: KoryphaiosConfig['providers'] = {}): KoryphaiosConfig => ({
  server: { port: 3001, host: '127.0.0.1' },
  providers,
});

const originalFetch = globalThis.fetch;
const originalDisableCli = process.env.KORY_DISABLE_CLI_AUTODETECT;

async function captureAzureRuntimeRequest(
  providerConfig: ProviderConfig,
): Promise<{ url: string; headers: Headers }> {
  let url = '';
  let headers = new Headers();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    url = String(input);
    headers = new Headers(init?.headers);
    return new Response(
      [
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"production-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof fetch;

  const provider = new AzureProvider(providerConfig);
  for await (const _event of provider.streamResponse({
    model: 'production-chat',
    messages: [{ role: 'user', content: 'synthetic request' }],
    systemPrompt: '',
  })) {
    // Consuming the SDK stream proves the headers from the actual runtime path.
  }
  return { url, headers };
}

beforeEach(() => {
  process.env.KORY_DISABLE_CLI_AUTODETECT = '1';
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [{ id: 'synthetic-chat-model' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDisableCli === undefined) delete process.env.KORY_DISABLE_CLI_AUTODETECT;
  else process.env.KORY_DISABLE_CLI_AUTODETECT = originalDisableCli;
});

describe('provider verification truth', () => {
  it('keeps disabled CLI adapters inert when auto-detection is disabled', () => {
    const registry = new ProviderRegistry(
      config({
        claude: { name: 'claude', disabled: true },
        codex: { name: 'codex', disabled: true },
        grok: { name: 'grok', disabled: true },
        cline: { name: 'cline', disabled: true },
      }),
    );

    for (const name of ['claude', 'codex', 'grok', 'cline'] as const) {
      // Absence is intentional: constructing/listing these adapters can launch
      // authenticated CLI model probes. Configuration remains visible through
      // getStatus without creating a runnable adapter.
      expect(registry.get(name)).toBeUndefined();
      expect(registry.getStatus().find((item) => item.name === name)).toMatchObject({
        enabled: false,
        authenticated: false,
        adapterAvailable: false,
        connectionState: 'not_configured',
        allAvailableModels: [],
      });
    }
  });

  it('auto-connects an executable configured CLI and respects explicit disconnect', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-cli-auto-connect-'));
    const bin = join(root, 'bin');
    const home = join(root, 'home');
    const settings = join(home, '.cline', 'data', 'settings');
    const previousPath = process.env.PATH;
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    try {
      mkdirSync(bin, { recursive: true });
      mkdirSync(settings, { recursive: true });
      const cline = join(bin, 'cline');
      writeFileSync(cline, '#!/bin/sh\necho "3.0.57"\n');
      chmodSync(cline, 0o755);
      writeFileSync(
        join(settings, 'providers.json'),
        JSON.stringify({ selectedProvider: 'openrouter', model: 'synthetic-model' }),
      );
      process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`;
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      delete process.env.KORY_DISABLE_CLI_AUTODETECT;
      const otherClisDisabled = {
        claude: { name: 'claude', disabled: true },
        codex: { name: 'codex', disabled: true },
        grok: { name: 'grok', disabled: true },
        antigravity: { name: 'antigravity', disabled: true },
        cursor: { name: 'cursor', disabled: true },
        devin: { name: 'devin', disabled: true },
      } satisfies KoryphaiosConfig['providers'];

      const registry = new ProviderRegistry(config(otherClisDisabled));
      expect(registry.getStatus().find((item) => item.name === 'cline')).toMatchObject({
        enabled: true,
        connectionState: 'detected',
      });

      await registry.autoConnectCliProviders(true);
      expect(registry.getStatus().find((item) => item.name === 'cline')).toMatchObject({
        enabled: true,
        authenticated: true,
        supportsAuthToken: false,
        connectionState: 'verified',
      });

      writeFileSync(cline, '#!/bin/sh\nexit 1\n');
      expect(await registry.verifyConnection('cline')).toEqual({
        success: true,
        state: 'verified',
      });
      await registry.autoConnectCliProviders(true);
      expect(registry.getStatus().find((item) => item.name === 'cline')).toMatchObject({
        enabled: true,
        authenticated: true,
        connectionState: 'verified',
      });

      const disconnected = new ProviderRegistry(
        config({ ...otherClisDisabled, cline: { name: 'cline', disabled: true } }),
      );
      await disconnected.autoConnectCliProviders(true);
      expect(disconnected.getStatus().find((item) => item.name === 'cline')).toMatchObject({
        enabled: false,
        authenticated: false,
        connectionState: 'not_configured',
      });
    } finally {
      process.env.PATH = previousPath;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      process.env.KORY_DISABLE_CLI_AUTODETECT = '1';
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('distinguishes local credential detection from a process-local provider probe', async () => {
    const registry = new ProviderRegistry(
      config({ openai: { name: 'openai', apiKey: 'stored-test-key', disabled: false } }),
    );

    expect(registry.getStatus().find((item) => item.name === 'openai')).toMatchObject({
      enabled: true,
      authenticated: false,
      adapterAvailable: true,
      credentialDetected: true,
      connectionState: 'detected',
    });

    const result = await registry.verifyConnection('openai');
    expect(result).toEqual({ success: true });
    expect(registry.getStatus().find((item) => item.name === 'openai')).toMatchObject({
      authenticated: true,
      adapterAvailable: true,
      credentialDetected: true,
      connectionState: 'verified',
      verificationScope: 'credential',
    });
    expect(registry.getStatus().find((item) => item.name === 'openai')?.verifiedAt).toBeNumber();
  });

  it('verifies an enabled persisted API provider once when no durable verdict exists', async () => {
    const registry = new ProviderRegistry(
      config({ openai: { name: 'openai', apiKey: 'stored-test-key', disabled: false } }),
    );

    await registry.autoConnectCliProviders(true);

    expect(registry.getStatus().find((item) => item.name === 'openai')).toMatchObject({
      authenticated: true,
      connectionState: 'verified',
      verificationScope: 'credential',
    });
    expect(registry.getConfigs().openai?.lastVerifiedAt).toBeNumber();
  });

  it('restores a persisted successful verification after a backend restart', () => {
    const verifiedAt = Date.now() - 1_000;
    const registry = new ProviderRegistry(
      config({
        openai: {
          name: 'openai',
          apiKey: 'stored-test-key',
          disabled: false,
          lastVerifiedAt: verifiedAt,
          lastVerificationScope: 'credential',
        },
      }),
    );

    expect(registry.getStatus().find((item) => item.name === 'openai')).toMatchObject({
      enabled: true,
      authenticated: true,
      credentialDetected: true,
      connectionState: 'verified',
      verifiedAt,
      verificationScope: 'credential',
    });
  });

  it('clears a durable connection after a definitive authentication rejection', async () => {
    const registry = new ProviderRegistry(
      config({
        openai: {
          name: 'openai',
          apiKey: 'stored-test-key',
          disabled: false,
          lastVerifiedAt: Date.now() - 1_000,
          lastVerificationScope: 'credential',
        },
      }),
    );
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })) as typeof fetch;

    expect((await registry.verifyConnection('openai')).success).toBe(false);
    expect(registry.getStatus().find((item) => item.name === 'openai')).toMatchObject({
      connectionState: 'failed',
    });
    expect(registry.getConfigs().openai?.lastVerifiedAt).toBeUndefined();
  });

  it('keeps a failed probe explicit instead of converting detection into authentication', async () => {
    const registry = new ProviderRegistry(
      config({ openai: { name: 'openai', apiKey: 'stored-test-key', disabled: false } }),
    );
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })) as typeof fetch;

    const result = await registry.verifyConnection('openai');
    expect(result.success).toBe(false);
    expect(registry.getStatus().find((item) => item.name === 'openai')).toMatchObject({
      credentialDetected: true,
      connectionState: 'failed',
    });
    expect(
      registry.getStatus().find((item) => item.name === 'openai')?.verificationScope,
    ).toBeUndefined();
    expect(
      registry.getStatus().find((item) => item.name === 'openai')?.verificationError,
    ).toContain('401');
  });

  it('verifies TokenRouter against its current authenticated model catalog', async () => {
    let requestUrl = '';
    let requestHeaders = new Headers();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ object: 'list', data: [{ id: 'test-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const registry = new ProviderRegistry(config());
    expect(
      await registry.setCredentials('tokenrouter', { apiKey: 'tr_synthetic-test-key' }),
    ).toEqual({ success: true });
    expect(requestUrl).toBe('https://api.tokenrouter.io/v1/models');
    expect(requestHeaders.get('authorization')).toBe('Bearer tr_synthetic-test-key');
    expect(registry.get('tokenrouter')).toBeDefined();
    expect(registry.getStatus().find((item) => item.name === 'tokenrouter')).toMatchObject({
      enabled: true,
      authenticated: true,
      adapterAvailable: true,
      credentialDetected: true,
      connectionState: 'verified',
    });
  });

  it('rejects HTML, malformed, structurally wrong, and empty model-catalog 2xx responses', async () => {
    const fixtures = [
      new Response('<html>sign in</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
      new Response('{not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ];

    for (const fixture of fixtures) {
      globalThis.fetch = (async () => fixture.clone()) as typeof fetch;
      const registry = new ProviderRegistry(
        config({ openai: { name: 'openai', apiKey: 'synthetic-key', disabled: false } }),
      );
      const result = await registry.verifyConnection('openai');
      expect(result.success).toBe(false);
      expect(registry.getStatus().find((item) => item.name === 'openai')).toMatchObject({
        authenticated: false,
        connectionState: 'failed',
      });
    }
  });

  it('accepts provider-shaped non-empty Gemini and Ollama catalogs', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'llama-test:latest' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          models: [
            {
              name: 'models/gemini-test',
              supportedGenerationMethods: ['generateContent'],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const registry = new ProviderRegistry(config());
    expect(await registry.verifyConnection('google', { apiKey: 'synthetic-google-key' })).toEqual({
      success: true,
    });
    expect(
      await registry.verifyConnection('ollama', { baseUrl: 'http://127.0.0.1:11434' }),
    ).toEqual({ success: true });
  });

  it('keeps CLI file or environment detection distinct from account verification', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kory-cli-detection-truth-'));
    const originalPath = process.env.PATH;
    const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (process.platform === 'win32') {
      writeFileSync(
        join(dir, 'claude.cmd'),
        '@echo off\nif "%1"=="auth" (echo {"loggedIn":true} & exit /b 0)\necho 1.0.0-test\nexit /b 0\n',
      );
    } else {
      writeFileSync(
        join(dir, 'claude'),
        '#!/bin/sh\nif [ "$1" = "auth" ]; then echo \'{"loggedIn":true}\'; else echo "1.0.0-test"; fi\nexit 0\n',
      );
      chmodSync(join(dir, 'claude'), 0o755);
    }
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'synthetic-local-login-material';
    clearTokenCache();
    try {
      const registry = new ProviderRegistry(config());
      const result = await registry.verifyConnection('claude', {
        authToken: 'cli:claude:synthetic-marker',
      });
      expect(result).toEqual({ success: true, state: 'verified' });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
      clearTokenCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails GitLab Duo closed without contacting a generic models endpoint', async () => {
    const registry = new ProviderRegistry(config());
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response('{}');
    }) as typeof fetch;

    const result = await registry.verifyConnection('gitlab', { apiKey: 'synthetic-pat' });
    expect(result).toEqual({ success: false, error: GITLAB_DUO_UNAVAILABLE_ERROR });
    expect(requests).toBe(0);
  });

  it('verifies GitHub Models against /catalog/models with the documented API version', async () => {
    const registry = new ProviderRegistry(config());
    let requestUrl = '';
    let requestHeaders = new Headers();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify([
          {
            id: 'openai/gpt-4o',
            name: 'GPT-4o',
            capabilities: ['streaming'],
            limits: { max_input_tokens: 128000, max_output_tokens: 16384 },
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const result = await registry.verifyConnection('github-models', {
      apiKey: 'synthetic-github-token',
    });
    expect(result).toEqual({ success: true });
    expect(requestUrl).toBe(GITHUB_MODELS_CATALOG_URL);
    expect(requestHeaders.get('authorization')).toBe('Bearer synthetic-github-token');
    expect(requestHeaders.get('x-github-api-version')).toBe(GITHUB_MODELS_API_VERSION);
    expect(requestUrl).not.toContain('/inference/models');
  });

  it('performs SAP service-key OAuth then verifies the exact running deployment', async () => {
    const calls: Array<{ url: string; method: string; headers: Headers; body?: BodyInit | null }> =
      [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: init?.body,
      });
      if (url.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'sap-access-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          id: 'deployment-123',
          status: 'RUNNING',
          deploymentUrl: 'https://deployment.example/v2/inference/deployments/deployment-123',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const serviceKey = JSON.stringify({
      clientid: 'client-id',
      clientsecret: 'client-secret',
      url: 'https://tenant.authentication.sap.hana.ondemand.com',
      serviceurls: { AI_API_URL: 'https://tenant.ai.us10.hana.ondemand.com' },
    });
    const result = await verifySapAiConnection({
      name: 'sapai',
      apiKey: serviceKey,
      deployment: 'deployment-123',
      headers: { 'AI-Resource-Group': 'resource-group-1' },
      disabled: false,
    });

    expect(result).toEqual({ success: true });
    expect(calls.map((call) => call.url)).toEqual([
      'https://tenant.authentication.sap.hana.ondemand.com/oauth/token',
      'https://tenant.ai.us10.hana.ondemand.com/v2/lm/deployments/deployment-123',
    ]);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers.get('authorization')).toMatch(/^Basic /);
    expect(calls[0]?.body).toBe('grant_type=client_credentials');
    expect(calls[1]?.headers.get('authorization')).toBe('Bearer sap-access-token');
    expect(calls[1]?.headers.get('ai-resource-group')).toBe('resource-group-1');
    expect(calls[1]?.headers.get('authorization')).not.toContain(serviceKey);
  });

  it('requires Azure deployment truth and never exposes base model ids as runnable', async () => {
    const registry = new ProviderRegistry(config());
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response(JSON.stringify({ data: [{ id: 'gpt-4o-base-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const missingDeployment = await registry.setCredentials('azure', {
      apiKey: 'azure-key',
      baseUrl: 'https://resource.openai.azure.com',
    });
    expect(missingDeployment.success).toBe(false);
    expect(missingDeployment.error).toContain('deployment name');
    expect(requests).toBe(0);

    const ambiguous = await registry.setCredentials('azure', {
      apiKey: 'azure-key',
      authToken: 'azure-entra-token',
      baseUrl: 'https://resource.openai.azure.com',
      deployment: 'production-chat',
    });
    expect(ambiguous.success).toBe(false);
    expect(ambiguous.error).toContain('not both');
    expect(requests).toBe(0);

    const connected = await registry.setCredentials('azure', {
      apiKey: 'azure-key',
      baseUrl: 'https://resource.openai.azure.com',
      deployment: 'production-chat',
    });
    expect(connected).toEqual({ success: true });
    const status = registry.getStatus().find((item) => item.name === 'azure');
    expect(status).toMatchObject({
      connectionState: 'detected',
      requiresDeployment: true,
      deploymentName: 'production-chat',
      models: ['production-chat'],
    });
    expect(status?.verifiedAt).toBeUndefined();
    expect(status?.verificationScope).toBe('catalog');
    expect(status?.allAvailableModels.map((model) => model.id)).toEqual(['production-chat']);
    expect(status?.allAvailableModels.some((model) => model.id === 'gpt-4o-base-model')).toBe(
      false,
    );
  });

  it('uses api-key for Azure API-key runtime requests', async () => {
    const request = await captureAzureRuntimeRequest({
      name: 'azure',
      apiKey: 'synthetic-azure-api-key',
      baseUrl: 'https://resource.openai.azure.com',
      deployment: 'production-chat',
      disabled: false,
    });

    expect(request.url).toContain('/openai/deployments/production-chat/chat/completions');
    expect(request.headers.get('api-key')).toBe('synthetic-azure-api-key');
    expect(request.headers.get('authorization')).toBeNull();
  });

  it('uses Authorization Bearer for Azure Microsoft Entra runtime requests', async () => {
    const request = await captureAzureRuntimeRequest({
      name: 'azure',
      authToken: 'synthetic-entra-token',
      baseUrl: 'https://resource.openai.azure.com',
      deployment: 'production-chat',
      disabled: false,
    });

    expect(request.url).toContain('/openai/deployments/production-chat/chat/completions');
    expect(request.headers.get('api-key')).toBeNull();
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-entra-token');
  });

  it('limits Bedrock catalog mapping to Anthropic text models with unknown limits', () => {
    const models = mapBedrockAnthropicTextModels([
      {
        modelId: 'anthropic.claude-test-v1:0',
        modelName: 'Claude Test',
        providerName: 'Anthropic',
        inputModalities: ['TEXT', 'IMAGE'],
        outputModalities: ['TEXT'],
        responseStreamingSupported: true,
      },
      {
        modelId: 'amazon.nova-test-v1:0',
        modelName: 'Nova Test',
        providerName: 'Amazon',
        inputModalities: ['TEXT'],
        outputModalities: ['TEXT'],
      },
      {
        modelId: 'anthropic.embedding-test-v1:0',
        modelName: 'Not Text',
        providerName: 'Anthropic',
        inputModalities: ['TEXT'],
        outputModalities: ['EMBEDDING'],
      },
    ]);

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: 'anthropic.claude-test-v1:0',
      provider: 'bedrock',
      contextWindow: 0,
      maxOutputTokens: 0,
      contextVerified: false,
      supportsStreaming: true,
      vision: true,
    });
  });

  it('treats a successful Bedrock catalog call as detected, never invoke-verified', async () => {
    const previousAccessKey = process.env.AWS_ACCESS_KEY_ID;
    const previousSecretKey = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_ACCESS_KEY_ID = 'synthetic-access-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'synthetic-secret-key';
    try {
      const provider = new BedrockProvider(
        { name: 'bedrock', disabled: false },
        async (region, signal) => {
          expect(region).toBe('us-east-1');
          expect(signal.aborted).toBe(false);
          return [
            {
              modelId: 'anthropic.claude-catalog-only-v1:0',
              modelName: 'Claude Catalog Only',
              providerName: 'Anthropic',
              inputModalities: ['TEXT'],
              outputModalities: ['TEXT'],
              responseStreamingSupported: true,
            },
          ];
        },
      );

      expect(await provider.verifyAccess()).toEqual({ success: true, state: 'detected' });
      expect(provider.listModels().map((model) => model.id)).toEqual([
        'anthropic.claude-catalog-only-v1:0',
      ]);

      const registry = new ProviderRegistry(config());
      const bedrockConfig: ProviderConfig = { name: 'bedrock', disabled: false };
      const internals = registry as unknown as {
        providers: Map<string, unknown>;
        providerConfigs: Map<string, ProviderConfig>;
        verificationRecords: Map<
          string,
          { state: 'detected'; checkedAt: number; scope: 'catalog' }
        >;
      };
      internals.providers.set('bedrock', provider);
      internals.providerConfigs.set('bedrock', bedrockConfig);
      internals.verificationRecords.set('bedrock', {
        state: 'detected',
        checkedAt: Date.now(),
        scope: 'catalog',
      });

      expect(registry.getStatus().find((item) => item.name === 'bedrock')).toMatchObject({
        authenticated: false,
        adapterAvailable: true,
        credentialDetected: true,
        connectionState: 'detected',
        verificationScope: 'catalog',
      });
      expect(
        registry.getStatus().find((item) => item.name === 'bedrock')?.verifiedAt,
      ).toBeUndefined();
    } finally {
      if (previousAccessKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
      else process.env.AWS_ACCESS_KEY_ID = previousAccessKey;
      if (previousSecretKey === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = previousSecretKey;
    }
  });

  it('reports Bedrock credential presence as detected, never verified by presence alone', () => {
    const registry = new ProviderRegistry(config());
    const bedrockConfig: ProviderConfig = { name: 'bedrock', disabled: false };
    const fakeBedrock = {
      name: 'bedrock' as const,
      config: bedrockConfig,
      isAvailable: () => true,
      listModels: () => [],
      async *streamResponse() {
        yield { type: 'error' as const, error: 'not invoked' };
      },
    };
    const internals = registry as unknown as {
      providers: Map<string, unknown>;
      providerConfigs: Map<string, ProviderConfig>;
    };
    internals.providers.set('bedrock', fakeBedrock);
    internals.providerConfigs.set('bedrock', bedrockConfig);

    const status = registry.getStatus().find((item) => item.name === 'bedrock');
    expect(status).toMatchObject({
      authenticated: false,
      adapterAvailable: true,
      credentialDetected: true,
      connectionState: 'detected',
    });
    expect(status?.verificationScope).toBeUndefined();
  });
});
