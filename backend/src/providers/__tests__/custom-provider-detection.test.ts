import { afterEach, describe, expect, test } from 'bun:test';
import { classifyCatalogPayload, detectCustomProviderKind, probeCustomProvider } from '../custom';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const OPENAI_CATALOG = {
  object: 'list',
  data: [
    { id: 'model-a', object: 'model', created: 1700000000, owned_by: 'test' },
    { id: 'model-b', object: 'model' },
  ],
};

const ANTHROPIC_CATALOG = {
  data: [
    {
      type: 'model',
      id: 'claude-test-1',
      display_name: 'Claude Test',
      created_at: '2026-01-01T00:00:00Z',
    },
  ],
  has_more: false,
  first_id: 'claude-test-1',
  last_id: 'claude-test-1',
};

const GEMINI_CATALOG = {
  models: [
    {
      name: 'models/gemini-test-1',
      displayName: 'Gemini Test',
      supportedGenerationMethods: ['generateContent'],
    },
  ],
};

function jsonResponse(payload: unknown, status = 200, url = ''): Response {
  const response = new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  if (url) {
    Object.defineProperty(response, 'url', { value: url });
  }
  return response;
}

/** Route mock fetch by exact URL to a canned response (default 404). */
function mockFetchByUrl(
  routes: Record<string, Response | ((url: string, init?: RequestInit) => Response)>,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push({ url, init });
    const route = routes[url];
    if (typeof route === 'function') return route(url, init);
    if (route) return route;
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return calls;
}

describe('classifyCatalogPayload', () => {
  test('recognizes the OpenAI list envelope', () => {
    expect(classifyCatalogPayload(OPENAI_CATALOG)).toBe('openai');
  });

  test('treats bare id rows as OpenAI-compatible', () => {
    expect(classifyCatalogPayload({ data: [{ id: 'x' }] })).toBe('openai');
  });

  test('recognizes the Anthropic envelope and entry markers', () => {
    expect(classifyCatalogPayload(ANTHROPIC_CATALOG)).toBe('anthropic');
    expect(classifyCatalogPayload({ data: [{ id: 'c', display_name: 'C' }] })).toBe('anthropic');
    expect(
      classifyCatalogPayload({
        data: [{ id: 'c' }],
        has_more: true,
        first_id: 'c',
        last_id: 'c',
      }),
    ).toBe('anthropic');
  });

  test('recognizes the Gemini models shape', () => {
    expect(classifyCatalogPayload(GEMINI_CATALOG)).toBe('gemini');
  });

  test('classifies generic model lists as OpenAI-compatible, never Gemini', () => {
    // Ollama-style name rows without the models/ prefix are not Gemini.
    expect(classifyCatalogPayload({ models: [{ name: 'llama3' }] })).toBe('openai');
    expect(classifyCatalogPayload({ models: [{ id: 'x' }] })).toBe('openai');
    // Bare arrays of ids or rows.
    expect(classifyCatalogPayload(['m-a', 'm-b'])).toBe('openai');
    expect(classifyCatalogPayload([{ id: 'm-a' }, { name: 'm-b' }])).toBe('openai');
    // data rows with only names (no Anthropic markers) fall to OpenAI.
    expect(classifyCatalogPayload({ data: [{ name: 'n' }] })).toBe('openai');
    // Gemini markers stay Gemini.
    expect(classifyCatalogPayload({ models: [{ name: 'models/g' }] })).toBe('gemini');
    expect(
      classifyCatalogPayload({
        models: [{ name: 'g', supportedGenerationMethods: ['generateContent'] }],
      }),
    ).toBe('gemini');
    // Unusable rows still classify to nothing.
    expect(classifyCatalogPayload({ models: [{ nope: 1 }] })).toBeNull();
    expect(classifyCatalogPayload([42, null])).toBeNull();
  });

  test('returns null for empty, missing, or garbage payloads', () => {
    expect(classifyCatalogPayload(null)).toBeNull();
    expect(classifyCatalogPayload('html')).toBeNull();
    expect(classifyCatalogPayload({})).toBeNull();
    expect(classifyCatalogPayload({ data: [] })).toBeNull();
    expect(classifyCatalogPayload({ models: [] })).toBeNull();
    expect(classifyCatalogPayload({ data: [{ nope: 1 }] })).toBeNull();
  });
});

describe('detectCustomProviderKind', () => {
  test('detects an OpenAI-compatible endpoint and keeps its versioned base', async () => {
    const calls = mockFetchByUrl({
      'https://api.example.com/v1/models': jsonResponse(OPENAI_CATALOG),
    });

    const detection = await detectCustomProviderKind({ baseUrl: 'https://api.example.com/v1' });

    expect(detection.kind).toBe('openai');
    expect(detection.models).toEqual(['model-a', 'model-b']);
    expect(detection.normalizedBaseUrl).toBe('https://api.example.com/v1');
    expect(calls.length).toBeLessThanOrEqual(8);
    expect(calls.every((call) => call.init?.method === 'GET')).toBe(true);
  });

  test('detects an Anthropic-native root base via /v1/models and stores the root', async () => {
    const seen: string[] = [];
    mockFetchByUrl({
      'https://anthropic.example/v1/models': (url, init) => {
        seen.push(new Headers(init?.headers).get('x-api-key') ?? '');
        return jsonResponse(ANTHROPIC_CATALOG);
      },
    });

    const detection = await detectCustomProviderKind({
      baseUrl: 'https://anthropic.example',
      apiKey: 'sk-ant-test',
    });

    expect(detection.kind).toBe('anthropic');
    expect(detection.models).toEqual(['claude-test-1']);
    expect(detection.normalizedBaseUrl).toBe('https://anthropic.example');
    expect(seen).toContain('sk-ant-test');
  });

  test('strips a trailing /v1 from an Anthropic base so the SDK appends its own', async () => {
    mockFetchByUrl({
      // {base}/models with the /v1 still on is the real Anthropic catalog path here.
      'https://anthropic.example/v1/models': jsonResponse(ANTHROPIC_CATALOG),
    });

    const detection = await detectCustomProviderKind({
      baseUrl: 'https://anthropic.example/v1',
      apiKey: 'sk-ant-test',
    });

    expect(detection.kind).toBe('anthropic');
    expect(detection.normalizedBaseUrl).toBe('https://anthropic.example');
  });

  test('detects a versioned Gemini base and keeps it for the SDK convention', async () => {
    mockFetchByUrl({
      'https://gemini.example/v1beta/models': jsonResponse(GEMINI_CATALOG),
    });

    const detection = await detectCustomProviderKind({
      baseUrl: 'https://gemini.example/v1beta',
      apiKey: 'gemini-key',
    });

    expect(detection.kind).toBe('gemini');
    expect(detection.models).toEqual(['gemini-test-1']);
    expect(detection.normalizedBaseUrl).toBe('https://gemini.example/v1beta');
  });

  test('appends /v1 to a version-less base whose catalog only answers at /v1/models', async () => {
    mockFetchByUrl({
      'https://host.example/v1/models': jsonResponse(OPENAI_CATALOG),
    });

    const detection = await detectCustomProviderKind({ baseUrl: 'https://host.example' });

    expect(detection.kind).toBe('openai');
    expect(detection.models).toEqual(['model-a', 'model-b']);
    // The OpenAI SDK POSTs {baseURL}/chat/completions, so the stored base
    // must carry the version segment the endpoint actually serves.
    expect(detection.normalizedBaseUrl).toBe('https://host.example/v1');
  });

  test('detects a generic Ollama-style catalog as OpenAI-compatible and extracts ids', async () => {
    mockFetchByUrl({
      'https://gen.example/models': jsonResponse({
        models: [{ name: 'llama3:latest' }, { name: 'qwen2:7b' }],
      }),
    });

    const detection = await detectCustomProviderKind({ baseUrl: 'https://gen.example' });

    expect(detection.kind).toBe('openai');
    expect(detection.models).toEqual(['llama3:latest', 'qwen2:7b']);
    expect(detection.normalizedBaseUrl).toBe('https://gen.example');
  });

  test('prefers OpenAI on multi-protocol gateways that answer both shapes', async () => {
    mockFetchByUrl({
      'https://gateway.example/v1/models': jsonResponse(OPENAI_CATALOG),
      'https://gateway.example/v1/v1/models': jsonResponse(ANTHROPIC_CATALOG),
    });

    const detection = await detectCustomProviderKind({
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'key',
    });

    expect(detection.kind).toBe('openai');
    expect(detection.models).toEqual(['model-a', 'model-b']);
  });

  test('upgrades an http base that redirects to https (token-forge regression)', async () => {
    mockFetchByUrl({
      'http://tokenforge.example/v1/models': jsonResponse(
        { object: 'list', data: [{ id: 'forge-model' }] },
        200,
        'https://tokenforge.example/v1/models',
      ),
    });

    const detection = await detectCustomProviderKind({ baseUrl: 'http://tokenforge.example/v1' });

    expect(detection.kind).toBe('openai');
    expect(detection.models).toEqual(['forge-model']);
    expect(detection.normalizedBaseUrl).toBe('https://tokenforge.example/v1');
  });

  test('reports auth failure when every probe rejects the credentials', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 401 })) as typeof fetch;

    const detection = await detectCustomProviderKind({
      baseUrl: 'https://locked.example/v1',
      apiKey: 'bad-key',
    });

    expect(detection.models).toEqual([]);
    expect(detection.authFailure).toBe(true);
    expect(detection.unreachable).toBe(false);
    expect(detection.status).toBe(401);
  });

  test('reports unreachable when every probe fails before responding', async () => {
    globalThis.fetch = (async () => {
      throw new Error('connect refused');
    }) as typeof fetch;

    const detection = await detectCustomProviderKind({ baseUrl: 'https://down.example/v1' });

    expect(detection.unreachable).toBe(true);
    expect(detection.authFailure).toBe(false);
  });
});

describe('probeCustomProvider without an explicit kind', () => {
  test('detects and returns the wire format end to end', async () => {
    mockFetchByUrl({
      'https://auto.example/v1/models': jsonResponse(OPENAI_CATALOG),
    });

    const result = await probeCustomProvider({
      baseUrl: 'https://auto.example/v1/chat/completions',
      apiKey: 'sk-valid',
    });

    expect(result).toMatchObject({
      success: true,
      normalizedBaseUrl: 'https://auto.example/v1',
      models: ['model-a', 'model-b'],
      detectedKind: 'openai',
      canSaveUnverified: false,
    });
  });

  test('keeps the auth-failure escape hatch closed without leaking the key', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 403 })) as typeof fetch;

    const result = await probeCustomProvider({
      baseUrl: 'https://locked.example/v1',
      apiKey: 'super-secret-key',
    });

    expect(result.success).toBe(false);
    expect(result.detectedKind).toBe('openai');
    expect(result.canSaveUnverified).toBe(false);
    expect(result.error).toContain('HTTP 403');
    expect(result.error).not.toContain('super-secret-key');
  });

  test('allows the manual-model fallback for catalog gaps', async () => {
    globalThis.fetch = (async () => new Response('missing', { status: 404 })) as typeof fetch;

    const result = await probeCustomProvider({ baseUrl: 'https://quiet.example/v1' });

    expect(result).toMatchObject({
      success: false,
      status: 404,
      detectedKind: 'openai',
      canSaveUnverified: true,
    });
  });
});
