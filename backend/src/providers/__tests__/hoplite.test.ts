import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { KoryphaiosConfig, ProviderConfig, ProviderName } from '@koryphaios/shared';
import { PROVIDER_AUTH_MODES, PROVIDER_ENV_VARS, providerSupport } from '@koryphaios/shared';
import { buildAuthHeaders, PROVIDER_BASE_URLS } from '../api-endpoints';
import { getProviderDisplay } from '../provider-display';
import { PROVIDER_CONFIGS } from '../provider-configs';
import { HopliteProvider, HOPLITE_DELEGATION_NOT_AVAILABLE } from '../hoplite';
import { HOPLITE_DEFAULT_MODEL_ID, HOPLITE_FAST_TIER_MODEL_IDS } from '../hoplite-models';
import { HopliteClient } from '../hoplite-client';
import { ProviderRegistry } from '../registry';
import { getProviderHarnessCapabilities } from '../provider-harness';

const config = (providers: KoryphaiosConfig['providers'] = {}): KoryphaiosConfig => ({
  server: { port: 3001, host: '127.0.0.1' },
  providers,
});

const originalFetch = globalThis.fetch;
const originalDisableCli = process.env.KORY_DISABLE_CLI_AUTODETECT;

async function collectEvents<T extends { type: string; error?: string }>(
  stream: AsyncIterable<T>,
): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

beforeEach(() => {
  process.env.KORY_DISABLE_CLI_AUTODETECT = '1';
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true, projects: [], hasMore: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDisableCli === undefined) delete process.env.KORY_DISABLE_CLI_AUTODETECT;
  else process.env.KORY_DISABLE_CLI_AUTODETECT = originalDisableCli;
});

describe('Hoplite connection verification', () => {
  it('maps a 200 project-catalog probe to verified with catalog scope', async () => {
    let requestUrl = '';
    let requestHeaders = new Headers();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true, projects: [], hasMore: false }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-200' },
      });
    }) as typeof fetch;

    const registry = new ProviderRegistry(config());
    const result = await registry.verifyConnection('hoplite', { apiKey: 'hop_synthetic-test-key' });
    expect(result).toEqual({ success: true, state: 'verified', scope: 'catalog' });
    expect(requestUrl).toBe('https://api.hoplite.sh/api/projects');
    expect(requestHeaders.get('x-api-key')).toBe('hop_synthetic-test-key');
    expect(requestHeaders.get('authorization')).toBeNull();
    expect(requestHeaders.get('user-agent')).toBe('Koryphaios/1.0');
  });

  it('maps a 401 auth_required rejection to a failed probe with org-key guidance', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: 'auth_required' }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-401' },
      })) as typeof fetch;

    const registry = new ProviderRegistry(config());
    const result = await registry.verifyConnection('hoplite', { apiKey: 'hop_rejected-key' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
    expect(result.error).toContain('auth_required');
    expect(result.error).toContain('organization settings');
    expect(result.error).toContain('hop_');
  });

  it('fails a 403 rejection with the same create-a-key guidance', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: 'forbidden' }), {
        status: 403,
      })) as typeof fetch;

    const registry = new ProviderRegistry(config());
    const result = await registry.verifyConnection('hoplite', { apiKey: 'hop_forbidden-key' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('403');
    expect(result.error).toContain('organization settings');
  });

  it('reports other statuses with the HTTP code and a short body snippet', async () => {
    globalThis.fetch = (async () =>
      new Response('upstream exploded', { status: 502 })) as typeof fetch;

    const registry = new ProviderRegistry(config());
    const result = await registry.verifyConnection('hoplite', { apiKey: 'hop_unlucky-key' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('502');
    expect(result.error).toContain('upstream exploded');
  });

  it('fails closed without any network request when no key is present', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response('{}');
    }) as typeof fetch;

    const registry = new ProviderRegistry(config());
    const result = await registry.verifyConnection('hoplite', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing Hoplite API key');
    expect(requests).toBe(0);
  });

  it('exposes hoplite in status as an api_key provider', () => {
    const registry = new ProviderRegistry(config());
    const status = registry.getStatus().find((item) => item.name === 'hoplite');
    expect(status).toBeDefined();
    expect(status).toMatchObject({
      label: 'Hoplite',
      supportsApiKey: true,
      supportsAuthToken: false,
    });
  });
});

describe('Hoplite adapter honesty', () => {
  it('never claims chat capability', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response('{}');
    }) as typeof fetch;

    const provider = new HopliteProvider({ name: 'hoplite', apiKey: 'hop_test', disabled: false });
    expect(provider.isAvailable()).toBe(false);
    expect(provider.getModelDiscoveryError()).toBe(HOPLITE_DELEGATION_NOT_AVAILABLE);
    const events = await collectEvents(
      provider.streamResponse({
        model: 'hoplite-test',
        systemPrompt: '',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    );
    expect(events).toEqual([{ type: 'error', error: HOPLITE_DELEGATION_NOT_AVAILABLE }]);
    expect(requests).toBe(0);
  });

  it('publishes the platform catalog as delegation selectors, not chat targets', () => {
    const provider = new HopliteProvider({ name: 'hoplite', apiKey: 'hop_test', disabled: false });
    const models = provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.provider).toBe('hoplite');
      expect(model.id.trim().length).toBeGreaterThan(0);
      expect(model.name.trim().length).toBeGreaterThan(0);
      expect(model.contextWindow).toBeGreaterThan(0);
    }
    expect(models.map((model) => model.id)).toContain(HOPLITE_DEFAULT_MODEL_ID);
  });

  it('scopes fast mode to the models that actually expose the fast tier', () => {
    const provider = new HopliteProvider({ name: 'hoplite', apiKey: 'hop_test', disabled: false });
    const models = provider.listModels();
    const fast = models.filter((model) => model.supportsFastMode === true).map((model) => model.id);
    // Never blanket-applied: some models have it, and not all of them do.
    expect(fast.length).toBeGreaterThan(0);
    expect(fast.length).toBeLessThan(models.length);
    expect([...fast].sort()).toEqual([...HOPLITE_FAST_TIER_MODEL_IDS].sort());
  });

  it('carries the provider-reported reasoning ladder and omits it where there is none', () => {
    const provider = new HopliteProvider({ name: 'hoplite', apiKey: 'hop_test', disabled: false });
    const models = provider.listModels();
    const withReasoning = models.filter((model) => (model.reasoningLevels?.length ?? 0) > 0);
    expect(withReasoning.length).toBeGreaterThan(0);
    for (const model of withReasoning) {
      expect(model.canReason).toBe(true);
      for (const level of model.reasoningLevels ?? []) {
        expect(['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).toContain(
          level,
        );
      }
    }
    // A model with no reported levels must not be given an invented default.
    const withoutReasoning = models.filter((model) => (model.reasoningLevels?.length ?? 0) === 0);
    for (const model of withoutReasoning) expect(model.canReason).not.toBe(true);
  });

  it('constructs only when an API key is present', () => {
    const registry = new ProviderRegistry(config());
    const createProvider = (
      registry as unknown as {
        createProvider: (name: ProviderName, config: ProviderConfig) => unknown;
      }
    ).createProvider.bind(registry);
    expect(createProvider('hoplite', { name: 'hoplite', disabled: false })).toBeNull();
    expect(
      createProvider('hoplite', { name: 'hoplite', apiKey: 'hop_test', disabled: false }),
    ).toBeInstanceOf(HopliteProvider);
  });

  it('stays outside the native CLI harness set', () => {
    expect(getProviderHarnessCapabilities('hoplite').mode).toBe('managed');
  });
});

describe('Hoplite REST client', () => {
  it('sends X-Api-Key, parses the ok-envelope, and unwraps collection keys', async () => {
    let requestHeaders = new Headers();
    let requestBody: string | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestHeaders = new Headers(init?.headers);
      requestBody = typeof init?.body === 'string' ? init.body : undefined;
      return new Response(
        JSON.stringify({
          ok: true,
          thread: { id: 'thread-1', status: 'queued', pullRequests: [] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const client = new HopliteClient({ apiKey: 'hop_client-test-key' });
    const thread = await client.createThread({
      projectId: 'project-1',
      prompt: 'fix the flaky test',
    });
    expect(thread.id).toBe('thread-1');
    expect(requestHeaders.get('x-api-key')).toBe('hop_client-test-key');
    expect(requestHeaders.get('user-agent')).toBe('Koryphaios/1.0');
    expect(requestHeaders.get('content-type')).toBe('application/json');
    expect(JSON.parse(requestBody ?? '{}')).toEqual({
      projectId: 'project-1',
      prompt: 'fix the flaky test',
    });
  });

  it('includes the stable error code and x-request-id in thrown errors', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: 'auth_required' }), {
        status: 401,
        headers: { 'x-request-id': 'req-abc' },
      })) as typeof fetch;

    const client = new HopliteClient({ apiKey: 'hop_bad-key' });
    await expect(client.listProjects()).rejects.toThrow(
      'Hoplite API 401: auth_required [x-request-id: req-abc]',
    );
  });

  it('retries a 429 exactly once and then succeeds', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ ok: false, error: 'rate_limited' }), {
          status: 429,
          headers: { 'retry-after': '0' },
        });
      }
      return new Response(JSON.stringify({ ok: true, projects: [{ id: 'p1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const client = new HopliteClient({ apiKey: 'hop_burst-key' });
    const projects = await client.listProjects();
    expect(projects.map((project) => project.id)).toEqual(['p1']);
    expect(calls).toBe(2);
  });

  it('surfaces a clear error after a second consecutive 429', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: false, error: 'rate_limited' }), {
        status: 429,
        headers: { 'retry-after': '0' },
      });
    }) as typeof fetch;

    const client = new HopliteClient({ apiKey: 'hop_throttled-key' });
    await expect(client.listThreads()).rejects.toThrow(/rate limit exceeded/);
    expect(calls).toBe(2);
  });
});

describe('Hoplite registration metadata', () => {
  it('registers the verified API contract', () => {
    expect(PROVIDER_CONFIGS.find((entry) => entry.name === 'hoplite')).toMatchObject({
      baseUrl: 'https://api.hoplite.sh',
      authMode: 'api_key',
      envKeys: ['HOPLITE_API_KEY'],
    });
    expect(PROVIDER_AUTH_MODES.hoplite).toBe('api_key');
    expect(PROVIDER_ENV_VARS.hoplite).toEqual({ apiKey: 'HOPLITE_API_KEY' });
    expect(PROVIDER_BASE_URLS.hoplite).toBe('https://api.hoplite.sh');
    expect(buildAuthHeaders('hoplite', { apiKey: 'hop_k' }).headers['X-Api-Key']).toBe('hop_k');
  });

  it('keeps the async-agent support record explicitly unavailable', () => {
    expect(providerSupport('hoplite')).toMatchObject({
      tier: 'unavailable',
      capabilities: ['async-agent'],
      evidence: 'explicitly-blocked',
    });
  });

  it('carries hybrid deployment metadata and a sync manager hint', () => {
    const display = getProviderDisplay('hoplite');
    expect(display).toMatchObject({
      label: 'Hoplite',
      iconPath: '/provider-icons/hoplite.svg',
      deployment: 'hybrid',
    });
    expect(display?.managerHint).toContain('gh pr checkout');
  });

  it('resolves a verified key to connectionState verified despite having no chat adapter', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, projects: [], hasMore: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    const registry = new ProviderRegistry(config());
    const connected = await registry.setCredentials('hoplite', {
      apiKey: 'hop_synthetic-test-key',
    });
    expect(connected.success).toBe(true);

    const status = registry.getStatus().find((item) => item.name === 'hoplite');
    // The catalog is only reachable from the UI when the connection reads as
    // verified, so this pairing is what makes the model list show up at all.
    expect(status).toMatchObject({
      connectionState: 'verified',
      verificationScope: 'catalog',
      adapterAvailable: false,
      // Surfaces as the "Cloud + local" badge, not "Cloud agent": a thread can
      // run in a Hoplite sandbox or on a local Codex/Claude agent.
      deployment: 'hybrid',
    });
    expect(status?.configurationBlocked).toBeUndefined();
    expect(status?.allAvailableModels?.length).toBeGreaterThan(0);
  });
});
