import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { ProviderRegistry } from '../registry';
import { verifyRuntimeCompletion, selectVerificationModel } from '../runtime-verification';
import type { Provider } from '../types';

const originalFetch = globalThis.fetch;

/** Minimal OpenAI-shaped stream that yields one content delta. */
function completionSse(): string {
  return [
    'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
    'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
    'data: [DONE]',
  ].join('\n\n');
}

function sseResponse(): Response {
  return new Response(completionSse(), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function catalogResponse(): Response {
  return new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Route by URL: catalogs succeed, completions are scripted per test. */
function installFetch(completion: () => Response | Promise<Response>): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    if (url.includes('/chat/completions')) return completion();
    return catalogResponse();
  }) as typeof fetch;
  return urls;
}

describe('runtime (inference) verification', () => {
  beforeEach(() => {
    process.env.KORY_DISABLE_CLI_AUTODETECT = '1';
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('the gap this closes', () => {
    it('fails a connect whose catalog is public but whose account cannot generate', async () => {
      // Command Code's real shape: GET /models answers 200 with the full
      // catalog and needs no credential; only the completion POST enforces the
      // plan. A catalog-only check calls this provider "Connected".
      const urls = installFetch(
        () =>
          new Response(
            JSON.stringify({
              error: {
                message:
                  "Your Go plan doesn't include API access. Upgrade to Provider or higher at https://commandcode.ai/billing to use these endpoints.",
                type: 'permission_error',
                code: 'upgrade_required',
              },
            }),
            { status: 403, headers: { 'content-type': 'application/json' } },
          ),
      );

      const registry = new ProviderRegistry({
        providers: { commandcode: { name: 'commandcode', apiKey: 'user_test_key' } },
      } as never);
      await registry.initializeAll();

      const result = await registry.setCredentials('commandcode', {}, { fullCheck: true });

      expect(urls.some((u) => u.includes('/chat/completions'))).toBe(true);
      expect(result.success).toBe(false);
      expect(result.error).toContain("doesn't include API access");

      // A definitive refusal must not leave a green "Connected" behind.
      const status = registry.getStatus().find((p) => p.name === 'commandcode');
      expect(status?.connectionState).toBe('failed');
      expect(status?.authenticated).toBe(false);
      expect(status?.verificationError).toContain('API access');
    });

    it('promotes a provider to the runtime scope once it actually generates', async () => {
      installFetch(() => sseResponse());

      const registry = new ProviderRegistry({
        providers: { openai: { name: 'openai', apiKey: 'sk-test' } },
      } as never);
      await registry.initializeAll();

      const result = await registry.setCredentials('openai', {}, { fullCheck: true });
      expect(result.success).toBe(true);

      const status = registry.getStatus().find((p) => p.name === 'openai');
      expect(status?.connectionState).toBe('verified');
      expect(status?.verificationScope).toBe('runtime');
      expect(status?.verifiedAt).toBeGreaterThan(0);
    });
  });

  describe('transient failures never demote a working provider', () => {
    it.each([
      ['rate limited', 429, '{"error":{"message":"Rate limit reached for model"}}'],
      ['overloaded', 503, '{"error":{"message":"Service temporarily overloaded"}}'],
      ['bad gateway', 502, '{"error":{"message":"Bad gateway"}}'],
    ])(
      'keeps the catalog verdict when the provider is %s',
      // The SDK's own retry ladder (1s + 2s + 4s backoff) runs before the
      // probe can call a 429/5xx transient, so budget for it explicitly.
      { timeout: 30_000 },
      async (_label, status, body) => {
        installFetch(
          () => new Response(body, { status, headers: { 'content-type': 'application/json' } }),
        );

        const registry = new ProviderRegistry({
          providers: { openai: { name: 'openai', apiKey: 'sk-test' } },
        } as never);
        await registry.initializeAll();

        const result = await registry.setCredentials('openai', {}, { fullCheck: true });

        // A rate-limited provider is not a misconfigured one.
        expect(result.success).toBe(true);
        const status1 = registry.getStatus().find((p) => p.name === 'openai');
        expect(status1?.connectionState).toBe('verified');
      },
    );
  });

  describe('families that must never spend a token', () => {
    it('does not send a generation for a CLI harness', async () => {
      const urls = installFetch(() => sseResponse());
      const registry = new ProviderRegistry({ providers: {} } as never);
      await registry.initializeAll();

      // devin is a CLI_HARNESS_PROVIDER; its probe path never reaches a
      // generation, so no completion URL may appear.
      await registry.setCredentials('devin', { authToken: 'devin-cli:test' }, { fullCheck: true });
      expect(urls.filter((u) => u.includes('/chat/completions'))).toHaveLength(0);
    });

    it('does not send a generation for a capability-only provider', async () => {
      const urls = installFetch(() => sseResponse());
      const registry = new ProviderRegistry({
        providers: { deepgram: { name: 'deepgram', apiKey: 'dg-test' } },
      } as never);
      await registry.initializeAll();
      await registry.setCredentials('deepgram', {}, { fullCheck: true });
      expect(urls.filter((u) => u.includes('/chat/completions'))).toHaveLength(0);
    });

    it('never runs a generation on the polled auto-connect path', async () => {
      const urls = installFetch(() => sseResponse());
      const registry = new ProviderRegistry({
        providers: { openai: { name: 'openai', apiKey: 'sk-test' } },
      } as never);
      await registry.initializeAll();
      urls.length = 0;

      // GET /api/providers calls this on every status poll. If it generated,
      // every poll would cost money.
      await registry.autoConnectCliProviders(true);
      expect(urls.filter((u) => u.includes('/chat/completions'))).toHaveLength(0);
    });
  });

  describe('the no-op that made "Run safe check" meaningless', () => {
    it('re-probes unchanged stored credentials when a full check is requested', async () => {
      const urls = installFetch(() => sseResponse());
      const registry = new ProviderRegistry({
        providers: { openai: { name: 'openai', apiKey: 'sk-stored' } },
      } as never);
      await registry.initializeAll();
      urls.length = 0;

      // Exactly the "Run safe check" request: an empty credential body.
      const result = await registry.setCredentials('openai', {}, { fullCheck: true });

      expect(result.success).toBe(true);
      expect(urls.some((u) => u.includes('/models'))).toBe(true);
      expect(urls.some((u) => u.includes('/chat/completions'))).toBe(true);
      const status = registry.getStatus().find((p) => p.name === 'openai');
      expect(status?.connectionState).toBe('verified');
    });

    it('recovers a provider stuck on failed once the underlying problem is fixed', async () => {
      installFetch(
        () =>
          new Response('{"error":{"message":"Invalid API key"}}', {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const registry = new ProviderRegistry({
        providers: { openai: { name: 'openai', apiKey: 'sk-bad' } },
      } as never);
      await registry.initializeAll();
      await registry.setCredentials('openai', {}, { fullCheck: true });
      expect(registry.getStatus().find((p) => p.name === 'openai')?.connectionState).toBe('failed');

      // Provider recovers; the old code re-saved the stale failure forever
      // because nothing about the credential had changed.
      installFetch(() => sseResponse());
      const retry = await registry.setCredentials('openai', {}, { fullCheck: true });
      expect(retry.success).toBe(true);
      expect(registry.getStatus().find((p) => p.name === 'openai')?.connectionState).toBe(
        'verified',
      );
    });

    it('still does not re-probe on a preference-only save', async () => {
      const urls = installFetch(() => sseResponse());
      const registry = new ProviderRegistry({
        providers: { openai: { name: 'openai', apiKey: 'sk-stored' } },
      } as never);
      await registry.initializeAll();
      await registry.setCredentials('openai', {}, { fullCheck: true });
      urls.length = 0;

      // Manage Models must stay cheap: no generation, no catalog re-probe.
      await registry.setCredentials('openai', { selectedModels: ['gpt-4o-mini'] });
      expect(urls.filter((u) => u.includes('/chat/completions'))).toHaveLength(0);
    });
  });

  describe('model selection', () => {
    const fakeProvider = (models: string[]): Provider =>
      ({
        name: 'openai',
        config: { name: 'openai' },
        isAvailable: () => true,
        listModels: () => models.map((id) => ({ id })) as never,
      }) as unknown as Provider;

    it('prefers the model the user selected', () => {
      expect(selectVerificationModel(fakeProvider(['a', 'b']), 'b')).toBe('b');
    });

    it('skips embedding and non-chat families', () => {
      expect(selectVerificationModel(fakeProvider(['text-embed-3-large']))).toBeNull();
      expect(selectVerificationModel(fakeProvider(['whisper-1', 'gpt-4o']))).toBe('gpt-4o');
    });

    it('reports skipped rather than failing when nothing is probeable', async () => {
      const outcome = await verifyRuntimeCompletion(
        'openai',
        fakeProvider(['text-embedding-ada-002']),
      );
      expect(outcome.kind).toBe('skipped');
    });
  });
});
