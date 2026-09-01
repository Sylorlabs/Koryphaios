import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET =
  process.env.SESSION_TOKEN_SECRET ?? 'test_only_not_for_production_aaaaaaaaaa';

const { Elysia } = await import('elysia');
const { localAuth } = await import('../../auth/local-auth');
const { buildLocalBearerToken } = await import('../../auth/local-route-auth');
const { setContext } = await import('../../context');
const { errorHandler } = await import('../../middleware/error-handling');
const { imageRoutes } = await import('./images');
const { usageRoutes } = await import('./usage');
const { apiUsageTotals, listApiUsage } = await import('../../billing/api-usage-ledger');
const { getEnforcedCaps, getSpendWindowSnapshot, setEnforcedCaps } =
  await import('../../security/spend-caps-enforced');

const app = new Elysia().onError(errorHandler).use(imageRoutes).use(usageRoutes);
const realFetch = globalThis.fetch;
const realDataDir = process.env.KORYPHAIOS_DATA_DIR;
let requestBody: Record<string, unknown> | undefined;
let requestForm: FormData | undefined;
let requestUrl = '';

function authorizedRequest(path: string, body?: unknown, signal?: AbortSignal): Request {
  return new Request(`http://localhost${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: buildLocalBearerToken(localAuth.createSession(['*'])),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
}

function deleteRequest(path: string): Request {
  return new Request(`http://localhost${path}`, {
    method: 'DELETE',
    headers: { Authorization: buildLocalBearerToken(localAuth.createSession(['*'])) },
  });
}

function postRequest(path: string): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { Authorization: buildLocalBearerToken(localAuth.createSession(['*'])) },
  });
}

const BASE_PROVIDER_CONTEXT = {
  providers: {
    getConfigs: () => ({
      openai: { apiKey: 'test-key', baseUrl: 'https://api.openai.com/v1' },
      google: { apiKey: 'google-key', baseUrl: 'https://generativelanguage.googleapis.com' },
      local: { baseUrl: 'http://localhost:9853/v1' },
    }),
    get: (id: string) =>
      id === 'local'
        ? { listModels: () => [{ id: 'flux.1-schnell', name: 'FLUX.1 Schnell' }] }
        : undefined,
  },
};

beforeAll(() => {
  process.env.KORYPHAIOS_DATA_DIR = mkdtempSync(join(tmpdir(), 'kory-images-test-'));
  setContext(BASE_PROVIDER_CONTEXT as never);
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(input instanceof Request ? input.url : input);
    if (init?.body instanceof FormData) {
      requestForm = init.body;
      requestBody = undefined;
    } else {
      requestForm = undefined;
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    }
    if (requestUrl.includes(':generateContent')) {
      return Response.json({
        candidates: [
          { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }] } },
        ],
      });
    }
    return Response.json({ data: [{ b64_json: 'aW1hZ2U=', revised_prompt: 'Revised' }] });
  }) as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  if (realDataDir === undefined) delete process.env.KORYPHAIOS_DATA_DIR;
  else process.env.KORYPHAIOS_DATA_DIR = realDataDir;
});

describe('image generation routes', () => {
  test('reports all image-capable providers with their models', async () => {
    const response = await app.handle(authorizedRequest('/api/images/providers'));
    const payload = (await response.json()) as {
      data: Array<{
        id: string;
        label: string;
        configured: boolean;
        models: Array<{ id: string; sizes?: string[]; qualities?: string[] }>;
      }>;
    };
    expect(response.status).toBe(200);
    expect(payload.data.map((provider) => provider.id)).toEqual([
      'openai',
      'xai',
      'google',
      'aistudio',
      'openrouter',
      'local',
      'lmstudio',
      'llamacpp',
    ]);
    const openai = payload.data.find((provider) => provider.id === 'openai');
    expect(openai?.configured).toBe(true);
    expect(openai?.models.map((model) => model.id)).toContain('gpt-image-2');
    const google = payload.data.find((provider) => provider.id === 'google');
    expect(google?.configured).toBe(true);
    expect(google?.models.map((model) => model.id)).toContain('gemini-2.5-flash-image');
    const xai = payload.data.find((provider) => provider.id === 'xai');
    expect(xai?.configured).toBe(false);
    const local = payload.data.find((provider) => provider.id === 'local');
    expect(local?.configured).toBe(true);
  });

  test('exposes local endpoint image models discovered from the provider registry', async () => {
    setContext({
      providers: {
        getConfigs: () => ({
          local: { baseUrl: 'http://localhost:9853/v1' },
        }),
        get: (id: string) => {
          if (id === 'local') {
            return {
              listModels: () => [
                { id: 'flux.1-schnell', name: 'FLUX.1 Schnell' },
                { id: 'stable-diffusion-3.5-large', name: 'SD 3.5 Large' },
                { id: 'llama3-8b', name: 'Llama 3 8B' },
              ],
            };
          }
          return undefined;
        },
      },
    } as never);
    try {
      const response = await app.handle(authorizedRequest('/api/images/providers'));
      const payload = (await response.json()) as {
        data: Array<{ id: string; configured: boolean; models: Array<{ id: string }> }>;
      };
      const local = payload.data.find((provider) => provider.id === 'local');
      expect(local?.configured).toBe(true);
      const ids = local?.models.map((model) => model.id) ?? [];
      expect(ids).toContain('flux.1-schnell');
      expect(ids).toContain('stable-diffusion-3.5-large');
      expect(ids).not.toContain('llama3-8b');
    } finally {
      setContext(BASE_PROVIDER_CONTEXT as never);
    }
  });

  test('generates against a local endpoint with a custom image model', async () => {
    const response = await app.handle(
      authorizedRequest('/api/images/generate', {
        prompt: 'A foggy pier',
        provider: 'local',
        model: 'flux.1-schnell',
        size: '1024x1024',
        quality: 'auto',
        outputFormat: 'png',
      }),
    );
    const payload = (await response.json()) as {
      data: { imageBase64: string; provider: string; model: string };
    };
    expect(response.status).toBe(200);
    expect(payload.data).toMatchObject({ provider: 'local', model: 'flux.1-schnell' });
    expect(requestUrl).toBe('http://localhost:9853/v1/images/generations');
    expect(requestBody).toMatchObject({ model: 'flux.1-schnell', size: '1024x1024' });
    expect(requestBody?.quality).toBeUndefined();
  });

  test('generates with the selected OpenAI model, effect, and options', async () => {
    const response = await app.handle(
      authorizedRequest('/api/images/generate', {
        prompt: 'A mountain observatory',
        provider: 'openai',
        model: 'gpt-image-1',
        effect: 'neon',
        size: '1536x1024',
        quality: 'high',
        background: 'transparent',
        outputFormat: 'webp',
      }),
    );
    const payload = (await response.json()) as {
      data: { imageBase64: string; mimeType: string; provider: string; model: string };
    };
    expect(response.status).toBe(200);
    expect(payload.data).toMatchObject({
      imageBase64: 'aW1hZ2U=',
      mimeType: 'image/webp',
      provider: 'openai',
      model: 'gpt-image-1',
    });
    expect(requestBody).toMatchObject({
      model: 'gpt-image-1',
      size: '1536x1024',
      quality: 'high',
      background: 'transparent',
      output_format: 'webp',
    });
    expect(String(requestBody?.prompt)).toContain('Neon glow');
  });

  test('uses the current xAI image model without duplicating the v1 path', async () => {
    setContext({
      providers: {
        getConfigs: () => ({
          xai: { apiKey: 'xai-key', baseUrl: 'https://api.x.ai/v1' },
        }),
      },
    } as never);
    try {
      const response = await app.handle(
        authorizedRequest('/api/images/generate', {
          prompt: 'A moonlit canyon',
          provider: 'xai',
          model: 'grok-imagine-image-2.0',
          size: '1536x1024',
          quality: 'medium',
          outputFormat: 'jpeg',
        }),
      );
      expect(response.status).toBe(200);
      expect(requestUrl).toBe('https://api.x.ai/v1/images/generations');
      expect(requestBody).toMatchObject({
        model: 'grok-imagine-image-2.0',
        aspect_ratio: '3:2',
        quality: 'medium',
        response_format: 'b64_json',
      });
      expect(requestBody?.size).toBeUndefined();
    } finally {
      setContext(BASE_PROVIDER_CONTEXT as never);
    }
  });

  test('uses b64_json response format for DALL·E 3 and drops unsupported options', async () => {
    const response = await app.handle(
      authorizedRequest('/api/images/generate', {
        prompt: 'A lighthouse',
        provider: 'openai',
        model: 'dall-e-3',
        size: '1792x1024',
        quality: 'hd',
        background: 'transparent',
        outputFormat: 'png',
      }),
    );
    expect(response.status).toBe(200);
    expect(requestBody).toMatchObject({
      model: 'dall-e-3',
      size: '1792x1024',
      quality: 'hd',
      response_format: 'b64_json',
    });
    expect(requestBody?.output_format).toBeUndefined();
    expect(requestBody?.background).toBeUndefined();
  });

  test('generates through the Google Gemini adapter', async () => {
    const response = await app.handle(
      authorizedRequest('/api/images/generate', {
        prompt: 'A tide pool',
        provider: 'google',
        model: 'gemini-2.5-flash-image',
        size: '1536x1024',
      }),
    );
    const payload = (await response.json()) as {
      data: { imageBase64: string; mimeType: string; provider: string; model: string };
    };
    expect(response.status).toBe(200);
    expect(payload.data).toMatchObject({
      imageBase64: 'aW1hZ2U=',
      mimeType: 'image/png',
      provider: 'google',
      model: 'gemini-2.5-flash-image',
    });
    expect(requestUrl).toContain('generativelanguage.googleapis.com/v1beta/');
    expect(requestUrl).toContain(':generateContent');
    const generationConfig = requestBody?.generationConfig as Record<string, unknown>;
    expect(generationConfig?.responseModalities).toEqual(['TEXT', 'IMAGE']);
    expect(generationConfig?.imageConfig).toEqual({ aspectRatio: '3:2' });
  });

  test('reports a zero Google image quota with an actionable recovery path', async () => {
    const usageBefore = (await apiUsageTotals()).byKind.image;
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          error: {
            code: 429,
            message:
              'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0. Please retry in 18.5s.',
          },
        },
        { status: 429 },
      ),
    ) as unknown as typeof fetch;
    try {
      const response = await app.handle(
        authorizedRequest('/api/images/generate', {
          prompt: 'A hot dog cat',
          provider: 'google',
          model: 'gemini-2.5-flash-image',
        }),
      );
      const payload = (await response.json()) as { ok: boolean; code?: string; error?: string };
      expect(response.status).toBe(429);
      expect(payload).toMatchObject({ ok: false, code: 'QUOTA_EXCEEDED' });
      expect(payload.error).toContain('Enable billing or select a provider/model');
      expect((await apiUsageTotals()).byKind.image).toBe(usageBefore);
    } finally {
      globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
        requestUrl = String(input instanceof Request ? input.url : input);
        if (init?.body instanceof FormData) {
          requestForm = init.body;
          requestBody = undefined;
        } else {
          requestForm = undefined;
          requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        }
        if (requestUrl.includes(':generateContent')) {
          return Response.json({
            candidates: [
              { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }] } },
            ],
          });
        }
        return Response.json({ data: [{ b64_json: 'aW1hZ2U=' }] });
      }) as unknown as typeof fetch;
    }
  });

  test('blocks a known-cost image at the configured cap before provider fetch', async () => {
    const previousCaps = await getEnforcedCaps();
    const previousFetch = globalThis.fetch;
    const usageBefore = (await apiUsageTotals()).byKind.image;
    let fetchCalls = 0;
    globalThis.fetch = mock(async () => {
      fetchCalls += 1;
      return Response.json({ data: [{ b64_json: 'c2hvdWxkLW5vdC1ydW4=' }] });
    }) as unknown as typeof fetch;
    try {
      await setEnforcedCaps({
        enabled: true,
        action: 'block',
        perRequestCents: 1,
        sessionHourlyCents: 1_000_000,
        sessionDailyCents: 1_000_000,
        globalHourlyCents: 1_000_000,
        globalDailyCents: 1_000_000,
      });
      const response = await app.handle(
        authorizedRequest('/api/images/generate', {
          prompt: 'A request that must be blocked',
          provider: 'openai',
          model: 'gpt-image-1',
          quality: 'medium',
        }),
      );
      expect(response.status).toBe(409);
      expect(fetchCalls).toBe(0);
      expect((await apiUsageTotals()).byKind.image).toBe(usageBefore);
    } finally {
      await setEnforcedCaps(previousCaps);
      globalThis.fetch = previousFetch;
    }
  });

  test('reserves image estimates so concurrent requests cannot race past a global cap', async () => {
    const previousCaps = await getEnforcedCaps();
    const previousFetch = globalThis.fetch;
    const snapshot = await getSpendWindowSnapshot(undefined);
    let fetchCalls = 0;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseProvider!: () => void;
    const providerRelease = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    globalThis.fetch = mock(async () => {
      fetchCalls += 1;
      markStarted();
      await providerRelease;
      return Response.json({ data: [{ b64_json: 'cmVzZXJ2ZWQ=' }] });
    }) as unknown as typeof fetch;
    try {
      await setEnforcedCaps({
        enabled: true,
        action: 'block',
        perRequestCents: 100,
        sessionHourlyCents: 0,
        sessionDailyCents: 0,
        globalHourlyCents: snapshot.globalHourCents + 8,
        globalDailyCents: snapshot.globalDayCents + 8,
      });
      const first = app.handle(
        authorizedRequest('/api/images/generate', {
          prompt: 'First reserved image',
          provider: 'openai',
          model: 'gpt-image-1',
          quality: 'medium',
        }),
      );
      await started;
      const second = await app.handle(
        authorizedRequest('/api/images/generate', {
          prompt: 'Second concurrent image',
          provider: 'openai',
          model: 'gpt-image-1',
          quality: 'medium',
        }),
      );
      expect(second.status).toBe(409);
      expect(fetchCalls).toBe(1);
      releaseProvider();
      expect((await first).status).toBe(200);
    } finally {
      releaseProvider();
      await setEnforcedCaps(previousCaps);
      globalThis.fetch = previousFetch;
    }
  });

  test('keeps Studio generation alive after a client reload and cancels only on an explicit job request', async () => {
    const previousFetch = globalThis.fetch;
    const usageBefore = (await apiUsageTotals()).byKind.image;
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    let releaseProvider!: () => void;
    let providerSignal: AbortSignal | undefined;
    globalThis.fetch = mock(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        providerSignal = init?.signal ?? undefined;
        releaseStarted();
        return new Promise<Response>((resolve, reject) => {
          providerSignal?.addEventListener(
            'abort',
            () =>
              reject(
                providerSignal?.reason ??
                  new DOMException('Image generation cancelled', 'AbortError'),
              ),
            { once: true },
          );
          releaseProvider = () =>
            resolve(Response.json({ data: [{ b64_json: 'aW1hZ2U=', revised_prompt: 'Revised' }] }));
        });
      },
    ) as unknown as typeof fetch;
    try {
      const reloadController = new AbortController();
      const responsePromise = app.handle(
        authorizedRequest(
          '/api/images/generate',
          {
            jobId: 'studio-reload-survives',
            prompt: 'Keep this image',
            provider: 'openai',
            model: 'gpt-image-1',
          },
          reloadController.signal,
        ),
      );
      await started;
      reloadController.abort(new DOMException('Studio reloaded', 'AbortError'));
      expect(providerSignal?.aborted).toBe(false);
      const runningStatus = await app.handle(
        authorizedRequest('/api/images/jobs/studio-reload-survives'),
      );
      expect((await runningStatus.json()).data).toEqual({ status: 'running' });
      releaseProvider();
      const response = await responsePromise;
      expect(response.status).toBe(200);
      const generated = (await response.json()) as { data: { historyId?: string } };
      const completedStatus = await app.handle(
        authorizedRequest('/api/images/jobs/studio-reload-survives'),
      );
      expect((await completedStatus.json()).data).toEqual({
        status: 'completed',
        historyId: generated.data.historyId,
      });
      expect((await apiUsageTotals()).byKind.image).toBe(usageBefore + 1);

      const secondStarted = new Promise<void>((resolve) => {
        releaseStarted = resolve;
      });
      const cancelResponsePromise = app.handle(
        authorizedRequest('/api/images/generate', {
          jobId: 'studio-explicit-cancel',
          prompt: 'Cancel this image',
          provider: 'openai',
          model: 'gpt-image-1',
        }),
      );
      await secondStarted;
      const cancelResponse = await app.handle(
        postRequest('/api/images/jobs/studio-explicit-cancel/cancel'),
      );
      expect(cancelResponse.status).toBe(200);
      expect((await cancelResponse.json()).data).toEqual({ cancelled: true });
      const cancelled = await cancelResponsePromise;
      expect(cancelled.status).toBeGreaterThanOrEqual(400);
      expect(providerSignal?.aborted).toBe(true);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test('falls back to the first configured provider when none is selected', async () => {
    const response = await app.handle(
      authorizedRequest('/api/images/generate', { prompt: 'A harbor' }),
    );
    const payload = (await response.json()) as { data: { provider: string; model: string } };
    expect(response.status).toBe(200);
    expect(payload.data.provider).toBe('openai');
    expect(payload.data.model).toBe('gpt-image-2');
  });

  test('rejects generation for unconfigured providers', async () => {
    const response = await app.handle(
      authorizedRequest('/api/images/generate', {
        prompt: 'A harbor',
        provider: 'xai',
        model: 'grok-2-image-1212',
      }),
    );
    const payload = (await response.json()) as { ok: boolean; error?: string };
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('xAI Grok');
  });

  test('edits a source image through the OpenAI multipart edits endpoint', async () => {
    const response = await app.handle(
      authorizedRequest('/api/images/edit', {
        prompt: 'Make it sunset',
        provider: 'openai',
        model: 'gpt-image-1',
        imageBase64: 'aW1hZ2U=',
        size: '1024x1024',
      }),
    );
    const payload = (await response.json()) as {
      data: { imageBase64: string; provider: string; model: string; historyId?: string };
    };
    expect(response.status).toBe(200);
    expect(payload.data).toMatchObject({
      imageBase64: 'aW1hZ2U=',
      provider: 'openai',
      model: 'gpt-image-1',
    });
    expect(requestUrl).toBe('https://api.openai.com/v1/images/edits');
    expect(requestForm?.get('model')).toBe('gpt-image-1');
    expect(requestForm?.get('size')).toBe('1024x1024');
    expect(String(requestForm?.get('prompt'))).toContain('Make it sunset');
    expect(payload.data.historyId).toBeDefined();
  });

  test('persists generations to history and serves them back', async () => {
    const generateResponse = await app.handle(
      authorizedRequest('/api/images/generate', {
        prompt: 'A glass greenhouse',
        provider: 'openai',
        model: 'gpt-image-1',
      }),
    );
    const generated = (await generateResponse.json()) as { data: { historyId?: string } };
    expect(generated.data.historyId).toBeDefined();

    const listResponse = await app.handle(authorizedRequest('/api/images/history?limit=5'));
    const list = (await listResponse.json()) as {
      data: Array<{ id: string; prompt: string; mode: string }>;
    };
    expect(list.data.length).toBeGreaterThan(0);
    const entry = list.data.find((item) => item.id === generated.data.historyId);
    expect(entry?.prompt).toBe('A glass greenhouse');
    expect(entry?.mode).toBe('generate');

    const detailResponse = await app.handle(
      authorizedRequest(`/api/images/history/${generated.data.historyId}`),
    );
    const detail = (await detailResponse.json()) as { data: { imageBase64: string } };
    expect(detail.data.imageBase64).toBe('aW1hZ2U=');

    const deleteResponse = await app.handle(
      deleteRequest(`/api/images/history/${generated.data.historyId}`),
    );
    expect(deleteResponse.status).toBe(200);
    const missing = await app.handle(
      authorizedRequest(`/api/images/history/${generated.data.historyId}`),
    );
    expect(missing.status).toBeGreaterThanOrEqual(400);
  });

  test('records image usage in the API usage ledger', async () => {
    const before = await app.handle(authorizedRequest('/api/usage?limit=50'));
    const beforePayload = (await before.json()) as {
      data: { totals: { byKind: Record<string, number> } };
    };
    const imagesBefore = beforePayload.data.totals.byKind.image ?? 0;
    const response = await app.handle(
      authorizedRequest('/api/images/generate', {
        prompt: 'A paper crane',
        provider: 'openai',
        model: 'gpt-image-1',
      }),
    );
    expect(response.status).toBe(200);
    const generated = (await response.json()) as {
      data: { usageId: string; runId: string; estimatedCostUsd?: number };
    };
    expect(generated.data).toMatchObject({ estimatedCostUsd: 0.05 });
    expect(
      (await listApiUsage()).find((entry) => entry.id === generated.data.usageId),
    ).toMatchObject({ runId: generated.data.runId, estimatedCostUsd: 0.05 });
    const after = await app.handle(authorizedRequest('/api/usage?limit=50'));
    const afterPayload = (await after.json()) as {
      data: { totals: { byKind: Record<string, number> } };
    };
    expect(afterPayload.data.totals.byKind.image).toBe(imagesBefore + 1);
  });

  test('serves daily usage buckets and CSV export', async () => {
    const dailyResponse = await app.handle(authorizedRequest('/api/usage/daily?days=30'));
    const daily = (await dailyResponse.json()) as {
      ok: boolean;
      data: Array<{ day: string; byKind: Record<string, number> }>;
    };
    expect(dailyResponse.status).toBe(200);
    expect(daily.ok).toBe(true);
    expect(Array.isArray(daily.data)).toBe(true);
    if (daily.data.length > 0) {
      expect(daily.data[0]?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }

    const exportResponse = await app.handle(authorizedRequest('/api/usage/export'));
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get('content-type')).toContain('text/csv');
    expect(exportResponse.headers.get('content-disposition')).toContain('attachment');
    const csv = await exportResponse.text();
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe(
      'id,ts,kind,provider,model,estimated_cost_usd,unit_measure,unit_amount,detail,session_id,run_id',
    );
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });
});
